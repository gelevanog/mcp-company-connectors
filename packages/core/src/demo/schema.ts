/**
 * The demo database: one PostgreSQL database, one schema per system (crm, helpdesk, workspace), shared
 * employees and idempotency keys in `core`, the gateway's own state in `gateway`.
 *
 * Every statement is idempotent so `switchboard seed` can run on an existing database; `resetSql` drops the
 * demo data (not the gateway's OAuth clients and signing keys) before a re-seed.
 */

export const SCHEMA_SQL = /* sql */ `
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS crm;
CREATE SCHEMA IF NOT EXISTS helpdesk;
CREATE SCHEMA IF NOT EXISTS workspace;
CREATE SCHEMA IF NOT EXISTS gateway;

CREATE TABLE IF NOT EXISTS core.employees (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  role        text NOT NULL,             -- sales | support | analyst | admin | (other: not a Switchboard user)
  title       text NOT NULL,
  region      text,                      -- AMER | EMEA | APAC (sales territories)
  timezone    text NOT NULL DEFAULT 'UTC',
  can_sign_in boolean NOT NULL DEFAULT false
);

-- Idempotency keys for every write tool on every server (Stripe-style: same key + same arguments = same result).
CREATE TABLE IF NOT EXISTS core.idempotency_keys (
  key         text NOT NULL,
  tool        text NOT NULL,
  args_hash   text NOT NULL,
  result      jsonb NOT NULL,
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tool, key)
);

CREATE TABLE IF NOT EXISTS crm.companies (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  domain      text NOT NULL,
  industry    text NOT NULL,
  region      text NOT NULL,
  plan        text NOT NULL,             -- Starter | Growth | Enterprise
  employees   integer NOT NULL,
  arr_usd     numeric(12,2) NOT NULL DEFAULT 0,
  owner_id    text REFERENCES core.employees(id),
  created_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS crm.contacts (
  id          text PRIMARY KEY,
  company_id  text NOT NULL REFERENCES crm.companies(id),
  name        text NOT NULL,
  title       text NOT NULL,
  email       text NOT NULL,             -- personal data
  phone       text NOT NULL,             -- personal data
  created_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS crm.deals (
  id               text PRIMARY KEY,
  company_id       text NOT NULL REFERENCES crm.companies(id),
  name             text NOT NULL,
  stage            text NOT NULL,        -- lead | qualified | proposal | negotiation | won | lost
  amount_usd       numeric(12,2) NOT NULL,
  region           text NOT NULL,
  owner_id         text REFERENCES core.employees(id),
  expected_close   date,
  created_at       timestamptz NOT NULL,
  stage_changed_at timestamptz NOT NULL,
  closed_at        timestamptz
);

CREATE TABLE IF NOT EXISTS crm.deal_stage_history (
  id          bigserial PRIMARY KEY,
  deal_id     text NOT NULL REFERENCES crm.deals(id),
  from_stage  text,
  to_stage    text NOT NULL,
  changed_at  timestamptz NOT NULL,
  changed_by  text NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS crm.note_seq START 5001;
CREATE TABLE IF NOT EXISTS crm.notes (
  id          text PRIMARY KEY,
  company_id  text NOT NULL REFERENCES crm.companies(id),
  deal_id     text REFERENCES crm.deals(id),
  author_id   text NOT NULL,
  body        text NOT NULL,             -- free text, often pasted from customer emails: untrusted
  created_at  timestamptz NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS helpdesk.ticket_seq START 1300;
CREATE TABLE IF NOT EXISTS helpdesk.tickets (
  id                    text PRIMARY KEY,
  company_id            text NOT NULL REFERENCES crm.companies(id),
  requester_contact_id  text REFERENCES crm.contacts(id),
  subject               text NOT NULL,
  body                  text NOT NULL,   -- written by the customer: untrusted
  status                text NOT NULL,   -- open | pending | resolved | closed
  priority              text NOT NULL,   -- low | normal | high | urgent
  channel               text NOT NULL,   -- email | chat | phone | web
  assignee_id           text REFERENCES core.employees(id),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  resolved_at           timestamptz
);

CREATE SEQUENCE IF NOT EXISTS helpdesk.comment_seq START 91001;
CREATE TABLE IF NOT EXISTS helpdesk.comments (
  id          text PRIMARY KEY,
  ticket_id   text NOT NULL REFERENCES helpdesk.tickets(id),
  author_type text NOT NULL,             -- customer | agent
  author_name text NOT NULL,
  body        text NOT NULL,             -- untrusted when written by a customer
  internal    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS workspace.event_seq START 7001;
CREATE TABLE IF NOT EXISTS workspace.events (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES core.employees(id),
  title       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  attendees   text[] NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  company_id  text REFERENCES crm.companies(id),
  created_at  timestamptz NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS workspace.email_seq START 8001;
CREATE TABLE IF NOT EXISTS workspace.emails (
  id              text PRIMARY KEY,
  author_id       text NOT NULL REFERENCES core.employees(id),
  to_addresses    text[] NOT NULL,
  cc_addresses    text[] NOT NULL DEFAULT '{}',
  subject         text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL,         -- draft | pending_approval | approved | rejected
  related_ticket  text,
  related_deal    text,
  created_at      timestamptz NOT NULL,
  submitted_at    timestamptz,
  decided_at      timestamptz,
  decided_by      text,
  decision_note   text
);

-- Approved emails land here. Nothing ever leaves the machine: this table is the "sent" folder.
CREATE TABLE IF NOT EXISTS workspace.sandbox_mailbox (
  email_id     text PRIMARY KEY REFERENCES workspace.emails(id),
  delivered_at timestamptz NOT NULL
);

-- Gateway state
CREATE TABLE IF NOT EXISTS gateway.signing_keys (
  kid         text PRIMARY KEY,
  private_jwk jsonb NOT NULL,
  public_jwk  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS gateway.oauth_clients (
  client_id      text PRIMARY KEY,
  client_name    text NOT NULL,
  redirect_uris  text[] NOT NULL,
  kind           text NOT NULL,          -- dcr | cimd | first_party
  application_type text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);

CREATE TABLE IF NOT EXISTS gateway.auth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL,
  user_id         text NOT NULL,
  redirect_uri    text NOT NULL,
  scope           text NOT NULL,
  resource        text NOT NULL,
  code_challenge  text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used            boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS gateway.grants (
  id              text PRIMARY KEY,
  refresh_hash    text NOT NULL UNIQUE,
  client_id       text NOT NULL,
  user_id         text NOT NULL,
  scope           text NOT NULL,
  resource        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  client_info     jsonb
);

CREATE TABLE IF NOT EXISTS gateway.audit_log (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  tenant        text NOT NULL,
  user_id       text,
  role          text,
  client_id     text,
  client_name   text,
  method        text NOT NULL,           -- tools/call | resources/read | prompts/get | auth
  target        text,                    -- tool name, resource URI, prompt name
  args_hash     text,
  result_bytes  integer,
  decision      text NOT NULL,
  reason        text,
  latency_ms    integer,
  flags         text[] NOT NULL DEFAULT '{}',
  request_id    text
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON gateway.audit_log (ts DESC);

CREATE TABLE IF NOT EXISTS gateway.tool_overrides (
  tenant      text NOT NULL,
  role        text NOT NULL,
  tool        text NOT NULL,
  enabled     boolean NOT NULL,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, role, tool)
);

CREATE TABLE IF NOT EXISTS gateway.confirmations (
  id            text PRIMARY KEY,
  tenant        text NOT NULL,
  user_id       text NOT NULL,
  client_id     text,
  tool          text NOT NULL,
  args_hash     text NOT NULL,
  arguments     jsonb NOT NULL,
  summary       text NOT NULL,
  mode          text NOT NULL,           -- token | approval
  status        text NOT NULL,           -- pending | approved | rejected | used | expired
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  decided_by    text,
  decided_at    timestamptz
);
`;

