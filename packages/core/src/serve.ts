import { serve, type ServerType } from '@hono/node-server';
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { log } from './log.js';

export type ServerFactory = () => McpServer;

export interface GatewayTokenAuth {
  /** The gateway's issuer URL (the `iss` of downstream tokens). */
  issuer: string;
  /** Where the gateway publishes its signing keys. */
  jwksUrl?: string;
  /** Injected key resolver (tests). */
  keys?: JWTVerifyGetKey;
}

export interface HttpServeOptions {
  name: string;
  factory: ServerFactory;
  port: number;
  host?: string;
  /** This server's own MCP URL as the gateway addresses it: the audience its tokens must carry. */
  resourceUrl: string;
  /** `none` is only accepted on a loopback bind (local development with the MCP Inspector). */
  auth: GatewayTokenAuth | 'none';
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Downstream tokens are minted by the gateway per call: audience = this server, subject = the end user,
 * scope = the user's granted scopes. A user's own token (audience = the gateway) is refused here, so a token
 * can never be replayed past the gateway.
 */
export function gatewayTokenVerifier(auth: GatewayTokenAuth, resourceUrl: string) {
  const keys = auth.keys ?? createRemoteJWKSet(new URL(auth.jwksUrl ?? `${auth.issuer}/oauth/jwks.json`), { cooldownDuration: 5_000 });
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, keys, { issuer: auth.issuer, audience: resourceUrl, algorithms: ['ES256'] });
        if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') throw new Error('missing claims');
        return {
          token,
          clientId: typeof payload.client_id === 'string' ? payload.client_id : 'switchboard-gateway',
          scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
          expiresAt: payload.exp,
          resource: new URL(resourceUrl),
          extra: { sub: payload.sub, role: payload.role, tenant: payload.tenant },
        };
      } catch (error) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, error instanceof Error ? error.message : 'invalid token');
      }
    },
  };
}

export function createServerApp(options: Omit<HttpServeOptions, 'port' | 'host'>): Hono {
  const handler = createMcpHandler(() => options.factory());
  const app = new Hono();
  const resourceUrl = new URL(options.resourceUrl);
  app.get('/healthz', (c) => c.json({ ok: true, server: options.name }));

  if (options.auth === 'none') {
    const allowed = localhostAllowedHostnames();
    app.all('/mcp', async (c) => {
      const rejected = hostHeaderValidationResponse(c.req.raw, allowed);
      if (rejected) return rejected;
      return handler.fetch(c.req.raw);
    });
    return app;
  }

  const issuer = options.auth.issuer;
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const gate = requireBearerAuth({
    verifier: gatewayTokenVerifier(options.auth, options.resourceUrl),
    expectedResource: resourceUrl,
    resourceMetadataUrl,
  });
  app.get(`/.well-known/oauth-protected-resource${resourceUrl.pathname}`, (c) =>
    c.json({ resource: options.resourceUrl, authorization_servers: [issuer], bearer_methods_supported: ['header'] }),
  );
  app.all('/mcp', async (c) => {
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    return handler.fetch(c.req.raw, { authInfo: auth });
  });
  return app;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export async function serveHttp(options: HttpServeOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  if (options.auth === 'none' && !isLoopback(host)) {
    throw new Error(`${options.name}: auth "none" is only allowed on a loopback address, not ${host}`);
  }
  const app = createServerApp(options);
  const server: ServerType = await new Promise((resolve) => {
    const started = serve({ fetch: app.fetch, port: options.port, hostname: host }, () => resolve(started));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/mcp`;
  log(options.name, 'listening', { url, auth: options.auth === 'none' ? 'none' : 'gateway-jwt' });
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function runStdio(name: string, factory: ServerFactory): void {
  const handle = serveStdio(() => factory());
  process.on('SIGINT', () => void handle.close().then(() => process.exit(0)));
  process.stderr.write(`[${name}] serving MCP over stdio\n`);
}
