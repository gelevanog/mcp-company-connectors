import { McpServer } from '@modelcontextprotocol/server';
import {
  type Actor,
  type AnyToolSpec,
  type Db,
  type Queryable,
  INTERNAL_DOMAIN,
  META,
  ToolError,
  defineTool,
  idempotencyKey,
  nowIso,
  queryOne,
  queryRows,
  registerTools,
  today,
  withIdempotency,
} from '@switchboard/core';
import * as z from 'zod/v4';

export interface WorkspaceServerOptions {
  db: Db;
  fallbackActor?: Actor;
}

const event = z.object({
  id: z.string(),
  owner: z.string(),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  attendees: z.array(z.string()),
  description: z.string(),
  company_id: z.string().nullable(),
});

const email = z.object({
  id: z.string(),
  author: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  status: z.string(),
  related_ticket: z.string().nullable(),
  related_deal: z.string().nullable(),
  created_at: z.string(),
  submitted_at: z.string().nullable(),
  decided_at: z.string().nullable(),
});

const EMAIL_SELECT = `SELECT m.id, m.author_id AS author, m.to_addresses AS "to", m.cc_addresses AS cc, m.subject, m.body, m.status,
  m.related_ticket, m.related_deal, m.created_at, m.submitted_at, m.decided_at FROM workspace.emails m`;

/**
 * Business rule shared by email and invitations: only Kestrel employees and contacts already in the CRM can be
 * addressed. An address that appears only in a ticket or a pasted email is not enough.
 */
export async function checkRecipients(db: Queryable, addresses: string[]): Promise<{ internal: string[]; external: string[] }> {
  const normalized = [...new Set(addresses.map((address) => address.trim().toLowerCase()))];
  const internal: string[] = [];
  const external: string[] = [];
  const unknown: string[] = [];
  for (const address of normalized) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new ToolError(`"${address}" is not an email address`);
    const employee = await queryOne<{ id: string }>(db, 'SELECT id FROM core.employees WHERE lower(email) = $1', [address]);
    if (employee) {
      internal.push(address);
      continue;
    }
    const contact = await queryOne<{ id: string }>(db, 'SELECT id FROM crm.contacts WHERE lower(email) = $1', [address]);
    if (contact) external.push(address);
    else unknown.push(address);
  }
  if (unknown.length > 0) {
    throw new ToolError(
      `recipient(s) not allowed: ${unknown.join(', ')}. Only Kestrel employees (@${INTERNAL_DOMAIN}) and contacts in the CRM can be addressed.`,
      'recipient_not_allowed',
    );
  }
  return { internal, external };
}

/** Kestrel colleagues can be named by id or name ("sam", "Tara Lindqvist"); everyone else needs an address. */
export async function resolveAddresses(db: Queryable, entries: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of entries) {
    const value = entry.trim();
    if (value.includes('@')) {
      out.push(value.toLowerCase());
      continue;
    }
    const row = await queryOne<{ email: string }>(
      db,
      `SELECT email FROM core.employees WHERE id = lower($1) OR lower(name) = lower($1) OR lower(split_part(name, ' ', 1)) = lower($1) ORDER BY (id = lower($1)) DESC LIMIT 1`,
      [value],
    );
    if (!row) throw new ToolError(`"${value}" is not a Kestrel employee; give an email address for anyone else`, 'recipient_not_allowed');
    out.push(row.email);
  }
  return [...new Set(out)];
}

async function employee(db: Queryable, idOrEmail: string): Promise<{ id: string; name: string; email: string; timezone: string }> {
  const row = await queryOne<{ id: string; name: string; email: string; timezone: string }>(
    db,
    'SELECT id, name, email, timezone FROM core.employees WHERE id = lower($1) OR lower(email) = lower($1) OR name ILIKE $1',
    [idOrEmail],
  );
  if (!row) throw new ToolError(`no Kestrel employee "${idOrEmail}"`, 'not_found');
  return row;
}

function localHour(date: Date, timezone: string): { hour: number; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  return { hour: Number(get('hour')), minute: Number(get('minute')), weekday: get('weekday') };
}

