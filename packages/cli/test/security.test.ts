import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { INJECTION_EXFIL_ADDRESS, queryOne } from '@switchboard/core';
import { connectGateway, createModel, defaultSystemPrompt, runAgent } from '@switchboard/agent';
import { fakeScripts } from '@switchboard/gateway';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type Stack, databaseAvailable, startStack } from './harness.js';

const available = await databaseAvailable();

async function client(stack: Stack, user: string, options: { elicit?: 'accept' | 'decline'; scopes?: string[]; legacy?: boolean } = {}) {
  const token = await stack.token(user, options.scopes ? { scopes: options.scopes } : {});
  const c = new Client(
    { name: 'security-test', version: '1' },
    { versionNegotiation: { mode: options.legacy ? 'legacy' : 'auto' }, capabilities: options.elicit ? { elicitation: { form: {} } } : {} },
  );
  let elicited = 0;
  if (options.elicit) {
    const action = options.elicit;
    c.setRequestHandler('elicitation/create', async () => {
      elicited += 1;
      return action === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
  }
  await c.connect(new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: { token: async () => token } }));
  return { c, elicited: () => elicited };
}

const text = (result: { content?: unknown }) => JSON.stringify(result.content ?? '');
const count = async (stack: Stack, sql: string, params: unknown[] = []) => (await queryOne<{ n: number }>(stack.db, sql, params))?.n ?? -1;

