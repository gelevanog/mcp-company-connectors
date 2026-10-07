import type { Db, DbClient } from '../db.js';
import { withTransaction } from '../db.js';
import { generateDemoData } from './data.js';
import { RESET_SQL, SCHEMA_SQL, analyticsRoleSql } from './schema.js';

async function insertMany(client: DbClient, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const chunk = Math.max(1, Math.floor(30000 / columns.length));
  for (let start = 0; start < rows.length; start += chunk) {
    const slice = rows.slice(start, start + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
}

export async function ensureSchema(db: Db): Promise<void> {
  // Serialize concurrent starts (several servers may boot at once in docker compose).
  await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(424242)');
    await client.query(SCHEMA_SQL);
  });
}

export interface SeedSummary {
  employees: number;
  companies: number;
  contacts: number;
  deals: number;
  notes: number;
  tickets: number;
  comments: number;
  events: number;
  emails: number;
}

/** Drop the demo data and write it again (gateway clients, grants, keys and the audit log are kept). */
export async function seedDemo(db: Db): Promise<SeedSummary> {
  await ensureSchema(db);
  const data = generateDemoData();
  await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(424243)');
    await client.query(RESET_SQL);
    await insertMany(client, 'core.employees', ['id', 'name', 'email', 'role', 'title', 'region', 'timezone', 'can_sign_in'],
      data.employees.map((e) => [e.id, e.name, e.email, e.role, e.title, e.region, e.timezone, e.canSignIn]));
    await insertMany(client, 'crm.companies', ['id', 'name', 'domain', 'industry', 'region', 'plan', 'employees', 'arr_usd', 'owner_id', 'created_at'],
      data.companies.map((c) => [c.id, c.name, c.domain, c.industry, c.region, c.plan, c.employees, c.arrUsd, c.ownerId, c.createdAt]));
    await insertMany(client, 'crm.contacts', ['id', 'company_id', 'name', 'title', 'email', 'phone', 'created_at'],
      data.contacts.map((c) => [c.id, c.companyId, c.name, c.title, c.email, c.phone, c.createdAt]));
    await insertMany(client, 'crm.deals', ['id', 'company_id', 'name', 'stage', 'amount_usd', 'region', 'owner_id', 'expected_close', 'created_at', 'stage_changed_at', 'closed_at'],
      data.deals.map((d) => [d.id, d.companyId, d.name, d.stage, d.amountUsd, d.region, d.ownerId, d.expectedClose, d.createdAt, d.stageChangedAt, d.closedAt]));
    await insertMany(client, 'crm.deal_stage_history', ['deal_id', 'from_stage', 'to_stage', 'changed_at', 'changed_by'],
      data.deals.flatMap((d) => d.history.map((h) => [d.id, h.from, h.to, h.at, h.by])));
    await insertMany(client, 'crm.notes', ['id', 'company_id', 'deal_id', 'author_id', 'body', 'created_at'],
      data.notes.map((n) => [n.id, n.companyId, n.dealId, n.authorId, n.body, n.createdAt]));
    await insertMany(client, 'helpdesk.tickets', ['id', 'company_id', 'requester_contact_id', 'subject', 'body', 'status', 'priority', 'channel', 'assignee_id', 'created_at', 'updated_at', 'resolved_at'],
      data.tickets.map((t) => [t.id, t.companyId, t.requesterContactId, t.subject, t.body, t.status, t.priority, t.channel, t.assigneeId, t.createdAt, t.updatedAt, t.resolvedAt]));
    await insertMany(client, 'helpdesk.comments', ['id', 'ticket_id', 'author_type', 'author_name', 'body', 'internal', 'created_at'],
      data.comments.map((c) => [c.id, c.ticketId, c.authorType, c.authorName, c.body, c.internal, c.createdAt]));
    await insertMany(client, 'workspace.events', ['id', 'owner_id', 'title', 'starts_at', 'ends_at', 'attendees', 'description', 'company_id', 'created_at'],
      data.events.map((e) => [e.id, e.ownerId, e.title, e.startsAt, e.endsAt, e.attendees, e.description, e.companyId, e.startsAt]));
    await insertMany(client, 'workspace.emails', ['id', 'author_id', 'to_addresses', 'subject', 'body', 'status', 'related_ticket', 'related_deal', 'created_at', 'submitted_at', 'decided_at', 'decided_by'],
      data.emails.map((m) => [m.id, m.authorId, m.to, m.subject, m.body, m.status, m.relatedTicket, m.relatedDeal, m.createdAt, m.submittedAt, m.decidedAt, m.decidedBy]));
    await insertMany(client, 'workspace.sandbox_mailbox', ['email_id', 'delivered_at'],
      data.emails.filter((m) => m.status === 'approved').map((m) => [m.id, m.decidedAt]));
  });
  return {
    employees: data.employees.length,
    companies: data.companies.length,
    contacts: data.contacts.length,
    deals: data.deals.length,
    notes: data.notes.length,
    tickets: data.tickets.length,
    comments: data.comments.length,
    events: data.events.length,
    emails: data.emails.length,
  };
}

export async function setupAnalyticsRole(db: Db, role: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(role)) throw new Error(`invalid analytics role name: ${role}`);
  await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(424244)');
    await client.query(analyticsRoleSql(role, password));
  });
}

/** True when the demo data is present (used to seed on first start only). */
export async function isSeeded(db: Db): Promise<boolean> {
  await ensureSchema(db);
  const result = await db.query('SELECT count(*)::int AS n FROM crm.companies');
  return (result.rows[0] as { n: number }).n > 0;
}
