import { describe, expect, it } from 'vitest';

import { pinDates, validateSql } from '../src/validator.js';

const ok = (sql: string) => validateSql(sql, { maxRows: 200, pinnedToday: '2026-10-01' });
const codes = (sql: string) => ok(sql).violations.map((v) => v.code);

describe('SQL validator', () => {
  it.each([
    "SELECT region, count(*) FROM crm.deals WHERE stage = 'won' GROUP BY region",
    'SELECT d.name, c.name FROM crm.deals d JOIN crm.companies c ON c.id = d.company_id ORDER BY d.amount_usd DESC',
    "WITH w AS (SELECT owner_id, count(*) AS n FROM crm.deals WHERE stage = 'won' GROUP BY 1) SELECT e.name, w.n FROM w JOIN core.employees e ON e.id = w.owner_id",
    "SELECT date_trunc('month', closed_at) AS m, sum(amount_usd) FROM deals WHERE closed_at >= CURRENT_DATE - interval '1 year' GROUP BY 1",
    "SELECT count(*) FILTER (WHERE stage = 'won') AS won, count(*) AS closed FROM crm.deals WHERE stage IN ('won', 'lost')",
    'SELECT name, rank() OVER (ORDER BY arr_usd DESC) FROM crm.companies',
    'SELECT p.name, p.title, c.name FROM crm.contacts p JOIN crm.companies c ON c.id = p.company_id',
    "SELECT round(avg(extract(epoch FROM closed_at - created_at) / 86400)::numeric, 1) FROM crm.deals WHERE stage = 'won'",
    'SELECT priority, count(*) FROM helpdesk.tickets GROUP BY priority -- trailing comment',
    'SELECT 1;',
  ])('accepts %s', (sql) => {
    const result = ok(sql);
    expect(result.violations).toEqual([]);
    expect(result.executableSql).toMatch(/LIMIT 201$/);
  });

  it.each([
    ['DELETE FROM crm.deals', 'write_operation'],
    ["UPDATE crm.deals SET stage = 'won'", 'write_operation'],
    ["INSERT INTO crm.notes (id) VALUES ('x')", 'write_operation'],
    ['DROP TABLE crm.deals', 'write_operation'],
    ['TRUNCATE crm.deals', 'write_operation'],
    ['SELECT 1; DROP TABLE crm.deals', 'multiple_statements'],
    ['SELECT 1; SELECT 2', 'multiple_statements'],
    ['SELECT email FROM crm.contacts', 'pii_column'],
    ['SELECT c.phone FROM crm.contacts c', 'pii_column'],
    ['SELECT "email" FROM crm.contacts', 'pii_column'],
    ['SELECT lower(email) FROM crm.contacts', 'pii_column'],
    ["SELECT name FROM crm.contacts WHERE email LIKE '%@acme%'", 'pii_column'],
    ['WITH x AS (SELECT email FROM crm.contacts) SELECT * FROM x', 'pii_column'],
    ['SELECT * FROM crm.contacts', 'select_star_pii'],
    ['SELECT body FROM helpdesk.tickets', 'pii_column'],
    ['SELECT row_to_json(c) FROM crm.contacts c', 'function_not_allowed'],
    ['SELECT pg_sleep(10)', 'function_not_allowed'],
    ["SELECT set_config('role', 'x', false)", 'function_not_allowed'],
    ["SELECT pg_read_file('/etc/passwd')", 'function_not_allowed'],
    ['SELECT * FROM pg_catalog.pg_user', 'system_catalog'],
    ['SELECT * FROM information_schema.tables', 'system_catalog'],
    ['SELECT * FROM pg_shadow', 'system_catalog'],
    ['SELECT * FROM gateway.grants', 'system_catalog'],
    ['SELECT * FROM workspace.emails', 'system_catalog'],
    ['SELECT body FROM crm.notes', 'table_not_allowed'],
    ['SELECT name FROM crm.deals FOR UPDATE', 'parse_error'],
    ['SELEC 1', 'parse_error'],
    ['', 'empty'],
  ])('refuses %s (%s)', (sql, code) => {
    expect(codes(sql)).toContain(code);
    expect(ok(sql).ok).toBe(false);
  });

  it('caps rows with an outer LIMIT that comments cannot swallow', () => {
    const result = validateSql('SELECT id FROM crm.deals -- no limit here', { maxRows: 50 });
    expect(result.executableSql).toBe('SELECT * FROM (\nSELECT id FROM crm.deals -- no limit here\n) AS switchboard_query LIMIT 51');
  });

  it('pins CURRENT_DATE and now() outside strings and comments', () => {
    expect(pinDates("SELECT CURRENT_DATE, now(), 'current_date' -- now()\n", '2026-10-01')).toBe(
      "SELECT DATE '2026-10-01', TIMESTAMPTZ '2026-10-01T12:00:00Z', 'current_date' -- now()\n",
    );
    expect(pinDates('SELECT my_now() , x.current_date_col', '2026-10-01')).toBe('SELECT my_now() , x.current_date_col');
  });
});
