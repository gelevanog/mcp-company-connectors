import { ANALYTICS_TABLES } from '@switchboard/core';
import nodeSqlParser from 'node-sql-parser';

const { Parser } = nodeSqlParser;
const parser = new Parser();
const PARSE_OPTIONS = { database: 'PostgresQL' };

export type ViolationCode =
  | 'empty'
  | 'too_long'
  | 'parse_error'
  | 'multiple_statements'
  | 'not_select'
  | 'write_operation'
  | 'select_into'
  | 'table_not_allowed'
  | 'system_catalog'
  | 'function_not_allowed'
  | 'pii_column'
  | 'select_star_pii'
  | 'whole_row_reference';

/** Fixable violations go back to the model with a hint; the others are refused outright. */
export const FIXABLE: ReadonlySet<ViolationCode> = new Set(['parse_error', 'select_star_pii', 'table_not_allowed', 'function_not_allowed']);

export interface Violation {
  code: ViolationCode;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
  /** The SQL that runs: dates pinned, wrapped in an outer LIMIT. */
  executableSql?: string;
  tables: string[];
}

export interface ValidatorOptions {
  maxRows: number;
  /** YYYY-MM-DD; CURRENT_DATE, now() and friends become this date (the demo's "today"). */
  pinnedToday?: string;
}

const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'every', 'stddev', 'stddev_pop',
  'stddev_samp', 'variance', 'var_pop', 'var_samp', 'percentile_cont', 'percentile_disc', 'mode', 'corr',
  // window
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value',
  // math
  'round', 'floor', 'ceil', 'ceiling', 'abs', 'sign', 'power', 'sqrt', 'mod', 'trunc', 'ln', 'log', 'exp', 'greatest', 'least',
  'div', 'width_bucket',
  // null handling and conditionals
  'coalesce', 'nullif',
  // text
  'lower', 'upper', 'initcap', 'length', 'char_length', 'trim', 'btrim', 'ltrim', 'rtrim', 'substring', 'substr', 'left', 'right',
  'concat', 'concat_ws', 'replace', 'split_part', 'position', 'strpos', 'lpad', 'rpad', 'format', 'starts_with',
  // dates
  'date_trunc', 'date_part', 'extract', 'to_char', 'to_date', 'age', 'make_date', 'make_interval', 'justify_days',
  'justify_interval', 'date_bin', 'isfinite',
  // sets
  'generate_series',
]);

const DENIED_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'gateway', 'workspace', 'pg_toast']);

const WRITE_TYPES = new Set([
  'insert', 'update', 'delete', 'replace', 'drop', 'create', 'alter', 'truncate', 'rename', 'grant', 'revoke', 'lock',
  'transaction', 'set', 'call', 'exec', 'execute', 'load', 'copy', 'merge', 'use', 'show', 'explain', 'declare',
]);

/** Map of allowed table → denied (personal-data or free-text) columns. Unqualified names resolve by table name. */
function allowedTables(): Map<string, Set<string>> {
  return new Map(Object.entries(ANALYTICS_TABLES).map(([name, spec]) => [name, new Set(spec.denied)]));
}

