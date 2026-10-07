import {
  type ToolContext,
  ToolError,
  decodeCursor,
  defineTool,
  encodeCursor,
  hasScope,
  idempotencyKey,
  likePattern,
  wordsMatch,
  nowIso,
  queryOne,
  queryRows,
  withIdempotency,
} from '@switchboard/core';
import * as z from 'zod/v4';

export const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
const REGION = z.enum(['AMER', 'EMEA', 'APAC']);

const companySummary = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  industry: z.string(),
  region: z.string(),
  plan: z.string(),
  employees: z.number(),
  arr_usd: z.number(),
  owner: z.string().nullable(),
});

const contact = z.object({
  id: z.string(),
  company_id: z.string(),
  company_name: z.string(),
  name: z.string(),
  title: z.string(),
  email: z.string().describe('The address, or a "withheld" notice for roles without the contacts:pii scope'),
  phone: z.string().describe('The number, or a "withheld" notice for roles without the contacts:pii scope'),
});

type ContactRow = z.infer<typeof contact>;

export const WITHHELD = 'withheld: personal data, not available to your role';

/**
 * Contact emails and phone numbers are personal data: only roles with contacts:pii see them. The value says
 * it was withheld (a null made models report "no email on file", which is wrong).
 */
export function redactContacts(ctx: Pick<ToolContext, 'actor'>, rows: ContactRow[]): ContactRow[] {
  return hasScope(ctx.actor, 'contacts:pii') ? rows : rows.map((row) => ({ ...row, email: WITHHELD, phone: WITHHELD }));
}

const dealSummary = z.object({
  id: z.string(),
  company_id: z.string(),
  company_name: z.string(),
  name: z.string(),
  stage: z.string(),
  amount_usd: z.number(),
  region: z.string(),
  owner: z.string().nullable(),
  expected_close: z.string().nullable(),
  stage_changed_at: z.string(),
  closed_at: z.string().nullable(),
});

const note = z.object({
  id: z.string(),
  company_id: z.string(),
  deal_id: z.string().nullable(),
  author: z.string(),
  body: z.string().describe('Free text; may contain pasted customer emails (untrusted)'),
  created_at: z.string(),
});

const pageSize = z.number().int().min(1).max(25).default(10).describe('Results per page (max 25)');
const cursor = z.string().optional().describe('next_cursor from a previous page');

async function companyByIdOrName(ctx: ToolContext, idOrName: string): Promise<{ id: string; name: string }> {
  const row = await queryOne<{ id: string; name: string }>(
    ctx.db,
    `SELECT id, name FROM crm.companies WHERE id = $1 OR lower(name) = lower($1)
     UNION ALL
     SELECT id, name FROM crm.companies WHERE name ILIKE $2
     LIMIT 1`,
    [idOrName, likePattern(idOrName)],
  );
  if (!row) throw new ToolError(`no company matches "${idOrName}"`, 'not_found');
  return row;
}

