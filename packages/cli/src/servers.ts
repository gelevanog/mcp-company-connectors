import type { McpServer } from '@modelcontextprotocol/server';
import { type Actor, type Db, type RunningServer, runStdio, serveHttp, stdioActor } from '@switchboard/core';
import { createAnalyticsServer, createReaderPool } from '@switchboard/server-analytics';
import { createCrmServer } from '@switchboard/server-crm';
import { createHelpdeskServer } from '@switchboard/server-helpdesk';
import { createKbServer } from '@switchboard/server-kb';
import { createWorkspaceServer } from '@switchboard/server-workspace';

export const SERVER_NAMES = ['crm', 'helpdesk', 'analytics', 'kb', 'workspace'] as const;
export type ServerName = (typeof SERVER_NAMES)[number];
export const DEFAULT_PORTS: Record<ServerName, number> = { crm: 7101, helpdesk: 7102, analytics: 7103, kb: 7104, workspace: 7105 };

let reader: Db | undefined;

export function serverFactory(name: ServerName, db: Db, fallbackActor?: Actor): () => McpServer {
  switch (name) {
    case 'crm':
      return () => createCrmServer({ db, ...(fallbackActor && { fallbackActor }) });
    case 'helpdesk':
      return () => createHelpdeskServer({ db, ...(fallbackActor && { fallbackActor }) });
    case 'analytics':
      reader ??= createReaderPool();
      return () => createAnalyticsServer({ db, readerDb: reader as Db, ...(fallbackActor && { fallbackActor }) });
    case 'kb':
      return () => createKbServer({ db, ...(fallbackActor && { fallbackActor }) });
    case 'workspace':
      return () => createWorkspaceServer({ db, ...(fallbackActor && { fallbackActor }) });
  }
}

export interface HttpServerOptions {
  port?: number;
  host?: string;
  auth?: 'gateway' | 'none';
  resourceUrl?: string;
  gatewayIssuer?: string;
  gatewayJwksUrl?: string;
}

export async function startHttpServer(name: ServerName, db: Db, options: HttpServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORTS[name];
  const host = options.host ?? '127.0.0.1';
  const issuer = options.gatewayIssuer ?? process.env.SWITCHBOARD_PUBLIC_URL ?? 'http://localhost:8080';
  const resourceUrl = options.resourceUrl ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/mcp`;
  const auth = options.auth ?? 'gateway';
  return serveHttp({
    name,
    factory: serverFactory(name, db, auth === 'none' ? { ...stdioActor(), via: 'test' } : undefined),
    port,
    host,
    resourceUrl,
    auth: auth === 'none' ? 'none' : { issuer, ...(options.gatewayJwksUrl && { jwksUrl: options.gatewayJwksUrl }) },
  });
}

export function startStdioServer(name: ServerName, db: Db): void {
  runStdio(name, serverFactory(name, db, stdioActor()));
}