/** Demo data only; the gateway's clients, grants, keys and audit log survive a re-seed. */
export const RESET_SQL = /* sql */ `
TRUNCATE workspace.sandbox_mailbox, workspace.emails, workspace.events,
         helpdesk.comments, helpdesk.tickets,
         crm.notes, crm.deal_stage_history, crm.deals, crm.contacts, crm.companies,
         core.idempotency_keys, gateway.confirmations
         CASCADE;
DELETE FROM core.employees;
ALTER SEQUENCE crm.note_seq RESTART WITH 5001;
ALTER SEQUENCE helpdesk.ticket_seq RESTART WITH 1300;
ALTER SEQUENCE helpdesk.comment_seq RESTART WITH 91001;
ALTER SEQUENCE workspace.event_seq RESTART WITH 7001;
ALTER SEQUENCE workspace.email_seq RESTART WITH 8001;
`;

/**
 * The read-only login the analytics server runs every query as: no write grants anywhere, column-level SELECT
 * that leaves out personal data and free text written by customers, read-only by default, a statement timeout.
 */
export const ANALYTICS_TABLES: Record<string, { columns: string[]; denied: string[] }> = {
  'crm.companies': {
    columns: ['id', 'name', 'domain', 'industry', 'region', 'plan', 'employees', 'arr_usd', 'owner_id', 'created_at'],
    denied: [],
  },
  'crm.contacts': { columns: ['id', 'company_id', 'name', 'title', 'created_at'], denied: ['email', 'phone'] },
  'crm.deals': {
    columns: [
      'id', 'company_id', 'name', 'stage', 'amount_usd', 'region', 'owner_id', 'expected_close', 'created_at',
      'stage_changed_at', 'closed_at',
    ],
    denied: [],
  },
  'crm.deal_stage_history': { columns: ['id', 'deal_id', 'from_stage', 'to_stage', 'changed_at', 'changed_by'], denied: [] },
  'helpdesk.tickets': {
    columns: [
      'id', 'company_id', 'requester_contact_id', 'subject', 'status', 'priority', 'channel', 'assignee_id',
      'created_at', 'updated_at', 'resolved_at',
    ],
    denied: ['body'],
  },
  'core.employees': { columns: ['id', 'name', 'role', 'title', 'region'], denied: ['email', 'timezone', 'can_sign_in'] },
};

export function analyticsRoleSql(role: string, password: string): string {
  const quotedPassword = password.replace(/'/g, "''");
  const grants = Object.entries(ANALYTICS_TABLES)
    .map(([table, spec]) => `GRANT SELECT (${spec.columns.join(', ')}) ON ${table} TO ${role};`)
    .join('\n');
  return /* sql */ `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} LOGIN PASSWORD '${quotedPassword}';
  ELSE
    ALTER ROLE ${role} LOGIN PASSWORD '${quotedPassword}';
  END IF;
END $$;
ALTER ROLE ${role} SET default_transaction_read_only = on;
ALTER ROLE ${role} SET statement_timeout = '5s';
REVOKE ALL ON ALL TABLES IN SCHEMA core, crm, helpdesk, workspace, gateway FROM ${role};
GRANT USAGE ON SCHEMA core, crm, helpdesk TO ${role};
${grants}
`;
}