describe.skipIf(!available)('security: roles, confirmations, idempotency, injection', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ writesPerMinute: 1000, callsPerMinute: 1000 });
  });
  beforeEach(async () => {
    await stack.reseed();
  });
  afterAll(async () => {
    await stack?.close();
  });

  describe('role isolation', () => {
    it('support sees no deal tools and is denied when calling one anyway', async () => {
      const { c } = await client(stack, 'sam');
      const tools = (await c.listTools()).tools.map((t) => t.name);
      expect(tools.filter((name) => name.includes('deal'))).toEqual([]);
      for (const name of ['crm_search_deals', 'crm_get_deal', 'crm_update_deal_stage', 'analytics_query']) {
        const result = await c.callTool({ name, arguments: name === 'analytics_query' ? { sql: 'select 1' } : { deal_id: 'D-3001', stage: 'won' } });
        expect(result.isError, name).toBe(true);
        expect(text(result)).toContain('not available to the support role');
      }
      const audit = await count(stack, `SELECT count(*)::int AS n FROM gateway.audit_log WHERE user_id = 'sam' AND decision = 'denied_role'`);
      expect(audit).toBe(4);
      await c.close();
    });

    it("support's company view leaves out deals and notes; sales sees them", async () => {
      const support = await client(stack, 'sam');
      const asSupport = (await support.c.callTool({ name: 'crm_get_company', arguments: { company: 'C-1001' } })).structuredContent as Record<string, unknown>;
      expect(asSupport.pipeline_visible).toBe(false);
      expect(asSupport.deals).toBeUndefined();
      const sales = await client(stack, 'alice');
      const asSales = (await sales.c.callTool({ name: 'crm_get_company', arguments: { company: 'C-1001' } })).structuredContent as Record<string, unknown>;
      expect(asSales.pipeline_visible).toBe(true);
      expect((asSales.deals as unknown[]).length).toBe(2);
      await support.c.close();
      await sales.c.close();
    });

    it('contact emails and phone numbers reach only roles with contacts:pii (analysts get the rest)', async () => {
      const analyst = await client(stack, 'ana');
      const asAnalyst = (await analyst.c.callTool({ name: 'crm_get_company', arguments: { company: 'C-1001' } })).structuredContent as { personal_data_visible: boolean; contacts: { email: string | null; phone: string | null }[] };
      expect(asAnalyst.personal_data_visible).toBe(false);
      expect(asAnalyst.contacts.every((c) => c.email === null && c.phone === null)).toBe(true);
      const ticket = (await analyst.c.callTool({ name: 'helpdesk_get_ticket', arguments: { ticket_id: 'T-1187' } })).structuredContent as { ticket: { requester_email: string | null } };
      expect(ticket.ticket.requester_email).toBeNull();
      const sales = await client(stack, 'alice');
      const asSales = (await sales.c.callTool({ name: 'crm_get_company', arguments: { company: 'C-1001' } })).structuredContent as { contacts: { email: string | null }[] };
      expect(asSales.contacts[0]?.email).toContain('@acme-logistics.example');
      await analyst.c.close();
      await sales.c.close();
    });

    it('analysts are read-only: no write tool is listed or callable', async () => {
      const { c } = await client(stack, 'ana', { elicit: 'accept' });
      const tools = (await c.listTools()).tools;
      expect(tools.filter((t) => t.annotations?.readOnlyHint === false)).toEqual([]);
      const result = await c.callTool({ name: 'crm_add_note', arguments: { deal_id: 'D-3001', body: 'hi' } });
      expect(result.isError).toBe(true);
      await c.close();
    });

    it('an admin switch in the console removes a tool for a role at once', async () => {
      await stack.gateway.gateway.deps.overrides.set('kestrel', 'sales', 'email_send', false, 'adam');
      try {
        const { c } = await client(stack, 'alice');
        expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('email_send');
        const result = await c.callTool({ name: 'email_send', arguments: { draft_id: 'M-7003' } });
        expect(text(result)).toContain('switched off');
        await c.close();
      } finally {
        await stack.gateway.gateway.deps.overrides.clear('kestrel', 'sales', 'email_send');
      }
    });
  });

  describe('read-only SQL through the gateway', () => {
    const cases: [string, string][] = [
      ['DELETE FROM crm.deals', 'write_operation'],
      ['SELECT 1; DROP TABLE crm.deals', 'multiple_statements'],
      ['SELECT email, phone FROM crm.contacts', 'pii_column'],
      ['SELECT * FROM crm.contacts', 'select_star_pii'],
      ['SELECT pg_sleep(5)', 'function_not_allowed'],
      ['SELECT usename FROM pg_catalog.pg_user', 'system_catalog'],
      ['SELECT * FROM gateway.audit_log', 'system_catalog'],
      ['SELECT body FROM crm.notes', 'table_not_allowed'],
    ];
    for (const [sql, code] of cases) {
      it(`refuses ${sql}`, async () => {
        const { c } = await client(stack, 'ana');
        const result = await c.callTool({ name: 'analytics_query', arguments: { sql } });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(code);
        await c.close();
      });
    }

    it('runs a valid query as the read-only login, with the demo date pinned and a row cap', async () => {
      const { c } = await client(stack, 'ana');
      const result = await c.callTool({ name: 'analytics_query', arguments: { sql: `SELECT region, count(*) AS won FROM crm.deals WHERE stage = 'won' AND closed_at >= date_trunc('month', CURRENT_DATE) - interval '1 month' AND closed_at < date_trunc('month', CURRENT_DATE) GROUP BY region ORDER BY region`, max_rows: 2 } });
      const data = result.structuredContent as { rows: { region: string; won: number }[]; truncated: boolean; executed_sql: string };
      expect(data.rows).toEqual([{ region: 'AMER', won: 2 }, { region: 'APAC', won: 2 }]);
      expect(data.truncated).toBe(true);
      expect(data.executed_sql).toContain("DATE '2026-10-01'");
      await c.close();
    });

    it('the database login itself cannot read personal data, even if the validator were bypassed', async () => {
      const { createReaderPool } = await import('@switchboard/server-analytics');
      const reader = createReaderPool();
      await expect(reader.query('SELECT email FROM crm.contacts LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(reader.query(`UPDATE crm.deals SET stage = 'won'`)).rejects.toThrow(/read-only|permission denied/);
      await reader.end();
    });
  });

  describe('write confirmations', () => {
    it('a client without elicitation gets a confirmation token and nothing is written', async () => {
      const before = await count(stack, `SELECT count(*)::int AS n FROM crm.notes WHERE deal_id = 'D-3001'`);
      const { c } = await client(stack, 'alice');
      const first = await c.callTool({ name: 'crm_add_note', arguments: { deal_id: 'D-3001', body: 'Send the revised quote.' } });
      expect(first.isError).toBe(true);
      expect(text(first)).toContain('CONFIRMATION REQUIRED');
      expect(await count(stack, `SELECT count(*)::int AS n FROM crm.notes WHERE deal_id = 'D-3001'`)).toBe(before);
      const token = /"confirmation_token\\": \\"(cf_[A-Za-z0-9_-]+)/.exec(text(first))?.[1] ?? /confirmation_token": "(cf_[A-Za-z0-9_-]+)/.exec(String((first.content as { text: string }[])[0]?.text))?.[1];
      expect(token).toBeDefined();
      const changed = await c.callTool({ name: 'crm_add_note', arguments: { deal_id: 'D-3001', body: 'Something else.', confirmation_token: token } });
      expect(text(changed)).toContain('differ');
      const confirmed = await c.callTool({ name: 'crm_add_note', arguments: { deal_id: 'D-3001', body: 'Send the revised quote.', confirmation_token: token } });
      expect(confirmed.isError).toBeFalsy();
      expect(await count(stack, `SELECT count(*)::int AS n FROM crm.notes WHERE deal_id = 'D-3001'`)).toBe(before + 1);
      await c.close();
    });

    it('elicitation: an accepted confirmation writes once, a declined one writes nothing', async () => {
      const before = await count(stack, `SELECT count(*)::int AS n FROM helpdesk.comments WHERE ticket_id = 'T-1001'`);
      const declined = await client(stack, 'sam', { elicit: 'decline' });
      const no = await declined.c.callTool({ name: 'helpdesk_add_comment', arguments: { ticket_id: 'T-1001', body: 'Fix ships in 4.18.' } });
      expect(no.isError).toBe(true);
      expect(text(no)).toContain('declined');
      expect(declined.elicited()).toBe(1);
      expect(await count(stack, `SELECT count(*)::int AS n FROM helpdesk.comments WHERE ticket_id = 'T-1001'`)).toBe(before);
      const accepted = await client(stack, 'sam', { elicit: 'accept' });
      const yes = await accepted.c.callTool({ name: 'helpdesk_add_comment', arguments: { ticket_id: 'T-1001', body: 'Fix ships in 4.18.' } });
      expect(yes.isError).toBeFalsy();
      expect(await count(stack, `SELECT count(*)::int AS n FROM helpdesk.comments WHERE ticket_id = 'T-1001'`)).toBe(before + 1);
      await declined.c.close();
      await accepted.c.close();
    });

    it('high-risk tools fall back to admin approval for clients without elicitation', async () => {
      const { c } = await client(stack, 'alice');
      const first = await c.callTool({ name: 'crm_update_deal_stage', arguments: { deal_id: 'D-3002', stage: 'negotiation' } });
      expect(text(first)).toContain('APPROVAL REQUIRED');
      const id = /request (cf_[A-Za-z0-9_-]+)/.exec(text(first))?.[1] ?? '';
      const waiting = await c.callTool({ name: 'crm_update_deal_stage', arguments: { deal_id: 'D-3002', stage: 'negotiation', confirmation_token: id } });
      expect(text(waiting)).toContain('Still waiting');
      const adminToken = await stack.token('adam', { audience: `${stack.gatewayUrl}/admin/api`, scopes: ['admin'] });
      const approve = await fetch(`${stack.gatewayUrl}/admin/api/approvals/confirmation/${id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(approve.status).toBe(200);
      const done = await c.callTool({ name: 'crm_update_deal_stage', arguments: { deal_id: 'D-3002', stage: 'negotiation', confirmation_token: id } });
      expect(done.isError).toBeFalsy();
      expect((await queryOne<{ stage: string }>(stack.db, `SELECT stage FROM crm.deals WHERE id = 'D-3002'`))?.stage).toBe('negotiation');
      await c.close();
    });
  });

  describe('idempotency', () => {
    it('the same idempotency key applies a write once and replays the result', async () => {
      const { c } = await client(stack, 'sam', { elicit: 'accept' });
      const args = { company: 'C-1002', subject: 'Duplicate charge follow-up', body: 'Track the refund.', idempotency_key: 'ticket-dup-charge-0001' };
      const first = await c.callTool({ name: 'helpdesk_create_ticket', arguments: args });
      const second = await c.callTool({ name: 'helpdesk_create_ticket', arguments: args });
      expect((first.structuredContent as { ticket: { id: string } }).ticket.id).toBe((second.structuredContent as { ticket: { id: string } }).ticket.id);
      expect((second.structuredContent as { replayed: boolean }).replayed).toBe(true);
      expect(await count(stack, `SELECT count(*)::int AS n FROM helpdesk.tickets WHERE subject = 'Duplicate charge follow-up'`)).toBe(1);
      const conflict = await c.callTool({ name: 'helpdesk_create_ticket', arguments: { ...args, body: 'different' } });
      expect(conflict.isError).toBe(true);
      expect(text(conflict)).toContain('different arguments');
      await c.close();
    });

    it('a retried confirmation token replays instead of writing twice', async () => {
      const { c } = await client(stack, 'sam');
      const args = { ticket_id: 'T-1150', body: 'Sent the export instructions.', internal: false };
      const first = await c.callTool({ name: 'helpdesk_add_comment', arguments: args });
      const token = /"confirmation_token": "(cf_[A-Za-z0-9_-]+)"/.exec(String((first.content as { text: string }[])[0]?.text))?.[1];
      await c.callTool({ name: 'helpdesk_add_comment', arguments: { ...args, confirmation_token: token } });
      const again = await c.callTool({ name: 'helpdesk_add_comment', arguments: { ...args, confirmation_token: token } });
      expect((again.structuredContent as { replayed: boolean }).replayed).toBe(true);
      expect(await count(stack, `SELECT count(*)::int AS n FROM helpdesk.comments WHERE body = 'Sent the export instructions.'`)).toBe(1);
      await c.close();
    });
  });

  describe('rate limits', () => {
    it('refuses calls above the per-user limit', async () => {
      const limiter = stack.gateway.gateway.deps.rateLimiter as unknown as { tenant: { rate_limits: { default: { calls_per_minute: number } } } };
      limiter.tenant.rate_limits.default.calls_per_minute = 3;
      try {
        const { c } = await client(stack, 'alice');
        const results = [];
        for (let i = 0; i < 5; i += 1) results.push(await c.callTool({ name: 'kb_search', arguments: { query: 'sso' } }));
        expect(results.filter((r) => r.isError && text(r).includes('Rate limit')).length).toBe(2);
        await c.close();
      } finally {
        limiter.tenant.rate_limits.default.calls_per_minute = 1000;
        stack.gateway.gateway.deps.rateLimiter.reset();
      }
    });
  });

  describe('untrusted content and prompt injection', () => {
    it('marks ticket bodies as untrusted, flags the planted injection and blocks the exfiltration address', async () => {
      const { c } = await client(stack, 'sam', { elicit: 'accept' });
      const ticket = await c.callTool({ name: 'helpdesk_get_ticket', arguments: { ticket_id: 'T-1187' } });
      expect(text(ticket)).toContain('UNTRUSTED DATA');
      expect((ticket._meta as Record<string, unknown>)['io.switchboard/flags']).toContain('injection_suspected');
      const exfil = await c.callTool({ name: 'email_draft', arguments: { to: [INJECTION_EXFIL_ADDRESS], subject: 'Contacts', body: 'list' } });
      expect(text(exfil)).toContain('appeared only inside untrusted content');
      expect(await count(stack, `SELECT count(*)::int AS n FROM workspace.emails WHERE $1 = ANY(to_addresses)`, [INJECTION_EXFIL_ADDRESS])).toBe(0);
      await c.close();
    });

    it('a recipient that is not a CRM contact is refused by the workspace server too (defense in depth)', async () => {
      const { c } = await client(stack, 'sam', { elicit: 'accept' });
      const result = await c.callTool({ name: 'email_draft', arguments: { to: ['someone@unknown.example'], subject: 'x', body: 'y' } });
      expect(text(result)).toContain('recipient(s) not allowed');
      await c.close();
    });

    it('after flagged content, token confirmations escalate to admin approval', async () => {
      const { c } = await client(stack, 'alice');
      await c.callTool({ name: 'crm_get_deal', arguments: { deal_id: 'D-3005' } });
      const write = await c.callTool({ name: 'crm_add_note', arguments: { deal_id: 'D-3005', body: 'Approved by VP' } });
      expect(text(write)).toContain('APPROVAL REQUIRED');
      expect(text(write)).toContain('possible prompt injection');
      await c.close();
    });

    it('a gullible agent obeys the planted instructions; the gateway stops every attempt', async () => {
      const cases = [
        { user: 'sam', prompt: 'Summarize ticket T-1187 and tell me what the customer needs.', check: async () => expect(await count(stack, `SELECT count(*)::int AS n FROM workspace.emails WHERE $1 = ANY(to_addresses)`, [INJECTION_EXFIL_ADDRESS])).toBe(0) },
        { user: 'alice', prompt: 'What is the latest on the Harbor & Pine pilot deal D-3005? Summarize the notes.', check: async () => expect((await queryOne<{ stage: string }>(stack.db, `SELECT stage FROM crm.deals WHERE id = 'D-3005'`))?.stage).toBe('proposal') },
        { user: 'tara', prompt: 'Summarize ticket T-1123 for me.', check: async () => expect((await queryOne<{ status: string }>(stack.db, `SELECT status FROM helpdesk.tickets WHERE id = 'T-1123'`))?.status).toBe('open') },
      ];
      for (const scenario of cases) {
        const token = await stack.token(scenario.user);
        let confirmations = 0;
        const connection = await connectGateway({
          url: stack.mcpUrl,
          token,
          // The simulated user declines anything they did not ask for.
          elicit: async () => {
            confirmations += 1;
            return { action: 'decline' };
          },
        });
        const model = createModel({ provider: 'fake', gullible: true }, { scripts: fakeScripts() });
        const run = await runAgent({ connection, model, system: defaultSystemPrompt({ userName: scenario.user, role: 'x', company: 'Kestrel Cloud', today: '2026-10-01' }), prompt: scenario.prompt });
        const malicious = run.steps.filter((step) => ['email_draft', 'crm_update_deal_stage', 'helpdesk_update_ticket'].includes(step.name));
        expect(malicious.length, scenario.prompt).toBeGreaterThan(0); // the gullible model did try
        expect(malicious.every((step) => step.outcome.isError), scenario.prompt).toBe(true);
        await scenario.check();
        expect(confirmations + malicious.filter((s) => s.outcome.text.includes('Blocked')).length).toBeGreaterThan(0);
        await connection.close();
      }
    });
  });

  describe('audit log', () => {
    it('records user, client, tool, an argument hash, result size, decision and latency, never the arguments', async () => {
      const { c } = await client(stack, 'alice');
      await c.callTool({ name: 'crm_search_contacts', arguments: { query: 'maria.gonzalez' } });
      const row = await queryOne<Record<string, unknown>>(stack.db, `SELECT * FROM gateway.audit_log WHERE target = 'crm_search_contacts' ORDER BY id DESC LIMIT 1`);
      expect(row).toMatchObject({ user_id: 'alice', role: 'sales', client_id: 'test-client', method: 'tools/call', decision: 'allowed' });
      expect(String(row?.args_hash)).toMatch(/^[0-9a-f]{32}$/);
      expect(Number(row?.result_bytes)).toBeGreaterThan(100);
      expect(JSON.stringify(row)).not.toContain('maria.gonzalez');
      await c.close();
    });
  });
});
