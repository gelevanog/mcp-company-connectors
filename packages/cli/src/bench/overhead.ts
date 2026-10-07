/**
 * How much latency the gateway adds per tool call: the same read-only call, sequentially, straight to the
 * upstream server (with a downstream token) and through the gateway (role check, rate limit, untrusted-content
 * wrapping, audit insert). Run: node packages/cli/dist/bench/overhead.js (needs DATABASE_URL).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { databaseUrl } from '@switchboard/core';
import { issueDownstreamToken } from '@switchboard/gateway';

import { startStack } from '../eval/stack.js';

const N = Number(process.env.BENCH_CALLS ?? 100);
const stack = await startStack({ databaseUrl: process.env.EVAL_DATABASE_URL ?? databaseUrl(), callsPerMinute: 100_000 });
const deps = stack.gateway.gateway.deps;

async function measure(url: string, token: string): Promise<number[]> {
  const client = new Client({ name: 'bench', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } }));
  const times: number[] = [];
  for (let i = 0; i < N + 5; i += 1) {
    const started = performance.now();
    const result = await client.callTool({ name: 'helpdesk_get_ticket', arguments: { ticket_id: 'T-1001' } });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    if (i >= 5) times.push(performance.now() - started);
  }
  await client.close();
  return times.sort((a, b) => a - b);
}

const pct = (values: number[], p: number) => values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)] ?? 0;
const userToken = await stack.token('sam');
const downstream = await issueDownstreamToken(stack.gateway.gateway.keys, deps.config, { userId: 'sam', role: 'support', tenant: 'kestrel', scopes: ['helpdesk:read'], clientId: 'bench' }, stack.serverUrls.helpdesk);
const direct = await measure(stack.serverUrls.helpdesk, downstream);
const viaGateway = await measure(stack.mcpUrl, userToken);
const summary = {
  calls: N,
  tool: 'helpdesk_get_ticket (one ticket, untrusted body wrapped by the gateway)',
  direct_ms: { p50: Math.round(pct(direct, 0.5) * 10) / 10, p95: Math.round(pct(direct, 0.95) * 10) / 10 },
  gateway_ms: { p50: Math.round(pct(viaGateway, 0.5) * 10) / 10, p95: Math.round(pct(viaGateway, 0.95) * 10) / 10 },
};
console.log(JSON.stringify(summary, null, 2));
await stack.close();
process.exit(0);
