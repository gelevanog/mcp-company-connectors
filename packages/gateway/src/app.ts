import { randomBytes } from 'node:crypto';

import {
  type AuthInfo,
  createMcpHandler,
  createRequestStateCodec,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { type Db, queryOne } from '@switchboard/core';
import { Hono } from 'hono';

import { adminRoutes } from './admin.js';
import { AuditLog } from './audit.js';
import { ClientStore } from './clients.js';
import { type GatewayConfig, loadConfig } from './config.js';
import type { ConfirmState } from './confirm.js';
import { KeyManager } from './keys.js';
import { oauthRoutes } from './oauth.js';
import { Playground } from './playground.js';
import { Overrides, type Session } from './policy.js';
import { RateLimiter } from './ratelimit.js';
import { type GatewayDeps, buildGatewayServer } from './server.js';
import { accessTokenVerifier } from './tokens.js';
import { TaintTracker } from './untrusted.js';
import { UpstreamRegistry } from './upstreams.js';

export interface Gateway {
  app: Hono;
  deps: GatewayDeps;
  keys: KeyManager;
  clients: ClientStore;
  playground: Playground;
  sessionFromAuth: (authInfo: AuthInfo, headers?: Headers) => Promise<Session>;
  close: () => Promise<void>;
}

export interface CreateGatewayOptions {
  db: Db;
  config?: GatewayConfig;
}

/** Browser origins allowed to call /mcp (the admin console and the MCP Inspector on localhost). */
function allowedOrigins(config: GatewayConfig): Set<string> {
  const extra = (process.env.SWITCHBOARD_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:6274,http://127.0.0.1:6274').split(',').map((o) => o.trim()).filter(Boolean);
  return new Set([new URL(config.publicUrl).origin, ...extra]);
}

export async function createGateway(options: CreateGatewayOptions): Promise<Gateway> {
  const config = options.config ?? loadConfig();
  const db = options.db;
  const tenant = config.tenants[config.defaultTenant];
  if (!tenant) throw new Error(`tenant ${config.defaultTenant} is not in the policy file`);
  const keys = await KeyManager.load(db);
  const clients = new ClientStore(db, config);
  await clients.ensureFirstParty();
  const deps: GatewayDeps = {
    config,
    tenantName: config.defaultTenant,
    tenant,
    db,
    upstreams: new UpstreamRegistry(config.defaultTenant, tenant, keys, config),
    overrides: new Overrides(db),
    audit: new AuditLog(db, keys.secret),
    rateLimiter: new RateLimiter(tenant),
    taint: new TaintTracker(tenant.untrusted.taint_window_minutes),
    stateCodec: createRequestStateCodec<ConfirmState>({ key: keys.secret, ttlSeconds: 600 }),
  };

  const clientNames = new Map<string, { name: string; at: number }>();
  const clientName = async (clientId: string): Promise<string> => {
    const cached = clientNames.get(clientId);
    if (cached && Date.now() - cached.at < 60_000) return cached.name;
    const row = await queryOne<{ client_name: string }>(db, 'SELECT client_name FROM gateway.oauth_clients WHERE client_id = $1', [clientId]);
    const name = row?.client_name ?? clientId;
    clientNames.set(clientId, { name, at: Date.now() });
    return name;
  };

  const sessionFromAuth = async (authInfo: AuthInfo, headers?: Headers): Promise<Session> => {
    const extra = authInfo.extra ?? {};
    return {
      tenant: typeof extra.tenant === 'string' ? extra.tenant : config.defaultTenant,
      userId: String(extra.sub),
      userName: typeof extra.name === 'string' ? extra.name : String(extra.sub),
      role: String(extra.role),
      scopes: authInfo.scopes,
      clientId: authInfo.clientId,
      clientName: await clientName(authInfo.clientId),
      exposeAll: config.evalMode && headers?.get('x-switchboard-expose') === 'all',
    };
  };

  const mcpResource = new URL(config.mcpResource);
  const gate = requireBearerAuth({
    verifier: accessTokenVerifier(keys, config, config.mcpResource, db),
    expectedResource: mcpResource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResource),
  });

  const handler = createMcpHandler(async ({ era, authInfo, requestInfo }) => {
    if (!authInfo) throw new Error('unauthenticated request reached the MCP handler');
    const session = await sessionFromAuth(authInfo, requestInfo?.headers);
    return buildGatewayServer(deps, session, { era, transport: 'http' });
  });

  const playground = new Playground(deps, keys, config);
  const app = new Hono();
  const origins = allowedOrigins(config);

  app.get('/healthz', async (c) => {
    await deps.upstreams.refresh().catch(() => undefined);
    const status = deps.upstreams.current.status;
    return c.json({ ok: true, upstreams: status });
  });
  app.get('/favicon.ico', (c) =>
    c.body(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="#101820"/><g fill="#0f9f8e"><circle cx="10" cy="11" r="2.6"/><circle cx="22" cy="11" r="2.6"/><circle cx="10" cy="21" r="2.6"/><circle cx="22" cy="21" r="2.6"/></g></svg>',
      200,
      { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
    ),
  );
  app.get('/', (c) =>
    c.json({
      name: 'Switchboard MCP gateway',
      mcp: config.mcpResource,
      authorization_server: `${config.issuer}/.well-known/oauth-authorization-server`,
      protected_resource: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
      docs: 'https://github.com/gelevanog/mcp-company-connectors',
    }),
  );
  app.route('/', oauthRoutes({ db, config, keys, clients }));

  app.all('/mcp', async (c) => {
    const origin = c.req.header('origin');
    if (origin && !origins.has(origin)) return c.json({ error: 'origin not allowed' }, 403);
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) {
      const challenge = auth.headers.get('www-authenticate') ?? '';
      const error = /error="([^"]+)"/.exec(challenge)?.[1];
      if (error) {
        await deps.audit.write({ tenant: config.defaultTenant, method: 'auth', decision: 'auth_failed', reason: `${auth.status} ${error}: ${/error_description="([^"]+)"/.exec(challenge)?.[1] ?? ''}`.trim(), requestId: randomBytes(4).toString('hex') });
      }
      return auth;
    }
    return handler.fetch(c.req.raw, { authInfo: auth });
  });

  app.route('/admin/api', adminRoutes({ deps, keys, config, clients, playground, db }));

  return {
    app,
    deps,
    keys,
    clients,
    playground,
    sessionFromAuth,
    close: async () => {
      await handler.close();
    },
  };
}
