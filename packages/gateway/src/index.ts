import { serve } from '@hono/node-server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Db, log } from '@switchboard/core';

import { type Gateway, createGateway } from './app.js';
import type { GatewayConfig } from './config.js';
import { buildGatewayServer } from './server.js';
import { accessTokenVerifier } from './tokens.js';

export { createGateway, type Gateway } from './app.js';
export { loadConfig, loadPolicy, repoRoot, type GatewayConfig, type TenantConfig } from './config.js';
export { KeyManager } from './keys.js';
export { issueAccessToken, issueDownstreamToken } from './tokens.js';
export { detectInjection, extractEmails, wrapUntrusted, TaintTracker, UNTRUSTED_PREFACE } from './untrusted.js';
export { matches, grantScopes, roleAccess, type Session } from './policy.js';
export { redirectUriAllowed, redirectMatches } from './clients.js';
export { fakeScripts, loadTaskFile, type PlaygroundTask } from './playground.js';
export { advertisedTool, buildGatewayServer, listedTools, toolAccess, GATEWAY_VERSION } from './server.js';

export interface RunningGateway {
  gateway: Gateway;
  url: string;
  close: () => Promise<void>;
}

export async function serveGateway(options: { db: Db; port: number; host?: string; config?: GatewayConfig }): Promise<RunningGateway> {
  const gateway = await createGateway({ db: options.db, ...(options.config && { config: options.config }) });
  const host = options.host ?? '127.0.0.1';
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: gateway.app.fetch, port: options.port, hostname: host }, () => resolve(started));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  log('gateway', 'listening', { url, public: gateway.deps.config.publicUrl, tenant: gateway.deps.tenantName });
  void gateway.deps.upstreams.refresh(0).catch(() => undefined);
  return {
    gateway,
    url,
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The gateway over stdio, for local clients that launch it as a process. The user is the one named by the
 * access token in SWITCHBOARD_TOKEN (from `switchboard token`), so the same policies apply as over HTTP.
 */
export async function serveGatewayStdio(options: { db: Db; token: string; config?: GatewayConfig }): Promise<void> {
  const gateway = await createGateway({ db: options.db, ...(options.config && { config: options.config }) });
  const verifier = accessTokenVerifier(gateway.keys, gateway.deps.config, gateway.deps.config.mcpResource, options.db);
  const authInfo = await verifier.verifyAccessToken(options.token);
  const session = await gateway.sessionFromAuth(authInfo);
  await gateway.deps.upstreams.refresh(0);
  const handle = serveStdio(async ({ era }) => buildGatewayServer(gateway.deps, session, { era, transport: 'stdio' }));
  process.stderr.write(`[switchboard] gateway on stdio as ${session.userId} (${session.role})\n`);
  process.on('SIGINT', () => void handle.close().then(() => process.exit(0)));
}