export function workspaceTools(): AnyToolSpec[] {
  const listEvents = defineTool({
    name: 'calendar_list_events',
    title: 'List calendar events',
    description: 'Your calendar events between two dates (inclusive). Defaults to the next 7 days.',
    scope: 'calendar:read',
    input: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
    output: z.object({ events: z.array(event) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args, ctx) {
      const from = args.from ?? today();
      const to = args.to ?? new Date(Date.parse(`${from}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const events = await queryRows<z.infer<typeof event>>(
        ctx.db,
        `SELECT id, owner_id AS owner, title, starts_at, ends_at, attendees, description, company_id FROM workspace.events
         WHERE owner_id = $1 AND starts_at >= $2::date AND starts_at < ($3::date + 1) ORDER BY starts_at`,
        [ctx.actor.userId, from, to],
      );
      return { data: { events } };
    },
  });

  const availability = defineTool({
    name: 'calendar_find_availability',
    title: 'Find free meeting slots',
    description:
      'Free slots when every listed Kestrel employee is within working hours (09:00-17:00 in their own time zone, Mon-Fri) ' +
      'and has no event. External attendees are not checked. You are always included.',
    scope: 'calendar:read',
    input: z.object({
      attendees: z.array(z.string().max(120)).max(6).default([]).describe('Other Kestrel employees (id or email)'),
      duration_minutes: z.number().int().min(15).max(240).default(30),
      from: z.iso.date().optional().describe('First day to search (default: today)'),
      to: z.iso.date().optional().describe('Last day to search (default: 7 days after from)'),
      max_slots: z.number().int().min(1).max(20).default(5),
    }),
    output: z.object({
      slots: z.array(z.object({ start: z.string(), end: z.string(), local_times: z.record(z.string(), z.string()) })),
      checked: z.array(z.string()),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args, ctx) {
      const people = [await employee(ctx.db, ctx.actor.userId)];
      for (const attendee of args.attendees) {
        if (attendee.includes('@') && !attendee.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`)) continue;
        const person = await employee(ctx.db, attendee);
        if (!people.some((p) => p.id === person.id)) people.push(person);
      }
      const from = args.from ?? today();
      const to = args.to ?? new Date(Date.parse(`${from}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const busy = await queryRows<{ owner_id: string; starts_at: string; ends_at: string }>(
        ctx.db,
        'SELECT owner_id, starts_at, ends_at FROM workspace.events WHERE owner_id = ANY($1) AND ends_at > $2::date AND starts_at < ($3::date + 1)',
        [people.map((p) => p.id), from, to],
      );
      const slots: { start: string; end: string; local_times: Record<string, string> }[] = [];
      const durationMs = args.duration_minutes * 60_000;
      const earliest = Date.parse(nowIso()) + 30 * 60_000;
      for (let t = Date.parse(`${from}T00:00:00Z`); t < Date.parse(`${to}T23:59:59Z`) && slots.length < args.max_slots; t += 30 * 60_000) {
        if (t < earliest) continue;
        const start = new Date(t);
        const end = new Date(t + durationMs);
        const ok = people.every((person) => {
          const s = localHour(start, person.timezone);
          const e = localHour(new Date(t + durationMs - 60_000), person.timezone);
          if (s.weekday === 'Sat' || s.weekday === 'Sun') return false;
          if (s.hour < 9 || e.hour >= 17) return false;
          return !busy.some((b) => b.owner_id === person.id && Date.parse(b.starts_at) < end.getTime() && Date.parse(b.ends_at) > t);
        });
        if (ok) {
          const localTimes = Object.fromEntries(
            people.map((p) => [p.id, new Intl.DateTimeFormat('en-GB', { timeZone: p.timezone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(start)]),
          );
          slots.push({ start: start.toISOString(), end: end.toISOString(), local_times: localTimes });
          t += durationMs - 30 * 60_000; // do not propose overlapping slots
        }
      }
      return { data: { slots, checked: people.map((p) => p.id) } };
    },
  });

  const createEvent = defineTool({
    name: 'calendar_create_event',
    title: 'Create a calendar event',
    description: 'Create an event on your calendar and invite Kestrel employees or CRM contacts. Requires confirmation by the user.',
    scope: 'calendar:write',
    write: true,
    input: z.object({
      title: z.string().min(2).max(200),
      start: z.iso.datetime({ offset: true }).describe('ISO 8601 start time, e.g. 2026-10-06T14:00:00Z'),
      duration_minutes: z.number().int().min(15).max(480).default(30),
      attendees: z.array(z.string().max(120)).max(20).default([]).describe('Kestrel colleagues by id or name (sam, Tara Lindqvist), or CRM contacts by email address'),
      description: z.string().max(2000).default(''),
      company: z.string().regex(/^C-\d{4}$/).optional(),
      idempotency_key: idempotencyKey,
    }),
    output: z.object({ event, replayed: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(args, ctx) {
      const owner = await employee(ctx.db, ctx.actor.userId);
      const invited = await resolveAddresses(ctx.db, args.attendees);
      await checkRecipients(ctx.db, invited);
      const startMs = Date.parse(args.start);
      if (startMs < Date.parse(nowIso()) - 60_000) throw new ToolError('the start time is in the past');
      const attendees = [...new Set([owner.email, ...invited])];
      const { result, replayed } = await withIdempotency(
        ctx.db,
        { tool: 'calendar_create_event', key: args.idempotency_key, args, actor: ctx.actor.userId },
        async (client) => {
          const row = await queryOne<z.infer<typeof event>>(
            client,
            `INSERT INTO workspace.events (id, owner_id, title, starts_at, ends_at, attendees, description, company_id, created_at)
             VALUES ('E-' || nextval('workspace.event_seq'), $1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, owner_id AS owner, title, starts_at, ends_at, attendees, description, company_id`,
            [owner.id, args.title, new Date(startMs).toISOString(), new Date(startMs + args.duration_minutes * 60_000).toISOString(), attendees, args.description, args.company ?? null, nowIso()],
          );
          if (!row) throw new ToolError('event was not created');
          return row;
        },
      );
      return { data: { event: result, replayed }, text: `Event ${result.id} "${result.title}" created for ${result.starts_at}.` };
    },
  });

  const draftEmail = defineTool({
    name: 'email_draft',
    title: 'Draft an email',
    description:
      'Save an email draft from you. Recipients must be Kestrel employees or contacts in the CRM. Nothing is sent: use ' +
      'email_send to put the draft in the outbox for an admin to approve. Requires confirmation by the user.',
    scope: 'email:draft',
    write: true,
    input: z.object({
      to: z.array(z.string().max(120)).min(1).max(10).describe('CRM contacts by email address, or Kestrel colleagues by id, name or email'),
      cc: z.array(z.string().max(120)).max(10).default([]),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(8000),
      related_ticket: z.string().regex(/^T-\d{4}$/).optional(),
      related_deal: z.string().regex(/^D-\d{4}$/).optional(),
      idempotency_key: idempotencyKey,
    }),
    output: z.object({ email, recipients: z.object({ internal: z.array(z.string()), external: z.array(z.string()) }), replayed: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(args, ctx) {
      const to = await resolveAddresses(ctx.db, args.to);
      const cc = await resolveAddresses(ctx.db, args.cc);
      const recipients = await checkRecipients(ctx.db, [...to, ...cc]);
      const { result, replayed } = await withIdempotency(
        ctx.db,
        { tool: 'email_draft', key: args.idempotency_key, args, actor: ctx.actor.userId },
        async (client) => {
          const row = await queryOne<{ id: string }>(
            client,
            `INSERT INTO workspace.emails (id, author_id, to_addresses, cc_addresses, subject, body, status, related_ticket, related_deal, created_at)
             VALUES ('M-' || nextval('workspace.email_seq'), $1, $2, $3, $4, $5, 'draft', $6, $7, $8) RETURNING id`,
            [ctx.actor.userId, to, cc, args.subject, args.body, args.related_ticket ?? null, args.related_deal ?? null, nowIso()],
          );
          const created = await queryOne<z.infer<typeof email>>(client, `${EMAIL_SELECT} WHERE m.id = $1`, [row?.id]);
          if (!created) throw new ToolError('draft was not created');
          return created;
        },
      );
      return { data: { email: result, recipients, replayed }, text: `Draft ${result.id} saved (not sent). Use email_send to submit it for approval.` };
    },
  });

  const sendEmail = defineTool({
    name: 'email_send',
    title: 'Submit a draft for sending',
    description:
      'Move one of your drafts to the outbox. It is delivered only after an admin approves it in the Switchboard admin ' +
      '(in this demo, delivery is a sandbox mailbox: nothing leaves the machine). Requires confirmation by the user.',
    scope: 'email:send',
    write: true,
    input: z.object({ draft_id: z.string().regex(/^M-\d{4}$/), idempotency_key: idempotencyKey }),
    output: z.object({ email, replayed: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const { result, replayed } = await withIdempotency(
        ctx.db,
        { tool: 'email_send', key: args.idempotency_key, args, actor: ctx.actor.userId },
        async (client) => {
          const current = await queryOne<{ author_id: string; status: string; to_addresses: string[]; cc_addresses: string[] }>(
            client, 'SELECT author_id, status, to_addresses, cc_addresses FROM workspace.emails WHERE id = $1 FOR UPDATE', [args.draft_id]);
          if (!current) throw new ToolError(`no draft ${args.draft_id}`, 'not_found');
          if (current.author_id !== ctx.actor.userId) throw new ToolError(`${args.draft_id} is not your draft`, 'forbidden');
          if (current.status === 'draft') {
            await checkRecipients(client, [...current.to_addresses, ...current.cc_addresses]);
            await client.query(`UPDATE workspace.emails SET status = 'pending_approval', submitted_at = $2 WHERE id = $1`, [args.draft_id, nowIso()]);
          } else if (current.status !== 'pending_approval') {
            throw new ToolError(`${args.draft_id} is already ${current.status}`);
          }
          const row = await queryOne<z.infer<typeof email>>(client, `${EMAIL_SELECT} WHERE m.id = $1`, [args.draft_id]);
          if (!row) throw new ToolError('email not found');
          return row;
        },
      );
      return { data: { email: result, replayed }, text: `${result.id} is in the outbox, waiting for an admin to approve delivery.` };
    },
  });

  const listEmails = defineTool({
    name: 'email_list',
    title: 'List your emails',
    description: 'Your drafts and outbox, newest first.',
    scope: 'email:draft',
    input: z.object({ status: z.enum(['draft', 'pending_approval', 'approved', 'rejected']).optional(), limit: z.number().int().min(1).max(25).default(10) }),
    output: z.object({ emails: z.array(email) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args, ctx) {
      const params: unknown[] = [ctx.actor.userId];
      let filter = 'WHERE m.author_id = $1';
      if (args.status) {
        params.push(args.status);
        filter += ' AND m.status = $2';
      }
      const emails = await queryRows<z.infer<typeof email>>(ctx.db, `${EMAIL_SELECT} ${filter} ORDER BY m.created_at DESC LIMIT ${args.limit}`, params);
      return { data: { emails } };
    },
  });

  return [listEvents, availability, createEvent, draftEmail, sendEmail, listEmails];
}

export const WORKSPACE_INSTRUCTIONS =
  'Calendar and email for Kestrel employees. Emails are drafted, then submitted to an outbox an admin approves; nothing ' +
  'is sent directly. Only employees and CRM contacts can be addressed.';

export function createWorkspaceServer(options: WorkspaceServerOptions): McpServer {
  const server = new McpServer(
    { name: 'switchboard-workspace', title: 'Switchboard Calendar and Email', version: '0.1.0' },
    { instructions: WORKSPACE_INSTRUCTIONS },
  );
  registerTools(server, workspaceTools(), { db: options.db, fallbackActor: options.fallbackActor, serverName: 'workspace' });
  server.registerPrompt(
    'follow_up_email',
    {
      title: 'Draft a follow-up email',
      description: 'Draft a follow-up to a customer about a ticket and propose a meeting time.',
      argsSchema: z.object({ ticket_id: z.string().describe('Ticket id, e.g. T-1001') }),
      _meta: { [META.scope]: 'email:draft' },
    },
    async ({ ticket_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Draft a follow-up email to the requester of ticket ${ticket_id}: summarize where the issue stands ` +
              `(helpdesk_get_ticket, kb_search), propose two meeting times from calendar_find_availability, and save it with email_draft. ` +
              `Do not submit it.`,
          },
        },
      ],
    }),
  );
  return server;
}
