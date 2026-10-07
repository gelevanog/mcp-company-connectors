import { createHash, timingSafeEqual } from 'node:crypto';

import { ALL_SCOPES, type Db, SCOPES, hmac, queryOne, queryRows, sha256 } from '@switchboard/core';
import type { Context } from 'hono';
import { Hono } from 'hono';

import { type ClientStore, OAuthClientError, redirectMatches } from './clients.js';
import type { GatewayConfig } from './config.js';
import { type KeyManager, randomToken } from './keys.js';
import { consentPage, errorPage } from './pages.js';
import { grantScopes, roleScopes } from './policy.js';
import { issueAccessToken } from './tokens.js';

export interface OAuthDeps {
  db: Db;
  config: GatewayConfig;
  keys: KeyManager;
  clients: ClientStore;
}

interface AuthorizationRequest {
  client_id: string;
  redirect_uri: string;
  scope: string[];
  state: string | null;
  code_challenge: string;
  resource: string;
  exp: number;
}

const MCP_SCOPES = ALL_SCOPES.filter((scope) => scope !== 'admin');

function oauthError(c: Context, status: 400 | 401, error: string, description: string): Response {
  return c.json({ error, error_description: description }, status, { 'cache-control': 'no-store' });
}

export function authorizationServerMetadata(config: GatewayConfig): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    revocation_endpoint: `${config.issuer}/oauth/revoke`,
    jwks_uri: `${config.issuer}/oauth/jwks.json`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ALL_SCOPES,
    client_id_metadata_document_supported: config.cimdEnabled,
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/gelevanog/mcp-company-connectors#readme',
  };
}

export function protectedResourceMetadata(config: GatewayConfig, resource: 'mcp' | 'admin'): Record<string, unknown> {
  return {
    resource: resource === 'mcp' ? config.mcpResource : config.adminResource,
    authorization_servers: [config.issuer],
    scopes_supported: resource === 'mcp' ? MCP_SCOPES : ['admin'],
    bearer_methods_supported: ['header'],
    resource_name: resource === 'mcp' ? 'Switchboard MCP gateway' : 'Switchboard admin API',
    resource_documentation: 'https://github.com/gelevanog/mcp-company-connectors#readme',
  };
}

