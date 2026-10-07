import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import {
  Client,
  type OAuthClientInformationContext,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Stack, databaseAvailable, freePort, startStack } from './harness.js';

const available = await databaseAvailable();

class TestProvider implements OAuthClientProvider {
  creds = new Map<string, OAuthClientInformationMixed>();
  stored?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  lastState?: string;
  authorizationUrl?: URL;
  readonly redirectUrl = 'http://127.0.0.1:8765/callback';
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Switchboard test client',
    redirect_uris: ['http://127.0.0.1:8765/callback'],
    application_type: 'native',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  clientInformation(ctx?: OAuthClientInformationContext) {
    return ctx ? this.creds.get(ctx.issuer) : undefined;
  }
  saveClientInformation(info: OAuthClientInformationMixed, ctx?: OAuthClientInformationContext) {
    if (ctx) this.creds.set(ctx.issuer, info);
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens: OAuthTokens) {
    this.stored = tokens;
  }
  state() {
    this.lastState = randomBytes(8).toString('hex');
    return this.lastState;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error('no verifier');
    return this.verifier;
  }
}

/** Plays the user on the consent page: picks a demo user and approves. Returns the redirect's query. */
async function consent(url: URL, user: string, decision: 'approve' | 'deny' = 'approve'): Promise<URLSearchParams> {
  const page = await (await fetch(url)).text();
  const request = /name="request" value="([^"]+)"/.exec(page)?.[1];
  const signature = /name="signature" value="([^"]+)"/.exec(page)?.[1];
  if (!request || !signature) throw new Error(`consent page without form: ${page.slice(0, 200)}`);
  const response = await fetch(new URL('/oauth/authorize/decision', url), {
    method: 'POST',
    body: new URLSearchParams({ request, signature, user, decision }),
    redirect: 'manual',
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location') ?? '').searchParams;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe.skipIf(!available)('OAuth 2.1 and token handling', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.close();
  });

  const post = (path: string, body: Record<string, string>) =>
    fetch(`${stack.gatewayUrl}${path}`, { method: 'POST', body: new URLSearchParams(body) });
  const mcpPost = (token?: string) =>
    fetch(stack.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
    });

  it('answers a request without a token with 401 and a resource_metadata challenge', async () => {
    const response = await mcpPost();
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain(`resource_metadata="${stack.gatewayUrl}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('publishes protected-resource and authorization-server metadata', async () => {
    const prm = (await (await fetch(`${stack.gatewayUrl}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: stack.mcpUrl, authorization_servers: [stack.gatewayUrl] });
    const as = (await (await fetch(`${stack.gatewayUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: stack.gatewayUrl,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
  });

  it('refuses an expired token', async () => {
    const expired = await stack.token('alice', { ttlSeconds: -30 });
    const response = await mcpPost(expired);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('refuses a token issued for another audience', async () => {
    const adminApiToken = await stack.token('adam', { audience: `${stack.gatewayUrl}/admin/api`, scopes: ['admin'] });
    expect((await mcpPost(adminApiToken)).status).toBe(401);
    const downstream = await stack.token('alice', { audience: stack.serverUrls.crm });
    expect((await mcpPost(downstream)).status).toBe(401);
  });

  it('never accepts a user token at an upstream server (no token passthrough)', async () => {
    const userToken = await stack.token('alice');
    const response = await fetch(stack.serverUrls.crm, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a token whose role no longer matches the user', async () => {
    const token = await stack.token('sam');
    await stack.db.query(`UPDATE core.employees SET role = 'analyst' WHERE id = 'sam'`);
    try {
      expect((await mcpPost(token)).status).toBe(401);
    } finally {
      await stack.db.query(`UPDATE core.employees SET role = 'support' WHERE id = 'sam'`);
    }
  });

  it('answers a call that needs a scope the token lacks with 403 insufficient_scope (step-up)', async () => {
    const token = await stack.token('sam', { scopes: ['crm:read', 'helpdesk:read', 'kb:read'] });
    const client = new Client({ name: 'narrow', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: { token: async () => token } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('helpdesk_add_comment'); // listed: the role may use it after a step-up
    const raw = await fetch(stack.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'helpdesk_add_comment',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'helpdesk_add_comment',
          arguments: { ticket_id: 'T-1001', body: 'x' },
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' } },
        },
      }),
    });
    expect(raw.status).toBe(403);
    expect(raw.headers.get('www-authenticate')).toMatch(/insufficient_scope/);
    expect(raw.headers.get('www-authenticate')).toMatch(/helpdesk:write/);
    await client.close();
  });

  it('runs the full authorization-code flow with PKCE, dynamic registration, consent, iss and refresh rotation', async () => {
    const provider = new TestProvider();
    const transport = new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: provider });
    const client = new Client({ name: 'oauth-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    const url = provider.authorizationUrl;
    expect(url).toBeDefined();
    if (!url) return;
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(stack.mcpUrl);
    const params = await consent(url, 'alice');
    expect(params.get('state')).toBe(provider.lastState);
    expect(params.get('iss')).toBe(stack.gatewayUrl);
    await transport.finishAuth(params);
    const tokens = provider.tokens();
    expect(tokens?.refresh_token).toBeDefined();
    const claims = decodeJwt(tokens?.access_token ?? '');
    expect(claims).toMatchObject({ sub: 'alice', role: 'sales', aud: stack.mcpUrl, iss: stack.gatewayUrl });
    expect(String(claims.scope)).not.toContain('helpdesk:write'); // sales never gets more than the role allows

    const connected = new Client({ name: 'oauth-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await connected.connect(new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: provider }));
    expect((await connected.listTools()).tools.length).toBe(17);
    await connected.close();

    const clientId = (provider.creds.values().next().value as { client_id: string }).client_id;
    const refreshed = (await (await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens?.refresh_token ?? '', client_id: clientId })).json()) as OAuthTokens;
    expect(refreshed.access_token).toBeDefined();
    const reused = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens?.refresh_token ?? '', client_id: clientId });
    expect(reused.status).toBe(400); // rotated: the old refresh token is dead
  });

  it('rejects a wrong PKCE verifier and a reused code', async () => {
    const registration = (await (await fetch(`${stack.gatewayUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'pkce test', redirect_uris: ['http://127.0.0.1:9999/cb'] }),
    })).json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const authorize = new URL(`${stack.gatewayUrl}/oauth/authorize`);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', code_challenge: challenge, code_challenge_method: 'S256', resource: stack.mcpUrl, scope: 'crm:read' }).toString();
    const params = await consent(authorize, 'alice');
    const code = params.get('code') ?? '';
    const bad = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: registration.client_id, redirect_uri: 'http://127.0.0.1:9999/cb' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant');
    const reused = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: registration.client_id, redirect_uri: 'http://127.0.0.1:9999/cb' });
    expect(reused.status).toBe(400); // the failed attempt already consumed the single-use code
  });

  it('requires PKCE S256 and a known resource on the authorization request', async () => {
    const authorize = new URL(`${stack.gatewayUrl}/oauth/authorize`);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: 'switchboard-cli', redirect_uri: 'http://127.0.0.1/callback', code_challenge: 'x', code_challenge_method: 'plain' }).toString();
    const plain = await fetch(authorize, { redirect: 'manual' });
    expect(new URL(plain.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_request');
    const { challenge } = pkce();
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: 'switchboard-cli', redirect_uri: 'http://127.0.0.1/callback', code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://elsewhere.example/mcp' }).toString();
    const wrong = await fetch(authorize, { redirect: 'manual' });
    expect(new URL(wrong.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_target');
  });

  it('refuses dangerous redirect URIs at registration and unregistered ones at authorization', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x']) {
      const response = await fetch(`${stack.gatewayUrl}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri] }) });
      expect(response.status, uri).toBe(400);
    }
    const authorize = new URL(`${stack.gatewayUrl}/oauth/authorize`);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: 'switchboard-cli', redirect_uri: 'https://attacker.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' }).toString();
    const response = await fetch(authorize, { redirect: 'manual' });
    expect(response.status).toBe(400); // an error page, never a redirect to an unregistered URI
  });

  it('accepts a Client ID Metadata Document as client_id', async () => {
    process.env.SWITCHBOARD_CIMD_ALLOW_INSECURE = 'true';
    const port = await freePort();
    const documentUrl = `http://127.0.0.1:${port}/client.json`;
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ client_id: documentUrl, client_name: 'Metadata Document Client', redirect_uris: ['http://127.0.0.1:7777/cb'] }));
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const authorize = new URL(`${stack.gatewayUrl}/oauth/authorize`);
      authorize.search = new URLSearchParams({ response_type: 'code', client_id: documentUrl, redirect_uri: 'http://127.0.0.1:7777/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: stack.mcpUrl }).toString();
      const page = await (await fetch(authorize)).text();
      expect(page).toContain('Metadata Document Client');
    } finally {
      delete process.env.SWITCHBOARD_CIMD_ALLOW_INSECURE;
      server.close();
    }
  });

  it('gives the admin API only to admins, with a token for the admin API audience', async () => {
    const adminToken = await stack.token('adam', { audience: `${stack.gatewayUrl}/admin/api`, scopes: ['admin'] });
    expect((await fetch(`${stack.gatewayUrl}/admin/api/overview`, { headers: { authorization: `Bearer ${adminToken}` } })).status).toBe(200);
    const mcpToken = await stack.token('adam');
    expect((await fetch(`${stack.gatewayUrl}/admin/api/overview`, { headers: { authorization: `Bearer ${mcpToken}` } })).status).toBe(401);
    const salesAdminToken = await stack.token('alice', { audience: `${stack.gatewayUrl}/admin/api`, scopes: ['admin'] });
    expect((await fetch(`${stack.gatewayUrl}/admin/api/overview`, { headers: { authorization: `Bearer ${salesAdminToken}` } })).status).toBe(403);
    const authorize = new URL(`${stack.gatewayUrl}/oauth/authorize`);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: 'switchboard-cli', redirect_uri: 'http://127.0.0.1/callback', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: `${stack.gatewayUrl}/admin/api` }).toString();
    const response = await fetch(authorize, { redirect: 'manual' });
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_target');
  });

  it('records authentication failures in the audit log', async () => {
    const rows = await stack.db.query(`SELECT count(*)::int AS n FROM gateway.audit_log WHERE decision = 'auth_failed'`);
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});
