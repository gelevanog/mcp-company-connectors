#!/usr/bin/env node
import { ALL_SCOPES, createPool, databaseUrl, isSeeded, seedDemo, setupAnalyticsRole } from '@switchboard/core';
import { KeyManager, issueAccessToken, loadConfig, serveGateway, serveGatewayStdio } from '@switchboard/gateway';
import { Command, Option } from 'commander';

import { registerEvalCommands } from './eval/commands.js';
import { DEFAULT_PORTS, SERVER_NAMES, type ServerName, startHttpServer, startStdioServer } from './servers.js';

const program = new Command();
program.name('switchboard').description('Secure MCP servers and a gateway for company systems').version('0.1.0');

async function seedIfEmpty(force: boolean): Promise<void> {
  const db = createPool();
  try {
    if (force || !(await isSeeded(db))) {
      const summary = await seedDemo(db);
      console.error(`[seed] demo data written: ${JSON.stringify(summary)}`);
    }
    await setupAnalyticsRole(db, process.env.ANALYTICS_DB_ROLE ?? 'switchboard_analytics', process.env.ANALYTICS_DB_PASSWORD ?? 'switchboard_analytics');
  } finally {
    await db.end();
  }
}

program
  .command('seed')
  .description('Create the schema, (re)write the Kestrel Cloud demo data and the read-only analytics role')
  .option('--if-empty', 'only seed when the database has no demo data (docker first start)')
  .action(async (opts: { ifEmpty?: boolean }) => {
    await seedIfEmpty(!opts.ifEmpty);
    console.log(`seeded ${databaseUrl().replace(/:[^:@/]+@/, ':***@')}`);
  });

program
  .command('serve')
  .description('Run one MCP server (crm, helpdesk, analytics, kb, workspace) or all five over HTTP, or one over stdio')
  .argument('<server>', `${SERVER_NAMES.join(' | ')} | all`)
  .option('--stdio', 'serve over stdio (one local user, every scope: SWITCHBOARD_ACTOR)')
  .option('--port <port>', 'HTTP port', (value) => Number(value))
  .option('--host <host>', 'HTTP bind address', process.env.SWITCHBOARD_BIND_HOST ?? '127.0.0.1')
  .addOption(new Option('--auth <mode>', 'gateway = accept only gateway-minted tokens; none = no auth (loopback only)').choices(['gateway', 'none']).default('gateway'))
  .action(async (name: string, opts: { stdio?: boolean; port?: number; host: string; auth: 'gateway' | 'none' }) => {
    const db = createPool();
    if (opts.stdio) {
      if (!SERVER_NAMES.includes(name as ServerName)) throw new Error(`unknown server ${name}`);
      startStdioServer(name as ServerName, db);
      return;
    }
    const names = name === 'all' ? [...SERVER_NAMES] : [name as ServerName];
    for (const server of names) {
      if (!SERVER_NAMES.includes(server)) throw new Error(`unknown server ${server}`);
      const resourceUrl = names.length === 1 ? process.env.SWITCHBOARD_SERVER_URL : undefined;
      await startHttpServer(server, db, {
        port: names.length === 1 && opts.port ? opts.port : DEFAULT_PORTS[server],
        host: opts.host,
        auth: opts.auth,
        ...(resourceUrl && { resourceUrl }),
        ...(process.env.SWITCHBOARD_GATEWAY_JWKS_URL && { gatewayJwksUrl: process.env.SWITCHBOARD_GATEWAY_JWKS_URL }),
      });
    }
  });

program
  .command('gateway')
  .description('Run the gateway: one MCP endpoint (Streamable HTTP) with OAuth 2.1, policies, confirmations and audit')
  .option('--port <port>', 'HTTP port', (value) => Number(value), Number(process.env.PORT ?? 8080))
  .option('--host <host>', 'HTTP bind address', process.env.SWITCHBOARD_BIND_HOST ?? '127.0.0.1')
  .option('--stdio', 'serve the gateway over stdio as the user in SWITCHBOARD_TOKEN')
  .action(async (opts: { port: number; host: string; stdio?: boolean }) => {
    const db = createPool();
    if (opts.stdio) {
      const token = process.env.SWITCHBOARD_TOKEN;
      if (!token) throw new Error('set SWITCHBOARD_TOKEN (from `switchboard token --user <id>`)');
      await serveGatewayStdio({ db, token });
      return;
    }
    await serveGateway({ db, port: opts.port, host: opts.host });
  });

program
  .command('dev')
  .description('Local all-in-one: seed if empty, the five servers on 7101-7105 and the gateway on 8080')
  .option('--port <port>', 'gateway port', (value) => Number(value), 8080)
  .action(async (opts: { port: number }) => {
    await seedIfEmpty(false);
    const db = createPool(undefined, 20);
    for (const server of SERVER_NAMES) await startHttpServer(server, db);
    await serveGateway({ db, port: opts.port });
  });

program
  .command('token')
  .description('Print an access token for a demo user (local development: needs the database that holds the signing key)')
  .requiredOption('--user <id>', 'employee id, e.g. alice, sam, ana, adam')
  .option('--admin', 'a token for the admin API instead of /mcp')
  .option('--ttl <seconds>', 'lifetime', (value) => Number(value), 3600)
  .option('--client <id>', 'client id to put in the token', 'switchboard-cli')
  .action(async (opts: { user: string; admin?: boolean; ttl: number; client: string }) => {
    const db = createPool();
    try {
      const config = loadConfig();
      const keys = await KeyManager.load(db);
      const row = (await db.query('SELECT id, role, name FROM core.employees WHERE id = $1 AND can_sign_in', [opts.user])).rows[0] as { id: string; role: string; name: string } | undefined;
      if (!row) throw new Error(`no user ${opts.user} who can sign in`);
      const tenant = config.tenants[config.defaultTenant];
      const roleScopes = tenant?.roles[row.role]?.scopes ?? [];
      const all = roleScopes.includes('*') ? ALL_SCOPES : roleScopes;
      const scopes = opts.admin ? ['admin'] : all.filter((scope) => scope !== 'admin');
      if (opts.admin && row.role !== 'admin') throw new Error('admin API tokens are only for the admin role');
      const token = await issueAccessToken(
        keys,
        config,
        { sub: row.id, role: row.role, tenant: config.defaultTenant, scope: scopes.join(' '), client_id: opts.client, name: row.name },
        opts.admin ? config.adminResource : config.mcpResource,
        opts.ttl,
      );
      process.stdout.write(`${token}\n`);
    } finally {
      await db.end();
    }
  });

registerEvalCommands(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