/** Replace CURRENT_DATE / CURRENT_TIMESTAMP / LOCALTIMESTAMP / now() outside strings, identifiers and comments. */
export function pinDates(sql: string, today: string): string {
  const date = `DATE '${today}'`;
  const timestamp = `TIMESTAMPTZ '${today}T12:00:00Z'`;
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const rest = sql.slice(i);
    const prev = i > 0 ? (sql[i - 1] ?? '') : '';
    if (!/[A-Za-z0-9_$.]/.test(prev)) {
      const match = /^(current_date|current_timestamp|localtimestamp|now\s*\(\s*\))(?![A-Za-z0-9_$])/i.exec(rest);
      if (match) {
        out += match[1]?.toLowerCase() === 'current_date' ? date : timestamp;
        i += match[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function functionName(node: Node): string | undefined {
  const name = node.name;
  if (typeof name === 'string') return name.toLowerCase();
  if (isNode(name) && Array.isArray(name.name)) {
    return name.name
      .map((part) => (isNode(part) && typeof part.value === 'string' ? part.value : ''))
      .join('.')
      .toLowerCase();
  }
  return undefined;
}

interface Walk {
  functions: Set<string>;
  types: Set<string>;
  cteNames: Set<string>;
  tableRefs: { db: string | null; table: string; alias: string | null }[];
  selectInto: boolean;
}

function walk(value: unknown, state: Walk): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, state);
    return;
  }
  if (!isNode(value)) return;
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : undefined;
  if (type) state.types.add(type);
  if (type === 'function' || type === 'aggr_func') {
    const name = functionName(value);
    if (name) state.functions.add(name);
  }
  if (type === 'extract') state.functions.add('extract');
  if (isNode(value.into) && value.into.position !== null && value.into.position !== undefined) state.selectInto = true;
  if (Array.isArray(value.with)) {
    for (const cte of value.with) {
      if (isNode(cte) && isNode(cte.name) && typeof cte.name.value === 'string') state.cteNames.add(cte.name.value.toLowerCase());
    }
  }
  if (Array.isArray(value.from)) {
    for (const ref of value.from) {
      if (isNode(ref) && typeof ref.table === 'string') {
        state.tableRefs.push({
          db: typeof ref.db === 'string' ? ref.db.toLowerCase() : null,
          table: ref.table.toLowerCase(),
          alias: typeof ref.as === 'string' ? ref.as.toLowerCase() : null,
        });
      }
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'tableList' || key === 'columnList') continue;
    walk(child, state);
  }
}

export function validateSql(input: string, options: ValidatorOptions): ValidationResult {
  const violations: Violation[] = [];
  const fail = (code: ViolationCode, message: string): ValidationResult => ({ ok: false, violations: [...violations, { code, message }], tables: [] });
  let sql = input.trim().replace(/;\s*$/, '');
  if (sql === '') return fail('empty', 'empty query');
  if (sql.length > 8000) return fail('too_long', 'query is longer than 8,000 characters');
  if (options.pinnedToday) sql = pinDates(sql, options.pinnedToday);

  let ast: unknown;
  try {
    ast = parser.astify(sql, PARSE_OPTIONS);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] ?? 'syntax error' : 'syntax error';
    return fail('parse_error', `could not parse the query (PostgreSQL dialect): ${message.slice(0, 300)}`);
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) return fail('multiple_statements', 'exactly one statement is allowed');
  const statement = statements[0];
  if (!isNode(statement)) return fail('parse_error', 'could not parse the query');

  const state: Walk = { functions: new Set(), types: new Set(), cteNames: new Set(), tableRefs: [], selectInto: false };
  walk(statement, state);
  const writes = [...state.types].filter((type) => WRITE_TYPES.has(type));
  if (writes.length > 0) return fail('write_operation', `only reading is allowed; found ${writes.join(', ').toUpperCase()}`);
  if (String(statement.type).toLowerCase() !== 'select') return fail('not_select', 'only SELECT (or WITH ... SELECT) queries are allowed');
  if (state.selectInto) return fail('select_into', 'SELECT INTO is not allowed');

  const allowed = allowedTables();
  const byName = new Map([...allowed.keys()].map((qualified) => [qualified.split('.')[1] ?? qualified, qualified]));
  const referenced = new Map<string, Set<string>>(); // qualified table -> denied columns
  const aliases = new Set<string>();
  for (const ref of state.tableRefs) {
    if (ref.db && DENIED_SCHEMAS.has(ref.db)) return fail('system_catalog', `${ref.db}.${ref.table} is not available to analytics queries`);
    if (!ref.db && (ref.table.startsWith('pg_') || DENIED_SCHEMAS.has(ref.table))) return fail('system_catalog', `${ref.table} is not available to analytics queries`);
    if (!ref.db && state.cteNames.has(ref.table)) continue;
    const qualified = ref.db ? `${ref.db}.${ref.table}` : byName.get(ref.table);
    const denied = qualified ? allowed.get(qualified) : undefined;
    if (!qualified || !denied) {
      violations.push({
        code: 'table_not_allowed',
        message: `${ref.db ? `${ref.db}.` : ''}${ref.table} is not an analytics table. Allowed: ${[...allowed.keys()].join(', ')}`,
      });
      continue;
    }
    referenced.set(qualified, denied);
    aliases.add(ref.table);
    if (ref.alias) aliases.add(ref.alias);
  }

  const deniedFunctions = [...state.functions].filter((name) => !ALLOWED_FUNCTIONS.has(name));
  if (deniedFunctions.length > 0) {
    violations.push({ code: 'function_not_allowed', message: `functions not allowed: ${deniedFunctions.join(', ')}` });
  }

  const deniedColumns = new Set<string>();
  for (const columns of referenced.values()) for (const column of columns) deniedColumns.add(column);
  let columnList: string[] = [];
  try {
    columnList = parser.columnList(sql, PARSE_OPTIONS);
  } catch {
    columnList = [];
  }
  for (const entry of columnList) {
    const column = (entry.split('::')[2] ?? '').replace(/^"|"$/g, '').toLowerCase();
    if (column === '(.*)') {
      const withPii = [...referenced.entries()].filter(([, denied]) => denied.size > 0).map(([table]) => table);
      if (withPii.length > 0) {
        violations.push({
          code: 'select_star_pii',
          message: `SELECT * would include personal data or customer-written text from ${withPii.join(', ')}; list the columns you need`,
        });
      }
      continue;
    }
    if (deniedColumns.has(column)) {
      violations.push({ code: 'pii_column', message: `column "${column}" holds personal data or customer-written text and is not available` });
    } else if (aliases.has(column) && [...referenced.values()].some((denied) => denied.size > 0)) {
      violations.push({ code: 'whole_row_reference', message: `whole-row reference "${column}" would expose every column` });
    }
  }

  const unique = violations.filter((v, index) => violations.findIndex((w) => w.code === v.code && w.message === v.message) === index);
  if (unique.length > 0) return { ok: false, violations: unique, tables: [...referenced.keys()] };
  const limit = Math.max(1, Math.min(options.maxRows, 1000));
  return {
    ok: true,
    violations: [],
    tables: [...referenced.keys()],
    executableSql: `SELECT * FROM (\n${sql}\n) AS switchboard_query LIMIT ${limit + 1}`,
  };
}
