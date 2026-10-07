import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { type Db, queryOne, sha256 } from '@switchboard/core';

import type { GatewayConfig } from './config.js';
import { randomToken } from './keys.js';

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  kind: 'dcr' | 'cimd' | 'first_party';
  application_type: string | null;
  metadata: Record<string, unknown>;
}

export class OAuthClientError extends Error {
  constructor(readonly error: string, message: string) {
    super(message);
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

/**
 * Which redirect URIs a dynamically registered client may use: loopback http (any port, RFC 8252), https
 * (when allowed), or a private-use scheme for native apps such as cursor:// or vscode://.
 */
export function redirectUriAllowed(raw: string, config: Pick<GatewayConfig, 'allowHttpsRedirects'>): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (isLoopbackUrl(url)) return true;
  if (url.protocol === 'https:') return config.allowHttpsRedirects;
  const scheme = url.protocol.slice(0, -1);
  if (['http', 'javascript', 'data', 'file', 'vbscript', 'blob', 'about'].includes(scheme)) return false;
  return /^[a-z][a-z0-9+.-]{1,40}$/.test(scheme);
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 section 7.3). */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackUrl(asked)) return false;
  return registered.some((candidate) => {
    try {
      const reg = new URL(candidate);
      return isLoopbackUrl(reg) && reg.hostname === asked.hostname && reg.pathname === asked.pathname && reg.search === asked.search;
    } catch {
      return false;
    }
  });
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:');
}

export class ClientStore {
  constructor(private readonly db: Db, private readonly config: GatewayConfig) {}

  /** The admin console and the playground are first-party clients registered at start. */
  async ensureFirstParty(): Promise<void> {
    const clients: [string, string, string[]][] = [
      ['switchboard-admin', 'Switchboard admin console', this.config.adminRedirectUris],
      ['switchboard-playground', 'Switchboard playground', []],
      ['switchboard-cli', 'Switchboard CLI', ['http://127.0.0.1/callback']],
    ];
    for (const [id, name, uris] of clients) {
      await this.db.query(
        `INSERT INTO gateway.oauth_clients (client_id, client_name, redirect_uris, kind, application_type) VALUES ($1, $2, $3, 'first_party', 'web')
         ON CONFLICT (client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris, client_name = EXCLUDED.client_name`,
        [id, name, uris],
      );
    }
  }

  async get(clientId: string): Promise<OAuthClient | undefined> {
    const row = await queryOne<OAuthClient & { created_at: string }>(
      this.db,
      'SELECT client_id, client_name, redirect_uris, kind, application_type, metadata, created_at FROM gateway.oauth_clients WHERE client_id = $1',
      [clientId],
    );
    if (row && row.kind === 'cimd' && Date.now() - Date.parse(row.created_at) > 3_600_000) {
      return this.fetchMetadataDocument(clientId);
    }
    if (row) return row;
    if (this.config.cimdEnabled && clientId.startsWith('https://')) return this.fetchMetadataDocument(clientId);
    if (this.config.cimdEnabled && clientId.startsWith('http://') && process.env.SWITCHBOARD_CIMD_ALLOW_INSECURE === 'true') {
      return this.fetchMetadataDocument(clientId);
    }
    return undefined;
  }

  async touch(clientId: string): Promise<void> {
    await this.db.query('UPDATE gateway.oauth_clients SET last_used_at = now() WHERE client_id = $1', [clientId]);
  }

  /** RFC 7591 dynamic client registration (deprecated by the 2026-07-28 spec in favour of CIMD, kept for compatibility). */
  async register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
    if (redirectUris.length === 0 || redirectUris.length > 10) throw new OAuthClientError('invalid_redirect_uri', 'give between one and ten redirect_uris');
    for (const uri of redirectUris) {
      if (!redirectUriAllowed(uri, this.config)) throw new OAuthClientError('invalid_redirect_uri', `redirect URI not allowed: ${uri}`);
    }
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : 'Unnamed MCP client';
    const authMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(authMethod)) {
      throw new OAuthClientError('invalid_client_metadata', `unsupported token_endpoint_auth_method ${authMethod}`);
    }
    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
    if (!grantTypes.every((grant) => grant === 'authorization_code' || grant === 'refresh_token')) {
      throw new OAuthClientError('invalid_client_metadata', 'only authorization_code and refresh_token grants are supported');
    }
    const applicationType = body.application_type === 'web' || body.application_type === 'native' ? body.application_type : null;
    const clientId = `sbc_${randomToken(12)}`;
    const secret = authMethod === 'none' ? undefined : randomToken(32);
    const metadata = {
      token_endpoint_auth_method: authMethod,
      grant_types: grantTypes,
      ...(secret && { client_secret_hash: sha256(secret) }),
      ...(typeof body.client_uri === 'string' && { client_uri: body.client_uri }),
      ...(typeof body.software_id === 'string' && { software_id: body.software_id }),
    };
    await this.db.query(
      `INSERT INTO gateway.oauth_clients (client_id, client_name, redirect_uris, kind, application_type, metadata) VALUES ($1, $2, $3, 'dcr', $4, $5)`,
      [clientId, name, redirectUris, applicationType, metadata],
    );
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      ...(applicationType && { application_type: applicationType }),
      ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
    };
  }

  /** Client ID Metadata Documents: the client_id is an HTTPS URL that serves the client's metadata. */
  private async fetchMetadataDocument(clientId: string): Promise<OAuthClient | undefined> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return undefined;
    }
    const insecureAllowed = process.env.SWITCHBOARD_CIMD_ALLOW_INSECURE === 'true';
    if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) return undefined;
    if (url.hash || url.username || url.password || url.pathname === '/') return undefined;
    if (!insecureAllowed) {
      const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
      if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) return undefined;
    }
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } });
      if (!response.ok) return undefined;
      const text = await response.text();
      if (text.length > 10_000) return undefined;
      const document = JSON.parse(text) as Record<string, unknown>;
      if (document.client_id !== clientId) return undefined;
      const redirectUris = Array.isArray(document.redirect_uris) ? document.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
      if (redirectUris.length === 0 || !redirectUris.every((uri) => redirectUriAllowed(uri, { allowHttpsRedirects: true }))) return undefined;
      const client: OAuthClient = {
        client_id: clientId,
        client_name: typeof document.client_name === 'string' ? document.client_name.slice(0, 100) : url.hostname,
        redirect_uris: redirectUris,
        kind: 'cimd',
        application_type: typeof document.application_type === 'string' ? document.application_type : null,
        metadata: { token_endpoint_auth_method: 'none', client_uri: document.client_uri ?? null },
      };
      await this.db.query(
        `INSERT INTO gateway.oauth_clients (client_id, client_name, redirect_uris, kind, application_type, metadata) VALUES ($1, $2, $3, 'cimd', $4, $5)
         ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris, metadata = EXCLUDED.metadata, created_at = now()`,
        [client.client_id, client.client_name, client.redirect_uris, client.application_type, client.metadata],
      );
      return client;
    } catch {
      return undefined;
    }
  }

  /** Public clients authenticate with nothing; confidential DCR clients with their secret. */
  authenticate(client: OAuthClient, secret: string | undefined): boolean {
    const method = client.metadata.token_endpoint_auth_method;
    if (method === 'client_secret_post' || method === 'client_secret_basic') {
      return typeof secret === 'string' && sha256(secret) === client.metadata.client_secret_hash;
    }
    return true;
  }
}