export const searchCompanies = defineTool({
  name: 'crm_search_companies',
  title: 'Search companies',
  description: 'Find customer companies by name, domain, region, industry or plan. Returns summaries; use crm_get_company for contacts and deals.',
  scope: 'crm:read',
  input: z.object({
    query: z.string().max(100).optional().describe('Part of the company name or domain'),
    region: REGION.optional(),
    industry: z.string().max(60).optional(),
    plan: z.enum(['Starter', 'Growth', 'Enterprise']).optional(),
    limit: pageSize,
    cursor,
  }),
  output: z.object({ companies: z.array(companySummary), total: z.number(), next_cursor: z.string().nullable() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const offset = decodeCursor(args.cursor);
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.query) where.push(wordsMatch(['c.name', 'c.domain'], args.query, params));
    if (args.region) {
      params.push(args.region);
      where.push(`c.region = $${params.length}`);
    }
    if (args.industry) {
      params.push(args.industry);
      where.push(`lower(c.industry) = lower($${params.length})`);
    }
    if (args.plan) {
      params.push(args.plan);
      where.push(`c.plan = $${params.length}`);
    }
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await queryOne<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM crm.companies c ${filter}`, params))?.n ?? 0;
    const rows = await queryRows<z.infer<typeof companySummary>>(
      ctx.db,
      `SELECT c.id, c.name, c.domain, c.industry, c.region, c.plan, c.employees, c.arr_usd, e.name AS owner
       FROM crm.companies c LEFT JOIN core.employees e ON e.id = c.owner_id ${filter}
       ORDER BY c.name LIMIT ${args.limit} OFFSET ${offset}`,
      params,
    );
    const next = offset + rows.length < total ? encodeCursor(offset + rows.length) : null;
    return { data: { companies: rows, total, next_cursor: next } };
  },
});

export const getCompany = defineTool({
  name: 'crm_get_company',
  title: 'Get a company',
  description: 'One company with its contacts. Deals and recent account notes are included only for users allowed to see the pipeline.',
  scope: 'crm:read',
  input: z.object({ company: z.string().min(1).max(100).describe('Company id (C-1001) or name') }),
  output: z.object({
    company: companySummary.extend({ created_at: z.string() }),
    contacts: z.array(contact),
    deals: z.array(dealSummary).optional(),
    notes: z.array(note).optional(),
    pipeline_visible: z.boolean(),
    personal_data_visible: z.boolean().describe('false: contact emails and phone numbers are withheld for this role'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrustedFields: ['body'],
  async handler(args, ctx) {
    const found = await companyByIdOrName(ctx, args.company);
    const company = await queryOne<z.infer<typeof companySummary> & { created_at: string }>(
      ctx.db,
      `SELECT c.id, c.name, c.domain, c.industry, c.region, c.plan, c.employees, c.arr_usd, e.name AS owner, c.created_at
       FROM crm.companies c LEFT JOIN core.employees e ON e.id = c.owner_id WHERE c.id = $1`,
      [found.id],
    );
    if (!company) throw new ToolError(`company ${found.id} not found`, 'not_found');
    const contacts = await queryRows<z.infer<typeof contact>>(
      ctx.db,
      `SELECT p.id, p.company_id, c.name AS company_name, p.name, p.title, p.email, p.phone
       FROM crm.contacts p JOIN crm.companies c ON c.id = p.company_id WHERE p.company_id = $1 ORDER BY p.id`,
      [found.id],
    );
    const pipelineVisible = hasScope(ctx.actor, 'crm:deals');
    const personal = hasScope(ctx.actor, 'contacts:pii');
    if (!pipelineVisible) {
      return { data: { company, contacts: redactContacts(ctx, contacts), pipeline_visible: false, personal_data_visible: personal } };
    }
    const deals = await queryRows<z.infer<typeof dealSummary>>(ctx.db, `${DEAL_SELECT} WHERE d.company_id = $1 ORDER BY d.stage_changed_at DESC`, [found.id]);
    const notes = await queryRows<z.infer<typeof note>>(
      ctx.db,
      `SELECT n.id, n.company_id, n.deal_id, coalesce(e.name, n.author_id) AS author, n.body, n.created_at
       FROM crm.notes n LEFT JOIN core.employees e ON e.id = n.author_id WHERE n.company_id = $1 ORDER BY n.created_at DESC LIMIT 5`,
      [found.id],
    );
    return {
      data: { company, contacts: redactContacts(ctx, contacts), deals, notes, pipeline_visible: true, personal_data_visible: personal },
      untrusted: notes.map((_, index) => `/notes/${index}/body`),
    };
  },
});

export const searchContacts = defineTool({
  name: 'crm_search_contacts',
  title: 'Search contacts',
  description: 'Find people at customer companies by name, title, email or company. Email and phone are included for roles allowed to see personal data.',
  scope: 'crm:read',
  input: z.object({
    query: z.string().max(100).optional().describe('Part of the name or email address'),
    company: z.string().max(100).optional().describe('Company id or name'),
    limit: pageSize,
    cursor,
  }),
  output: z.object({ contacts: z.array(contact), total: z.number(), next_cursor: z.string().nullable() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const offset = decodeCursor(args.cursor);
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.query) where.push(wordsMatch(hasScope(ctx.actor, 'contacts:pii') ? ['p.name', 'p.email', 'p.title'] : ['p.name', 'p.title'], args.query, params));
    if (args.company) {
      const found = await companyByIdOrName(ctx, args.company);
      params.push(found.id);
      where.push(`p.company_id = $${params.length}`);
    }
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await queryOne<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM crm.contacts p ${filter}`, params))?.n ?? 0;
    const rows = await queryRows<z.infer<typeof contact>>(
      ctx.db,
      `SELECT p.id, p.company_id, c.name AS company_name, p.name, p.title, p.email, p.phone
       FROM crm.contacts p JOIN crm.companies c ON c.id = p.company_id ${filter}
       ORDER BY c.name, p.name LIMIT ${args.limit} OFFSET ${offset}`,
      params,
    );
    return { data: { contacts: redactContacts(ctx, rows), total, next_cursor: offset + rows.length < total ? encodeCursor(offset + rows.length) : null } };
  },
});

