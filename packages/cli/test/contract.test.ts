import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type Db, META, createPool, seedDemo, setupAnalyticsRole, stdioActor } from '@switchboard/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVER_NAMES, type ServerName, serverFactory } from '../src/servers.js';
import { TEST_DATABASE_URL, databaseAvailable } from './harness.js';

const available = await databaseAvailable();

/** One valid call per tool; the client validates structuredContent against the advertised outputSchema. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  crm_search_companies: { query: 'acme' },
  crm_get_company: { company: 'C-1001' },
  crm_search_contacts: { company: 'ACME Logistics' },
  crm_search_deals: { stage: 'won', closed_from: '2026-09-01', closed_to: '2026-10-01' },
  crm_get_deal: { deal_id: 'D-3001' },
  crm_update_deal_stage: { deal_id: 'D-3002', stage: 'negotiation', reason: 'contract test', idempotency_key: 'contract-stage-0001' },
  crm_add_note: { deal_id: 'D-3001', body: 'contract test note', idempotency_key: 'contract-note-0001' },
  helpdesk_search_tickets: { status: ['open', 'pending'], priority: 'urgent' },
  helpdesk_get_ticket: { ticket_id: 'T-1001' },
  helpdesk_add_comment: { ticket_id: 'T-1001', body: 'contract test comment' },
  helpdesk_update_ticket: { ticket_id: 'T-1003', assignee: 'sam' },
  helpdesk_create_ticket: { company: 'C-1004', subject: 'Contract test ticket', body: 'body' },
  analytics_describe_schema: {},
  analytics_query: { sql: 'SELECT plan, count(*) AS n FROM crm.companies GROUP BY plan' },
  analytics_run_report: { report: 'pipeline_by_region' },
  kb_search: { query: 'sso login loop' },
  kb_get_document: { slug: 'sso-setup' },
  calendar_list_events: { from: '2026-10-01', to: '2026-10-02' },
  calendar_find_availability: { attendees: ['sam'], duration_minutes: 30, from: '2026-10-05', to: '2026-10-06' },
  calendar_create_event: { title: 'Contract test', start: '2026-10-09T15:00:00Z', attendees: ['maria.gonzalez@acme-logistics.example'] },
  email_draft: { to: ['maria.gonzalez@acme-logistics.example'], subject: 'Contract test', body: 'Hello' },
  email_send: { draft_id: 'M-8001' },
  email_list: {},
};

describe.skipIf(!available)('tool contracts (every server, every tool)', () => {
  let db: Db;
  const clients = new Map<ServerName, Client>();
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = createPool(TEST_DATABASE_URL, 5);
    await seedDemo(db);
    await setupAnalyticsRole(db, 'switchboard_analytics', 'switchboard_analytics');
    for (const name of SERVER_NAMES) {
      const server = serverFactory(name, db, { ...stdioActor(), userId: 'adam', via: 'test' })();
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: 'contract', version: '1' });
      await client.connect(b);
      clients.set(name, client);
    }
  });
  afterAll(async () => {
    for (const client of clients.values()) await client.close();
    await db?.end();
  });

  it('covers every tool with a sample', async () => {
    const names: string[] = [];
    for (const client of clients.values()) names.push(...(await client.listTools()).tools.map((t) => t.name));
    expect(names.sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  for (const server of SERVER_NAMES) {
    it(`${server}: every tool declares title, schemas, annotations and a scope; samples return valid structured content`, async () => {
      const client = clients.get(server);
      if (!client) throw new Error('no client');
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.title, tool.name).toBeTruthy();
        expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.outputSchema?.type, tool.name).toBe('object');
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
        expect(tool.annotations?.openWorldHint, tool.name).toBeDefined();
        expect(typeof tool._meta?.[META.scope], tool.name).toBe('string');
        const write = tool._meta?.[META.write] === true;
        expect(write, tool.name).toBe(tool.annotations?.readOnlyHint === false);
        if (write) {
          expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
          expect(typeof tool.annotations?.idempotentHint, tool.name).toBe('boolean');
          expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toContain('idempotency_key');
        }
        const result = await client.callTool({ name: tool.name, arguments: SAMPLES[tool.name] ?? {} });
        expect(result.isError, `${tool.name}: ${JSON.stringify(result.content).slice(0, 300)}`).toBeFalsy();
        expect(result.structuredContent, tool.name).toBeDefined();
      }
    });
  }

  it('search matches every word of a multi-word query', async () => {
    const helpdesk = clients.get('helpdesk');
    const result = await helpdesk?.callTool({ name: 'helpdesk_search_tickets', arguments: { query: 'VAT invoice', company: 'ACME Logistics' } });
    expect((result?.structuredContent as { tickets: { id: string }[] }).tickets.map((t) => t.id)).toEqual(['T-1003']);
  });

  it('accepts colleagues by id or name as invitees and recipients', async () => {
    const workspace = clients.get('workspace');
    const result = await workspace?.callTool({ name: 'calendar_create_event', arguments: { title: 'Rollout check', start: '2026-10-08T10:00:00Z', attendees: ['sam', 'Tara Lindqvist'] } });
    expect((result?.structuredContent as { event: { attendees: string[] } }).event.attendees).toEqual(['adam@kestrel.example', 'sam@kestrel.example', 'tara@kestrel.example']);
    const unknown = await workspace?.callTool({ name: 'email_draft', arguments: { to: ['nobody-by-that-name'], subject: 'x', body: 'y' } });
    expect(unknown?.isError).toBe(true);
  });

  it('rejects arguments that break the input schema before the handler runs', async () => {
    const crm = clients.get('crm');
    const result = await crm?.callTool({ name: 'crm_update_deal_stage', arguments: { deal_id: 'D-3001', stage: 'closed-ish' } });
    expect(result?.isError).toBe(true);
  });
});
