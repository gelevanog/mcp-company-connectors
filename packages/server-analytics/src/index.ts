import { McpServer } from '@modelcontextprotocol/server';
import {
  ANALYTICS_TABLES,
  type Actor,
  type Db,
  META,
  ToolError,
  createPool,
  databaseUrl,
  defineTool,
  queryRows,
  registerTools,
  today,
  type AnyToolSpec,
} from '@switchboard/core';
import * as z from 'zod/v4';

import { FIXABLE, validateSql } from './validator.js';

export { FIXABLE, pinDates, validateSql, type ValidationResult, type Violation, type ViolationCode } from './validator.js';

export interface AnalyticsServerOptions {
  /** Owner connection: schema introspection only. */
  db: Db;
  /** Read-only login every generated query runs as (column grants without personal data). */
  readerDb: Db;
  fallbackActor?: Actor;
  maxRows?: number;
  statementTimeoutMs?: number;
}

/** postgresql://switchboard_analytics:...@host/db, derived from DATABASE_URL unless ANALYTICS_DATABASE_URL is set. */
export function analyticsDatabaseUrl(): string {
  if (process.env.ANALYTICS_DATABASE_URL) return process.env.ANALYTICS_DATABASE_URL;
  const url = new URL(databaseUrl());
  url.username = process.env.ANALYTICS_DB_ROLE ?? 'switchboard_analytics';
  url.password = process.env.ANALYTICS_DB_PASSWORD ?? 'switchboard_analytics';
  return url.toString();
}

export function createReaderPool(): Db {
  return createPool(analyticsDatabaseUrl(), 5);
}

const TABLE_NOTES: Record<string, string> = {
  'crm.companies': 'Customer companies. arr_usd = current annual recurring revenue (0 for prospects). region: AMER | EMEA | APAC.',
  'crm.contacts': 'People at customer companies (email and phone are personal data and not available).',
  'crm.deals': "Pipeline. stage: lead | qualified | proposal | negotiation | won | lost. closed_at is set when a deal is won or lost. amount_usd in USD.",
  'crm.deal_stage_history': 'Every stage change of every deal (to_stage = won with changed_at = when it was won).',
  'helpdesk.tickets': 'Support tickets. status: open | pending | resolved | closed. priority: low | normal | high | urgent. body is not available.',
  'core.employees': 'Kestrel employees (owner_id, assignee_id and changed_by refer to employees.id).',
};

interface ColumnInfo {
  table: string;
  column: string;
  type: string;
}