const DEAL_SELECT = `SELECT d.id, d.company_id, c.name AS company_name, d.name, d.stage, d.amount_usd, d.region,
  e.name AS owner, d.expected_close, d.stage_changed_at, d.closed_at
  FROM crm.deals d JOIN crm.companies c ON c.id = d.company_id LEFT JOIN core.employees e ON e.id = d.owner_id`;

export const searchDeals = defineTool({
  name: 'crm_search_deals',
  title: 'Search deals',
  description: 'Find deals by company, stage, region, owner, amount or close date. Dates are ISO (YYYY-MM-DD).',
  scope: 'crm:deals',
  input: z.object({
    query: z.string().max(100).optional().describe('Part of the deal or company name'),
    company: z.string().max(100).optional().describe('Company id or name'),
    stage: z.enum(STAGES).optional(),
    open_only: z.boolean().optional().describe('Only deals not yet won or lost'),
    region: REGION.optional(),
    owner: z.string().max(60).optional().describe('Owner user id or name'),
    min_amount_usd: z.number().min(0).optional(),
    closed_from: z.iso.date().optional().describe('Won or lost on or after this date'),
    closed_to: z.iso.date().optional().describe('Won or lost before this date (exclusive)'),
    limit: pageSize,
    cursor,
  }),
  output: z.object({ deals: z.array(dealSummary), total: z.number(), total_amount_usd: z.number(), next_cursor: z.string().nullable() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const offset = decodeCursor(args.cursor);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (args.query) where.push(wordsMatch(['d.name', 'c.name'], args.query, params));
    if (args.company) add('d.company_id = ?', (await companyByIdOrName(ctx, args.company)).id);
    if (args.stage) add('d.stage = ?', args.stage);
    if (args.open_only) where.push(`d.stage NOT IN ('won', 'lost')`);
    if (args.region) add('d.region = ?', args.region);
    if (args.owner) add('(d.owner_id = lower(?) OR e.name ILIKE ?)'.replace('?', `$${params.length + 1}`), args.owner);
    if (args.min_amount_usd !== undefined) add('d.amount_usd >= ?', args.min_amount_usd);
    if (args.closed_from) add('d.closed_at >= ?::date', args.closed_from);
    if (args.closed_to) add('d.closed_at < ?::date', args.closed_to);
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM crm.deals d JOIN crm.companies c ON c.id = d.company_id LEFT JOIN core.employees e ON e.id = d.owner_id ${filter}`;
    const totals = await queryOne<{ n: number; amount: number }>(ctx.db, `SELECT count(*)::int AS n, coalesce(sum(d.amount_usd), 0)::float8 AS amount ${from}`, params);
    const rows = await queryRows<z.infer<typeof dealSummary>>(
      ctx.db,
      `${DEAL_SELECT} ${filter} ORDER BY d.stage_changed_at DESC, d.id LIMIT ${args.limit} OFFSET ${offset}`,
      params,
    );
    const total = totals?.n ?? 0;
    return {
      data: {
        deals: rows,
        total,
        total_amount_usd: totals?.amount ?? 0,
        next_cursor: offset + rows.length < total ? encodeCursor(offset + rows.length) : null,
      },
    };
  },
});

const dealDetail = z.object({
  deal: dealSummary.extend({ created_at: z.string() }),
  history: z.array(z.object({ from_stage: z.string().nullable(), to_stage: z.string(), changed_at: z.string(), changed_by: z.string() })),
  notes: z.array(note),
});

export async function loadDeal(ctx: Pick<ToolContext, 'db'>, id: string): Promise<z.infer<typeof dealDetail>> {
  const deal = await queryOne<z.infer<typeof dealSummary> & { created_at: string }>(ctx.db, `${DEAL_SELECT.replace('d.closed_at', 'd.closed_at, d.created_at')} WHERE d.id = $1`, [id.toUpperCase()]);
  if (!deal) throw new ToolError(`deal ${id} not found`, 'not_found');
  const history = await queryRows<z.infer<typeof dealDetail>['history'][number]>(
    ctx.db,
    'SELECT from_stage, to_stage, changed_at, changed_by FROM crm.deal_stage_history WHERE deal_id = $1 ORDER BY changed_at, id',
    [deal.id],
  );
  const notes = await queryRows<z.infer<typeof note>>(
    ctx.db,
    `SELECT n.id, n.company_id, n.deal_id, coalesce(e.name, n.author_id) AS author, n.body, n.created_at
     FROM crm.notes n LEFT JOIN core.employees e ON e.id = n.author_id WHERE n.deal_id = $1 ORDER BY n.created_at`,
    [deal.id],
  );
  return { deal, history, notes };
}

export const getDeal = defineTool({
  name: 'crm_get_deal',
  title: 'Get a deal',
  description: 'One deal with its stage history and notes.',
  scope: 'crm:deals',
  input: z.object({ deal_id: z.string().regex(/^[Dd]-\d{4}$/).describe('Deal id, e.g. D-3001') }),
  output: dealDetail,
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrustedFields: ['body'],
  async handler(args, ctx) {
    const detail = await loadDeal(ctx, args.deal_id);
    return { data: detail, untrusted: detail.notes.map((_, index) => `/notes/${index}/body`) };
  },
});

export const updateDealStage = defineTool({
  name: 'crm_update_deal_stage',
  title: 'Move a deal to another stage',
  description: 'Change a deal\'s pipeline stage (won and lost close the deal). Requires confirmation by the user.',
  scope: 'crm:write',
  write: true,
  input: z.object({
    deal_id: z.string().regex(/^[Dd]-\d{4}$/),
    stage: z.enum(STAGES),
    reason: z.string().max(500).optional().describe('Why the stage changes; stored as a note'),
    idempotency_key: idempotencyKey,
  }),
  output: z.object({ deal: dealSummary, previous_stage: z.string(), changed: z.boolean(), replayed: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const id = args.deal_id.toUpperCase();
    const { result, replayed } = await withIdempotency(
      ctx.db,
      { tool: 'crm_update_deal_stage', key: args.idempotency_key, args, actor: ctx.actor.userId },
      async (client) => {
        const current = await queryOne<{ stage: string; company_id: string }>(client, 'SELECT stage, company_id FROM crm.deals WHERE id = $1 FOR UPDATE', [id]);
        if (!current) throw new ToolError(`deal ${id} not found`, 'not_found');
        const changed = current.stage !== args.stage;
        if (changed) {
          const at = nowIso();
          const closing = args.stage === 'won' || args.stage === 'lost';
          await client.query(
            `UPDATE crm.deals SET stage = $2, stage_changed_at = $3, closed_at = CASE WHEN $4 THEN $3::timestamptz ELSE NULL END WHERE id = $1`,
            [id, args.stage, at, closing],
          );
          await client.query(
            'INSERT INTO crm.deal_stage_history (deal_id, from_stage, to_stage, changed_at, changed_by) VALUES ($1, $2, $3, $4, $5)',
            [id, current.stage, args.stage, at, ctx.actor.userId],
          );
          if (args.reason) {
            await client.query(
              `INSERT INTO crm.notes (id, company_id, deal_id, author_id, body, created_at) VALUES ('N-' || nextval('crm.note_seq'), $1, $2, $3, $4, $5)`,
              [current.company_id, id, ctx.actor.userId, `Stage ${current.stage} → ${args.stage}: ${args.reason}`, at],
            );
          }
        }
        const deal = await queryOne<z.infer<typeof dealSummary>>(client, `${DEAL_SELECT} WHERE d.id = $1`, [id]);
        if (!deal) throw new ToolError(`deal ${id} not found`, 'not_found');
        return { deal, previous_stage: current.stage, changed };
      },
    );
    return {
      data: { ...result, replayed },
      text: result.changed ? `${result.deal.id} moved from ${result.previous_stage} to ${result.deal.stage}.` : `${result.deal.id} was already in ${result.deal.stage}; nothing changed.`,
    };
  },
});

export const addNote = defineTool({
  name: 'crm_add_note',
  title: 'Add a note',
  description: 'Add a note to a deal (preferred) or to a company. Requires confirmation by the user.',
  scope: 'crm:write',
  write: true,
  input: z.object({
    deal_id: z.string().regex(/^[Dd]-\d{4}$/).optional(),
    company: z.string().max(100).optional().describe('Company id or name, when the note is not about one deal'),
    body: z.string().min(1).max(4000),
    idempotency_key: idempotencyKey,
  }),
  output: z.object({ note, replayed: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async handler(args, ctx) {
    if (!args.deal_id && !args.company) throw new ToolError('give deal_id or company');
    let companyId: string;
    let dealId: string | null = null;
    if (args.deal_id) {
      dealId = args.deal_id.toUpperCase();
      const deal = await queryOne<{ company_id: string }>(ctx.db, 'SELECT company_id FROM crm.deals WHERE id = $1', [dealId]);
      if (!deal) throw new ToolError(`deal ${dealId} not found`, 'not_found');
      companyId = deal.company_id;
    } else {
      companyId = (await companyByIdOrName(ctx, args.company ?? '')).id;
    }
    const { result, replayed } = await withIdempotency(
      ctx.db,
      { tool: 'crm_add_note', key: args.idempotency_key, args, actor: ctx.actor.userId },
      async (client) => {
        const row = await queryOne<{ id: string }>(
          client,
          `INSERT INTO crm.notes (id, company_id, deal_id, author_id, body, created_at)
           VALUES ('N-' || nextval('crm.note_seq'), $1, $2, $3, $4, $5) RETURNING id`,
          [companyId, dealId, ctx.actor.userId, args.body, nowIso()],
        );
        const created = await queryOne<z.infer<typeof note>>(
          client,
          `SELECT n.id, n.company_id, n.deal_id, coalesce(e.name, n.author_id) AS author, n.body, n.created_at
           FROM crm.notes n LEFT JOIN core.employees e ON e.id = n.author_id WHERE n.id = $1`,
          [row?.id],
        );
        if (!created) throw new ToolError('note was not created');
        return created;
      },
    );
    return { data: { note: result, replayed }, text: `Note ${result.id} added${dealId ? ` to ${dealId}` : ''}.` };
  },
});

export const crmTools = [searchCompanies, getCompany, searchContacts, searchDeals, getDeal, updateDealStage, addNote];