export function oauthRoutes(deps: OAuthDeps): Hono {
  const { db, config, keys, clients } = deps;
  const app = new Hono();
  const sign = (payload: string) => hmac(keys.secret, `authorize:${payload}`);

  app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(config)));
  app.get('/.well-known/openid-configuration', (c) => c.json(authorizationServerMetadata(config)));
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(config, 'mcp')));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata(config, 'mcp')));
  app.get('/.well-known/oauth-protected-resource/admin/api', (c) => c.json(protectedResourceMetadata(config, 'admin')));
  app.get('/oauth/jwks.json', (c) => c.json(keys.jwks(), 200, { 'cache-control': 'public, max-age=300' }));

  app.post('/oauth/register', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return oauthError(c, 400, 'invalid_client_metadata', 'body must be JSON');
    }
    try {
      return c.json(await clients.register(body), 201, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof OAuthClientError) return oauthError(c, 400, error.error, error.message);
      throw error;
    }
  });

  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    const client = q.client_id ? await clients.get(q.client_id) : undefined;
    if (!client) return c.html(errorPage('Unknown application', 'The client_id is not registered with Switchboard.'), 400);
    const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) {
      return c.html(errorPage('Invalid redirect', 'The redirect_uri does not match the application\'s registration.'), 400);
    }
    const redirectWithError = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (q.state) url.searchParams.set('state', q.state);
      url.searchParams.set('iss', config.issuer);
      return c.redirect(url.toString(), 302);
    };
    if (q.response_type !== 'code') return redirectWithError('unsupported_response_type', 'only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return redirectWithError('invalid_request', 'PKCE with S256 is required');
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return redirectWithError('invalid_request', 'malformed code_challenge');
    const resource = (q.resource ?? config.mcpResource).replace(/\/$/, '');
    if (resource !== config.mcpResource && resource !== config.adminResource) {
      return redirectWithError('invalid_target', `unknown resource; use ${config.mcpResource}`);
    }
    if (resource === config.adminResource && client.client_id !== 'switchboard-admin') {
      return redirectWithError('invalid_target', 'only the admin console may request the admin API');
    }
    const requested = (q.scope ?? '').split(' ').filter((scope) => scope in SCOPES);
    const request: AuthorizationRequest = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: requested,
      state: q.state ?? null,
      code_challenge: q.code_challenge,
      resource,
      exp: Date.now() + 10 * 60_000,
    };
    const encoded = Buffer.from(JSON.stringify(request)).toString('base64url');
    const users = await queryRows<{ id: string; name: string; role: string; title: string }>(
      db,
      `SELECT id, name, role, title FROM core.employees WHERE can_sign_in ${resource === config.adminResource ? "AND role = 'admin'" : ''}
       ORDER BY array_position(ARRAY['sales','support','analyst','admin'], role), name`,
    );
    return c.html(
      consentPage({
        clientName: client.client_name,
        clientId: client.client_id,
        clientKind: client.kind,
        redirectHost: new URL(redirectUri).host || redirectUri,
        resource,
        scopes: requested,
        users,
        request: encoded,
        signature: sign(encoded),
        demoLogin: config.demoLogin,
      }),
    );
  });

  app.post('/oauth/authorize/decision', async (c) => {
    const form = await c.req.parseBody();
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const encoded = text(form.request);
    const signature = text(form.signature);
    const expected = sign(encoded);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return c.html(errorPage('Invalid request', 'The sign-in form was modified or is too old. Start again from your application.'), 400);
    }
    const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AuthorizationRequest;
    if (request.exp < Date.now()) return c.html(errorPage('Expired', 'The sign-in request expired. Start again from your application.'), 400);
    const url = new URL(request.redirect_uri);
    if (request.state) url.searchParams.set('state', request.state);
    url.searchParams.set('iss', config.issuer);
    if (form.decision !== 'approve' || !config.demoLogin) {
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'the user denied access');
      return c.redirect(url.toString(), 302);
    }
    const user = await queryOne<{ id: string; role: string }>(db, 'SELECT id, role FROM core.employees WHERE id = $1 AND can_sign_in', [text(form.user)]);
    if (!user) return c.html(errorPage('Unknown user', 'Pick one of the listed users.'), 400);
    const tenant = config.tenants[config.defaultTenant];
    if (!tenant) throw new Error('tenant not configured');
    const known = request.resource === config.adminResource ? ['admin'] : MCP_SCOPES;
    const scopes = grantScopes(request.scope, roleScopes(tenant, user.role), known);
    if (request.resource === config.adminResource && !scopes.includes('admin')) {
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'the admin console requires the admin role');
      return c.redirect(url.toString(), 302);
    }
    const code = randomToken(32);
    await db.query(
      `INSERT INTO gateway.auth_codes (code_hash, client_id, user_id, redirect_uri, scope, resource, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '2 minutes')`,
      [sha256(code), request.client_id, user.id, request.redirect_uri, scopes.join(' '), request.resource, request.code_challenge],
    );
    url.searchParams.set('code', code);
    return c.redirect(url.toString(), 302);
  });

  app.post('/oauth/token', async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? (form[name]) : undefined);
    let clientId = field('client_id');
    let secret = field('client_secret');
    const basic = c.req.header('authorization');
    if (basic?.startsWith('Basic ')) {
      const [id, pass] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      secret = decodeURIComponent(pass ?? '');
    }
    const client = clientId ? await clients.get(clientId) : undefined;
    if (!client || !clients.authenticate(client, secret)) return oauthError(c, 401, 'invalid_client', 'unknown client or bad credentials');
    await clients.touch(client.client_id);
    const grantType = field('grant_type');

    const issue = async (userId: string, scope: string, resource: string, grantId: string | null) => {
      const user = await queryOne<{ id: string; role: string; name: string; can_sign_in: boolean }>(db, 'SELECT id, role, name, can_sign_in FROM core.employees WHERE id = $1', [userId]);
      if (!user?.can_sign_in) return oauthError(c, 400, 'invalid_grant', 'user can no longer sign in');
      const tenant = config.tenants[config.defaultTenant];
      if (!tenant) throw new Error('tenant not configured');
      const known = resource === config.adminResource ? ['admin'] : MCP_SCOPES;
      const scopes = grantScopes(scope.split(' ').filter(Boolean), roleScopes(tenant, user.role), known);
      const accessToken = await issueAccessToken(
        keys,
        config,
        { sub: user.id, role: user.role, tenant: config.defaultTenant, scope: scopes.join(' '), client_id: client.client_id, name: user.name },
        resource,
      );
      const refresh = randomToken(32);
      if (grantId) {
        await db.query('UPDATE gateway.grants SET refresh_hash = $2, last_used_at = now(), scope = $3 WHERE id = $1', [grantId, sha256(refresh), scopes.join(' ')]);
      } else {
        await db.query(
          `INSERT INTO gateway.grants (id, refresh_hash, client_id, user_id, scope, resource, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)`,
          [`g_${randomToken(9)}`, sha256(refresh), client.client_id, user.id, scopes.join(' '), resource, String(config.refreshTokenTtlDays)],
        );
      }
      return c.json(
        { access_token: accessToken, token_type: 'Bearer', expires_in: config.accessTokenTtlSeconds, refresh_token: refresh, scope: scopes.join(' ') },
        200,
        { 'cache-control': 'no-store', pragma: 'no-cache' },
      );
    };

    if (grantType === 'authorization_code') {
      const code = field('code');
      const verifier = field('code_verifier');
      if (!code || !verifier) return oauthError(c, 400, 'invalid_request', 'code and code_verifier are required');
      // Single use: the UPDATE only matches an unused code.
      const row = await queryOne<{ client_id: string; user_id: string; redirect_uri: string; scope: string; resource: string; code_challenge: string; expired: boolean }>(
        db,
        'UPDATE gateway.auth_codes SET used = true WHERE code_hash = $1 AND NOT used RETURNING client_id, user_id, redirect_uri, scope, resource, code_challenge, expires_at < now() AS expired',
        [sha256(code)],
      );
      if (!row || row.expired) return oauthError(c, 400, 'invalid_grant', 'authorization code is invalid, expired or already used');
      if (row.client_id !== client.client_id) return oauthError(c, 400, 'invalid_grant', 'code was issued to another client');
      const redirect = field('redirect_uri');
      if (redirect !== undefined && redirect !== row.redirect_uri) return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== row.code_challenge) return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed');
      const resource = field('resource')?.replace(/\/$/, '');
      if (resource !== undefined && resource !== row.resource) return oauthError(c, 400, 'invalid_target', 'resource does not match the authorization request');
      return issue(row.user_id, row.scope, row.resource, null);
    }

    if (grantType === 'refresh_token') {
      const refresh = field('refresh_token');
      if (!refresh) return oauthError(c, 400, 'invalid_request', 'refresh_token is required');
      const grant = await queryOne<{ id: string; client_id: string; user_id: string; scope: string; resource: string }>(
        db,
        'SELECT id, client_id, user_id, scope, resource FROM gateway.grants WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()',
        [sha256(refresh)],
      );
      if (!grant || grant.client_id !== client.client_id) return oauthError(c, 400, 'invalid_grant', 'refresh token is invalid, revoked or expired');
      const resource = field('resource')?.replace(/\/$/, '');
      if (resource !== undefined && resource !== grant.resource) return oauthError(c, 400, 'invalid_target', 'resource does not match the grant');
      const requested = field('scope');
      const scope = requested ? requested.split(' ').filter((s) => grant.scope.split(' ').includes(s)).join(' ') : grant.scope;
      return issue(grant.user_id, scope, grant.resource, grant.id);
    }

    return oauthError(c, 400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  });

  app.post('/oauth/revoke', async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.token === 'string' ? form.token : '';
    await db.query('UPDATE gateway.grants SET revoked_at = now() WHERE refresh_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
    return c.body(null, 200);
  });

  return app;
}