async function runReadOnly(
  reader: Db,
  sql: string,
  params: unknown[],
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<{ rows: Record<string, unknown>[]; fields: string[] }> {
  const client = await reader.connect();
  let pid: number | undefined;
  const cancel = () => {
    if (pid === undefined) return;
    void reader.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
  };
  try {
    pid = ((await client.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid;
    options.signal.addEventListener('abort', cancel, { once: true });
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(options.timeoutMs))}`);
    await client.query(`SET LOCAL search_path = crm, helpdesk, core`);
    await client.query(`SET LOCAL TIME ZONE 'UTC'`);
    const result = await client.query(sql, params);
    return { rows: result.rows as Record<string, unknown>[], fields: result.fields.map((field) => field.name) };
  } catch (error) {
    if (options.signal.aborted) throw new ToolError('query cancelled by the client', 'cancelled');
    const message = error instanceof Error ? error.message : String(error);
    if (/statement timeout/i.test(message)) throw new ToolError(`query exceeded the ${options.timeoutMs} ms time limit`, 'timeout');
    if (/permission denied/i.test(message)) throw new ToolError(`the read-only analytics login refused the query: ${message}`, 'permission_denied');
    throw new ToolError(`PostgreSQL error: ${message}`, 'sql_error');
  } finally {
    options.signal.removeEventListener('abort', cancel);
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

export function analyticsTools(options: AnalyticsServerOptions): AnyToolSpec[] {
  const maxRows = options.maxRows ?? Number(process.env.ANALYTICS_MAX_ROWS ?? 200);
  const timeoutMs = options.statementTimeoutMs ?? Number(process.env.ANALYTICS_STATEMENT_TIMEOUT_MS ?? 5000);

  const describeSchema = defineTool({
    name: 'analytics_describe_schema',
    title: 'Describe the analytics schema',
    description: 'Tables, columns and value sets available to analytics_query. Call this before writing SQL.',
    scope: 'analytics:query',
    input: z.object({}),
    output: z.object({
      today: z.string(),
      dialect: z.string(),
      max_rows: z.number(),
      tables: z.array(z.object({
        name: z.string(),
        description: z.string(),
        row_count: z.number(),
        columns: z.array(z.object({ name: z.string(), type: z.string() })),
        unavailable_columns: z.array(z.string()),
      })),
      rules: z.array(z.string()),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async handler() {
      const columns = await queryRows<ColumnInfo>(
        options.db,
        `SELECT table_schema || '.' || table_name AS table, column_name AS column, data_type AS type
         FROM information_schema.columns WHERE table_schema IN ('crm', 'helpdesk', 'core') ORDER BY table_schema, table_name, ordinal_position`,
      );
      const tables = [];
      for (const [name, spec] of Object.entries(ANALYTICS_TABLES)) {
        const count = await queryRows<{ n: number }>(options.db, `SELECT count(*)::int AS n FROM ${name}`);
        tables.push({
          name,
          description: TABLE_NOTES[name] ?? '',
          row_count: count[0]?.n ?? 0,
          columns: columns.filter((c) => c.table === name && spec.columns.includes(c.column)).map((c) => ({ name: c.column, type: c.type })),
          unavailable_columns: spec.denied,
        });
      }
      return {
        data: {
          today: today(),
          dialect: 'PostgreSQL 17',
          max_rows: maxRows,
          tables,
          rules: [
            'One read-only SELECT (or WITH ... SELECT) per call; no writes, no system catalogs.',
            'Personal data (contact email and phone) and customer-written text (ticket body) are not available; list columns explicitly.',
            `Results are capped at ${maxRows} rows; aggregate in SQL instead of fetching raw rows.`,
            `CURRENT_DATE and now() mean ${today()} in this demo. Timestamps are UTC.`,
            'Use half-open ranges for periods: closed_at >= DATE \'2026-09-01\' AND closed_at < DATE \'2026-10-01\'.',
          ],
        },
      };
    },
  });

  const query = defineTool({
    name: 'analytics_query',
    title: 'Run a read-only SQL query',
    description:
      'Run one read-only PostgreSQL SELECT over the analytics tables (see analytics_describe_schema). The query is validated ' +
      '(SELECT only, allowed tables and functions, no personal data), runs as a read-only login with a time limit, and is capped in rows.',
    scope: 'analytics:query',
    input: z.object({
      sql: z.string().min(1).max(8000).describe('One SELECT statement in PostgreSQL syntax'),
      max_rows: z.number().int().min(1).max(1000).optional().describe(`Row cap (default ${maxRows})`),
    }),
    output: z.object({
      columns: z.array(z.string()),
      rows: z.array(z.record(z.string(), z.unknown())),
      row_count: z.number(),
      truncated: z.boolean(),
      executed_sql: z.string(),
      duration_ms: z.number(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async handler(args, ctx) {
      const cap = args.max_rows ?? maxRows;
      const pinned = process.env.SWITCHBOARD_TODAY === '' ? undefined : today();
      const validation = validateSql(args.sql, { maxRows: cap, ...(pinned && { pinnedToday: pinned }) });
      if (!validation.ok || !validation.executableSql) {
        const fixable = validation.violations.every((v) => FIXABLE.has(v.code));
        const detail = validation.violations.map((v) => `[${v.code}] ${v.message}`).join('; ');
        throw new ToolError(`${fixable ? 'Query rejected (fix and retry)' : 'Query refused'}: ${detail}`, validation.violations[0]?.code ?? 'rejected');
      }
      await ctx.progress(1, 2, 'validated; running as the read-only analytics login');
      const started = performance.now();
      const result = await runReadOnly(options.readerDb, validation.executableSql, [], { timeoutMs, signal: ctx.signal });
      const duration = Math.round(performance.now() - started);
      await ctx.progress(2, 2, `${result.rows.length} rows`);
      const truncated = result.rows.length > cap;
      const rows = truncated ? result.rows.slice(0, cap) : result.rows;
      return {
        data: { columns: result.fields, rows, row_count: rows.length, truncated, executed_sql: validation.executableSql, duration_ms: duration },
        text: `${rows.length} row(s)${truncated ? ` (truncated at ${cap})` : ''} in ${duration} ms\n${JSON.stringify(rows.slice(0, 50), null, 1)}`,
      };
    },
  });

  const REPORTS = {
    pipeline_by_region: 'Open pipeline (count and amount) per region and stage',
    won_by_month: 'Deals won per month for the last 12 months, with amount',
    support_backlog: 'Open and pending tickets per priority and age bucket',
  } as const;

  const runReport = defineTool({
    name: 'analytics_run_report',
    title: 'Run a saved report',
    description: `Run one of the reviewed saved reports (with progress updates): ${Object.entries(REPORTS).map(([k, v]) => `${k} (${v})`).join('; ')}.`,
    scope: 'analytics:query',
    input: z.object({ report: z.enum(Object.keys(REPORTS) as [keyof typeof REPORTS, ...(keyof typeof REPORTS)[]]) }),
    output: z.object({ report: z.string(), description: z.string(), sections: z.array(z.object({ title: z.string(), rows: z.array(z.record(z.string(), z.unknown())) })) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async handler(args, ctx) {
      const run = (sql: string, params: unknown[] = []) => runReadOnly(options.readerDb, sql, params, { timeoutMs, signal: ctx.signal });
      const sections: { title: string; rows: Record<string, unknown>[] }[] = [];
      const day = today();
      if (args.report === 'pipeline_by_region') {
        const regions = ['AMER', 'EMEA', 'APAC'];
        for (const [index, region] of regions.entries()) {
          if (ctx.signal.aborted) throw new ToolError('report cancelled', 'cancelled');
          await ctx.progress(index, regions.length, `pipeline for ${region}`);
          const { rows } = await run(
            `SELECT stage, count(*)::int AS deals, sum(amount_usd)::float8 AS amount_usd FROM crm.deals
             WHERE region = $1 AND stage NOT IN ('won', 'lost') GROUP BY stage ORDER BY min(array_position(ARRAY['lead','qualified','proposal','negotiation'], stage))`,
            [region],
          );
          sections.push({ title: region, rows });
        }
      } else if (args.report === 'won_by_month') {
        const months: string[] = [];
        const base = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
        for (let i = 12; i >= 1; i -= 1) {
          const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
          months.push(d.toISOString().slice(0, 10));
        }
        const rows: Record<string, unknown>[] = [];
        for (const [index, month] of months.entries()) {
          if (ctx.signal.aborted) throw new ToolError('report cancelled', 'cancelled');
          await ctx.progress(index, months.length, `month ${month.slice(0, 7)}`);
          const { rows: monthRows } = await run(
            `SELECT $1::text AS month, count(*)::int AS deals_won, coalesce(sum(amount_usd), 0)::float8 AS amount_usd FROM crm.deals
             WHERE stage = 'won' AND closed_at >= $2::date AND closed_at < ($2::date + interval '1 month')`,
            [month.slice(0, 7), month],
          );
          rows.push(...monthRows);
        }
        sections.push({ title: 'Won per month', rows });
      } else {
        const priorities = ['urgent', 'high', 'normal', 'low'];
        for (const [index, priority] of priorities.entries()) {
          if (ctx.signal.aborted) throw new ToolError('report cancelled', 'cancelled');
          await ctx.progress(index, priorities.length, `backlog: ${priority}`);
          const { rows } = await run(
            `SELECT CASE WHEN $2::date - created_at::date <= 7 THEN '0-7 days' WHEN $2::date - created_at::date <= 30 THEN '8-30 days' ELSE 'over 30 days' END AS age,
                    count(*)::int AS tickets
             FROM helpdesk.tickets WHERE status IN ('open', 'pending') AND priority = $1 GROUP BY 1 ORDER BY 1`,
            [priority, day],
          );
          sections.push({ title: priority, rows });
        }
      }
      await ctx.progress(1, 1, 'done');
      return { data: { report: args.report, description: REPORTS[args.report], sections } };
    },
  });

  return [describeSchema, query, runReport];
}

export const ANALYTICS_INSTRUCTIONS =
  'Read-only analytics over Kestrel Cloud data. Call analytics_describe_schema first, then analytics_query with one ' +
  'PostgreSQL SELECT. Personal data is not available. Saved reports (analytics_run_report) are reviewed and report progress.';

export function createAnalyticsServer(options: AnalyticsServerOptions): McpServer {
  const server = new McpServer(
    { name: 'switchboard-analytics', title: 'Switchboard Analytics', version: '0.1.0' },
    { instructions: ANALYTICS_INSTRUCTIONS },
  );
  registerTools(server, analyticsTools(options), { db: options.db, fallbackActor: options.fallbackActor, serverName: 'analytics' });
  server.registerPrompt(
    'weekly_pipeline_review',
    {
      title: 'Weekly pipeline review',
      description: 'Summarize the open pipeline by region and stage and what was won recently.',
      _meta: { [META.scope]: 'analytics:query' },
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Run analytics_run_report with pipeline_by_region and won_by_month, then give me a short weekly pipeline review: ' +
              'open pipeline per region, the biggest stages, the last three months of wins, and anything unusual.',
          },
        },
      ],
    }),
  );
  return server;
}
