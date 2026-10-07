import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Stack, TEST_DATABASE_URL, databaseAvailable, startStack } from './harness.js';

const available = await databaseAvailable();
const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));

async function connect(stack: Stack, user: string, mode: 'auto' | 'legacy' = 'auto', options: { elicit?: boolean; headers?: Record<string, string> } = {}) {
  const token = await stack.token(user);
  const client = new Client(
    { name: `test-${mode}`, version: '1.0.0' },
    { versionNegotiation: { mode }, capabilities: options.elicit ? { elicitation: { form: {} } } : {} },
  );
  if (options.elicit) client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { confirm: true } }));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: { token: async () => token }, ...(options.headers && { requestInit: { headers: options.headers } }) }),
  );
  return client;
}

describe.skipIf(!available)('MCP protocol conformance through the gateway', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ pageSize: 5 });
  });
  afterAll(async () => {
    await stack?.close();
  });

  for (const mode of ['auto', 'legacy'] as const) {
    describe(`Streamable HTTP, ${mode === 'auto' ? '2026-07-28 (server/discover)' : '2025-11-25 (initialize)'}`, () => {
      it('negotiates the era and identifies the gateway', async () => {
        const client = await connect(stack, 'alice', mode);
        expect(client.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
        expect(client.getServerVersion()?.name).toBe('switchboard-gateway');
        expect(client.getInstructions()).toContain('acting for Alice Moreau');
        await client.close();
      });

      it('lists tools page by page in a deterministic order, with schemas and annotations', async () => {
        const client = await connect(stack, 'alice', mode);
        const first = await client.listTools({ cursor: undefined as unknown as string });
        const all = await client.listTools();
        expect(all.tools.length).toBe(17);
        expect(all.nextCursor).toBeUndefined();
        const page = await client.listTools({ cursor: Buffer.from('5').toString('base64url') });
        expect(page.tools.map((t) => t.name)).toEqual(all.tools.slice(5, 10).map((t) => t.name));
        expect(page.nextCursor).toBeDefined();
        const again = await client.listTools();
        expect(again.tools.map((t) => t.name)).toEqual(all.tools.map((t) => t.name));
        for (const tool of all.tools) {
          expect(tool.inputSchema.type).toBe('object');
          expect(tool.outputSchema?.type).toBe('object');
          expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
          expect(tool.annotations?.openWorldHint).toBeDefined();
        }
        const write = all.tools.find((t) => t.name === 'crm_update_deal_stage');
        expect(write?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
        expect(Object.keys(write?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['idempotency_key', 'confirmation_token']));
        expect(first).toBeDefined();
        await client.close();
      });

      it('calls a tool and returns structured content that matches the output schema', async () => {
        const client = await connect(stack, 'alice', mode);
        const result = await client.callTool({ name: 'crm_search_companies', arguments: { query: 'ACME' } });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ total: 1, companies: [{ id: 'C-1001', name: 'ACME Logistics' }] });
        await client.close();
      });

      it('reports invalid arguments as a tool error the model can read', async () => {
        const client = await connect(stack, 'alice', mode);
        const result = await client.callTool({ name: 'crm_get_deal', arguments: { deal_id: 'not-a-deal' } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/validation/i);
        await client.close();
      });

      it('lists resource templates and paginated resources, and reads a resource with untrusted text marked', async () => {
        const client = await connect(stack, 'alice', mode);
        const templates = await client.listResourceTemplates();
        expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(['crm://deal/{id}', 'helpdesk://ticket/{id}', 'kb://doc/{slug}']);
        const firstPage = await client.listResources({ cursor: undefined as unknown as string });
        expect(firstPage.resources.length).toBeGreaterThan(5);
        const read = await client.readResource({ uri: 'crm://deal/D-3005' });
        const text = (read.contents[0] as { text: string }).text;
        expect(text).toContain('[UNTRUSTED DATA');
        expect(text).toContain('WARNING: possible prompt injection');
        await client.close();
      });

      it('lists prompts by scope and fills one in, with argument completion', async () => {
        const client = await connect(stack, 'alice', mode);
        const prompts = await client.listPrompts();
        expect(prompts.prompts.map((p) => p.name).sort()).toEqual(['follow_up_email', 'prepare_call', 'triage_ticket']);
        const prompt = await client.getPrompt({ name: 'prepare_call', arguments: { company: 'ACME Logistics' } });
        expect(JSON.stringify(prompt.messages)).toContain('call with ACME Logistics');
        const completion = await client.complete({ ref: { type: 'ref/prompt', name: 'prepare_call' }, argument: { name: 'company', value: 'Bright' } });
        expect(completion.completion.values).toContain('Brightline Retail');
        await client.close();
      });

      it('forwards progress notifications from the upstream server', async () => {
        const client = await connect(stack, 'ana', mode);
        const updates: string[] = [];
        const result = await client.callTool(
          { name: 'analytics_run_report', arguments: { report: 'won_by_month' } },
          { onprogress: (p) => updates.push(p.message ?? '') },
        );
        expect(result.isError).toBeFalsy();
        expect(updates.length).toBeGreaterThanOrEqual(12);
        expect(updates.some((m) => m.startsWith('month'))).toBe(true);
        await client.close();
      });
    });
  }

  it('cancels a long query end to end: client abort → gateway → upstream → PostgreSQL', async () => {
    const client = await connect(stack, 'ana', 'auto');
    const controller = new AbortController();
    const call = client.callTool(
      { name: 'analytics_query', arguments: { sql: 'SELECT count(*) FROM generate_series(1, 400000000) AS s' } },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const running = await stack.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE '%generate_series(1, 400000000)%' AND state = 'active' AND pid <> pg_backend_pid()`);
    expect((running.rows[0] as { n: number }).n).toBe(1);
    controller.abort('user pressed stop');
    await expect(call).rejects.toThrow();
    let remaining = 1;
    for (let i = 0; i < 20 && remaining > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const rows = await stack.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE '%generate_series(1, 400000000)%' AND state = 'active' AND pid <> pg_backend_pid()`);
      remaining = (rows.rows[0] as { n: number }).n;
    }
    expect(remaining).toBe(0);
    await client.close();
  });

  it('serves the gateway over stdio as the user in SWITCHBOARD_TOKEN, with the same policies', async () => {
    const token = await stack.token('sam');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'gateway', '--stdio'],
      env: {
        ...process.env as Record<string, string>,
        DATABASE_URL: TEST_DATABASE_URL,
        SWITCHBOARD_TOKEN: token,
        SWITCHBOARD_PUBLIC_URL: stack.gatewayUrl,
        SWITCHBOARD_UPSTREAM_CRM_URL: stack.serverUrls.crm,
        SWITCHBOARD_UPSTREAM_HELPDESK_URL: stack.serverUrls.helpdesk,
        SWITCHBOARD_UPSTREAM_ANALYTICS_URL: stack.serverUrls.analytics,
        SWITCHBOARD_UPSTREAM_KB_URL: stack.serverUrls.kb,
        SWITCHBOARD_UPSTREAM_WORKSPACE_URL: stack.serverUrls.workspace,
        SWITCHBOARD_LOG: 'silent',
      },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    let elicited = 0;
    client.setRequestHandler('elicitation/create', async () => {
      elicited += 1;
      return { action: 'accept', content: { confirm: true } };
    });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('helpdesk_add_comment');
    expect(tools).not.toContain('crm_search_deals');
    const result = await client.callTool({ name: 'helpdesk_add_comment', arguments: { ticket_id: 'T-1002', body: 'stdio test', internal: true } });
    expect(result.isError).toBeFalsy();
    expect(elicited).toBe(1); // the legacy shim pushed elicitation/create over the stdio session
    await client.close();
  });

  it('serves a single server over stdio for local clients', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve', 'kb', '--stdio'],
      env: { ...process.env as Record<string, string>, DATABASE_URL: TEST_DATABASE_URL },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-kb', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    const result = await client.callTool({ name: 'kb_search', arguments: { query: 'refund duplicate charge' } });
    expect((result.structuredContent as { results: { slug: string }[] }).results[0]?.slug).toBe('refund-policy');
    await client.close();
  });
});
