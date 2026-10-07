import { createServer } from 'node:net';

import { type Db, type RunningServer, createPool, seedDemo, setupAnalyticsRole } from '@switchboard/core';
import { type RunningGateway, issueAccessToken, loadConfig, loadPolicy, serveGateway } from '@switchboard/gateway';

import { SERVER_NAMES, type ServerName, startHttpServer } from '../src/servers.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://switchboard:switchboard@127.0.0.1:55480/switchboard_test';

let reachable: boolean | undefined;
export async function databaseAvailable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const db = createPool(TEST_DATABASE_URL, 1);
  try {
    await db.query('SELECT 1');
    reachable = true;
  } catch {
    if (process.env.REQUIRE_TEST_DB === '1') throw new Error(`REQUIRE_TEST_DB=1 but ${TEST_DATABASE_URL} is not reachable`);
    reachable = false;
  } finally {
    await db.end();
  }
  return reachable;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface StackOptions {
  pageSize?: number;
  evalMode?: boolean;
  callsPerMinute?: number;
  writesPerMinute?: number;
}

export interface Stack {
  db: Db;
  gatewayUrl: string;
  mcpUrl: string;
  serverUrls: Record<ServerName, string>;
  gateway: RunningGateway;
  token: (user: string, options?: { scopes?: string[]; audience?: string; ttlSeconds?: number; clientId?: string; role?: string }) => Promise<string>;
  reseed: () => Promise<void>;
  close: () => Promise<void>;
}

/** The five servers and the gateway on free ports, against the test database, all in this process. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const db = createPool(TEST_DATABASE_URL, 20);
  await seedDemo(db);
  await setupAnalyticsRole(db, 'switchboard_analytics', 'switchboard_analytics');
  await db.query('TRUNCATE gateway.audit_log, gateway.tool_overrides, gateway.grants, gateway.auth_codes');
  await db.query(`DELETE FROM gateway.oauth_clients WHERE kind <> 'first_party'`);

  const gatewayPort = await freePort();
  const publicUrl = `http://127.0.0.1:${gatewayPort}`;
  const servers: RunningServer[] = [];
  const serverUrls = {} as Record<ServerName, string>;
  for (const name of SERVER_NAMES) {
    const port = await freePort();
    const running = await startHttpServer(name, db, { port, host: '127.0.0.1', gatewayIssuer: publicUrl });
    servers.push(running);
    serverUrls[name] = running.url;
  }
  const tenants = loadPolicy();
  const tenant = tenants.kestrel;
  if (!tenant) throw new Error('kestrel tenant missing');
  for (const name of SERVER_NAMES) {
    const upstream = tenant.upstreams[name];
    if (upstream) upstream.url = serverUrls[name];
  }
  if (options.callsPerMinute !== undefined) tenant.rate_limits.default.calls_per_minute = options.callsPerMinute;
  if (options.writesPerMinute !== undefined) tenant.rate_limits.default.writes_per_minute = options.writesPerMinute;
  const config = loadConfig({ publicUrl, tenants, listPageSize: options.pageSize ?? 20, evalMode: options.evalMode ?? false, adminRedirectUris: ['http://127.0.0.1:3999/auth/callback'] });
  const gateway = await serveGateway({ db, port: gatewayPort, host: '127.0.0.1', config });
  await gateway.gateway.deps.upstreams.refresh(0);

  const token: Stack['token'] = async (user, tokenOptions = {}) => {
    const row = (await db.query('SELECT role, name FROM core.employees WHERE id = $1', [user])).rows[0] as { role: string; name: string };
    const role = tokenOptions.role ?? row.role;
    const roleScopes = tenant.roles[role]?.scopes ?? [];
    const scopes = tokenOptions.scopes ?? (roleScopes.includes('*') ? ['crm:read', 'crm:deals', 'crm:write', 'helpdesk:read', 'helpdesk:write', 'analytics:query', 'kb:read', 'calendar:read', 'calendar:write', 'email:draft', 'email:send'] : roleScopes);
    return issueAccessToken(
      gateway.gateway.keys,
      config,
      { sub: user, role, tenant: 'kestrel', scope: scopes.join(' '), client_id: tokenOptions.clientId ?? 'test-client', name: row.name },
      tokenOptions.audience ?? config.mcpResource,
      tokenOptions.ttlSeconds ?? 600,
    );
  };

  return {
    db,
    gatewayUrl: publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    serverUrls,
    gateway,
    token,
    reseed: async () => {
      await seedDemo(db);
      gateway.gateway.deps.taint.clear();
      gateway.gateway.deps.rateLimiter.reset();
    },
    close: async () => {
      await gateway.close();
      for (const server of servers) await server.close();
      await db.end();
    },
  };
}
