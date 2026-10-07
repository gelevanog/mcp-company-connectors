import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { type Db, nowIso, queryOne, queryRows } from '@switchboard/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { ClientStore } from './clients.js';
import type { GatewayConfig } from './config.js';
import type { KeyManager } from './keys.js';
import type { Playground } from './playground.js';
import { isWriteTool, roleAccess, roleHasScope, toolScope } from './policy.js';
import type { GatewayDeps } from './server.js';

export interface AdminDeps {
  deps: GatewayDeps;
  keys: KeyManager;
  config: GatewayConfig;
  clients: ClientStore;
  playground: Playground;
  db: Db;
}

type AdminContext = Context<{ Variables: { admin: string } }>;

/**
 * The admin console's API. Tokens must be issued for the admin API (audience = /admin/api, a different resource
 * from /mcp), carry the admin scope, and belong to a user whose role is admin.
 */
export function adminRoutes(input: AdminDeps): Hono<{ Variables: { admin: string } }> {
  const { deps, keys, config, playground, db } = input;
  const app = new Hono<{ Variables: { admin: string } }>();

  app.use('*', async (c: AdminContext, next: Next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      const payload = await keys.verify(token, { audience: config.adminResource, issuer: config.issuer });
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      const user = await queryOne<{ role: string }>(db, 'SELECT role FROM core.employees WHERE id = $1 AND can_sign_in', [payload.sub]);
      if (!scopes.includes('admin') || user?.role !== 'admin') return c.json({ error: 'insufficient_scope' }, 403);
      c.set('admin', String(payload.sub));
    } catch {
      return c.json({ error: 'invalid_token' }, 401, {
        'www-authenticate': `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/admin/api"`,
      });
    }
    await next();
  });

  app.get('/me', (c) => c.json({ user: c.get('admin') }));

  app.get('/overview', async (c) => {
    await deps.upstreams.refresh().catch(() => undefined);
    const decisions = await queryRows<{ decision: string; n: number }>(db, `SELECT decision, count(*)::int AS n FROM gateway.audit_log WHERE ts > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`);
    const pendingEmails = await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM workspace.emails WHERE status = 'pending_approval'`);
    const pendingConfirmations = await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM gateway.confirmations WHERE mode = 'approval' AND status = 'pending' AND expires_at > now()`);
    const grants = await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM gateway.grants WHERE revoked_at IS NULL AND expires_at > now()');
    const activeUsers = await queryOne<{ n: number }>(db, `SELECT count(DISTINCT user_id)::int AS n FROM gateway.audit_log WHERE ts > now() - interval '24 hours' AND user_id IS NOT NULL`);
    const flagged = await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM gateway.audit_log WHERE ts > now() - interval '24 hours' AND 'injection_suspected' = ANY(flags)`);
    return c.json({
      tenant: deps.tenant.name,
      upstreams: deps.upstreams.current.status,
      tools: deps.upstreams.current.tools.size,
      decisions,
      pending: { emails: pendingEmails?.n ?? 0, confirmations: pendingConfirmations?.n ?? 0 },
      grants: grants?.n ?? 0,
      activeUsers: activeUsers?.n ?? 0,
      flagged: flagged?.n ?? 0,
    });
  });

  app.get('/users', async (c) =>
    c.json({ users: await queryRows(db, 'SELECT id, name, role, title FROM core.employees WHERE can_sign_in ORDER BY array_position(ARRAY[\'sales\',\'support\',\'analyst\',\'admin\'], role), name') }),
  );

  app.get('/clients', async (c) => {
    const clients = await queryRows(db, 'SELECT client_id, client_name, kind, redirect_uris, application_type, created_at, last_used_at FROM gateway.oauth_clients ORDER BY last_used_at DESC NULLS LAST, created_at DESC');
    const grants = await queryRows(
      db,
      `SELECT g.id, g.client_id, c.client_name, g.user_id, e.name AS user_name, e.role, g.scope, g.resource, g.created_at, g.last_used_at, g.expires_at, g.revoked_at
       FROM gateway.grants g LEFT JOIN gateway.oauth_clients c ON c.client_id = g.client_id LEFT JOIN core.employees e ON e.id = g.user_id
       ORDER BY g.revoked_at NULLS FIRST, g.last_used_at DESC LIMIT 100`,
    );
    const activity = await queryRows(
      db,
      `SELECT user_id, role, client_id, max(client_name) AS client_name, count(*)::int AS calls, max(ts) AS last_seen,
              count(*) FILTER (WHERE decision LIKE 'denied%' OR decision LIKE 'blocked%')::int AS denied
       FROM gateway.audit_log WHERE ts > now() - interval '24 hours' AND user_id IS NOT NULL
       GROUP BY user_id, role, client_id ORDER BY last_seen DESC LIMIT 50`,
    );
    return c.json({ clients, grants, activity });
  });

  app.post('/grants/:id/revoke', async (c) => {
    await db.query('UPDATE gateway.grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [c.req.param('id')]);
    return c.json({ ok: true });
  });

  app.get('/tools', async (c) => {
    await Promise.all([deps.upstreams.refresh(0), deps.overrides.refresh(true)]);
    const roles = Object.entries(deps.tenant.roles).map(([name, spec]) => ({ name, description: spec.description, scopes: spec.scopes }));
    const tools = [...deps.upstreams.current.tools.values()].map(({ upstream, tool }) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description ?? '',
      upstream,
      scope: toolScope(tool),
      write: isWriteTool(tool),
      annotations: tool.annotations ?? {},
      roles: Object.fromEntries(
        roles.map((role) => {
          const access = roleAccess(deps.tenantName, deps.tenant, deps.overrides, role.name, tool);
          return [role.name, {
            enabled: access.allowed,
            reason: access.allowed ? null : access.reason,
            scopeAllowed: roleHasScope(deps.tenant, role.name, toolScope(tool)),
            override: deps.overrides.get(deps.tenantName, role.name, tool.name) ?? null,
          }];
        }),
      ),
    }));
    return c.json({ roles, tools });
  });

  app.put('/tools/:tool/roles/:role', async (c) => {
    const body = (await c.req.json()) as { enabled?: boolean | null };
    const tool = c.req.param('tool');
    const role = c.req.param('role');
    if (!deps.tenant.roles[role] || !deps.upstreams.current.tools.has(tool)) return c.json({ error: 'unknown tool or role' }, 404);
    if (body.enabled === null || body.enabled === undefined) await deps.overrides.clear(deps.tenantName, role, tool);
    else await deps.overrides.set(deps.tenantName, role, tool, body.enabled, c.get('admin'));
    return c.json({ ok: true });
  });

  app.get('/approvals', async (c) => {
    const emails = await queryRows(
      db,
      `SELECT m.id, m.author_id, e.name AS author_name, m.to_addresses, m.cc_addresses, m.subject, m.body, m.status, m.related_ticket, m.related_deal, m.created_at, m.submitted_at, m.decided_at, m.decided_by, m.decision_note
       FROM workspace.emails m JOIN core.employees e ON e.id = m.author_id
       WHERE m.status IN ('pending_approval', 'approved', 'rejected') ORDER BY (m.status = 'pending_approval') DESC, coalesce(m.submitted_at, m.created_at) DESC LIMIT 50`,
    );
    const confirmations = await queryRows(
      db,
      `SELECT f.id, f.user_id, e.name AS user_name, f.client_id, f.tool, f.summary, f.mode, f.status, f.created_at, f.expires_at, f.decided_by, f.decided_at, f.expires_at < now() AS expired
       FROM gateway.confirmations f LEFT JOIN core.employees e ON e.id = f.user_id
       ORDER BY (f.status = 'pending' AND f.mode = 'approval') DESC, f.created_at DESC LIMIT 50`,
    );
    return c.json({ emails, confirmations });
  });

  app.post('/approvals/email/:id', async (c) => {
    const body = (await c.req.json()) as { decision?: string; note?: string };
    const id = c.req.param('id');
    const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : undefined;
    if (!decision) return c.json({ error: 'decision must be approve or reject' }, 400);
    const row = await queryOne<{ id: string }>(
      db,
      `UPDATE workspace.emails SET status = $2, decided_at = $3, decided_by = $4, decision_note = $5 WHERE id = $1 AND status = 'pending_approval' RETURNING id`,
      [id, decision, nowIso(), c.get('admin'), body.note ?? null],
    );
    if (!row) return c.json({ error: 'not pending' }, 409);
    if (decision === 'approved') await db.query('INSERT INTO workspace.sandbox_mailbox (email_id, delivered_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, nowIso()]);
    await deps.audit.write({ tenant: deps.tenantName, userId: c.get('admin'), role: 'admin', clientId: 'switchboard-admin', clientName: 'Switchboard admin console', method: 'admin', target: `email ${id}`, decision: decision === 'approved' ? 'confirmed' : 'declined', reason: `outbox ${decision}` });
    return c.json({ ok: true, status: decision });
  });

  app.post('/approvals/confirmation/:id', async (c) => {
    const body = (await c.req.json()) as { decision?: string };
    const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : undefined;
    if (!decision) return c.json({ error: 'decision must be approve or reject' }, 400);
    const row = await queryOne<{ id: string; tool: string }>(
      db,
      `UPDATE gateway.confirmations SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending' AND mode = 'approval' AND expires_at > now() RETURNING id, tool`,
      [c.req.param('id'), decision, c.get('admin')],
    );
    if (!row) return c.json({ error: 'not pending' }, 409);
    await deps.audit.write({ tenant: deps.tenantName, userId: c.get('admin'), role: 'admin', clientId: 'switchboard-admin', clientName: 'Switchboard admin console', method: 'admin', target: `${row.tool} ${row.id}`, decision: decision === 'approved' ? 'confirmed' : 'declined', reason: `write ${decision}` });
    return c.json({ ok: true, status: decision });
  });

  app.get('/audit', async (c) => {
    const q = c.req.query();
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.user) add('user_id = ?', q.user);
    if (q.decision) add('decision = ?', q.decision);
    if (q.target) add('target ILIKE ?', `%${q.target}%`);
    if (q.flag) add('? = ANY(flags)', q.flag);
    if (q.before) add('id < ?', Number(q.before));
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const rows = await queryRows(
      db,
      `SELECT id, ts, user_id, role, client_id, client_name, method, target, args_hash, result_bytes, decision, reason, latency_ms, flags
       FROM gateway.audit_log ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`,
      params,
    );
    return c.json({ entries: rows });
  });

  app.get('/eval', (c) => {
    const dir = config.resultsDir;
    const summaryPath = join(dir, 'summary.json');
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
    const summary = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as unknown) : null;
    return c.json({ summary, files });
  });

  app.get('/playground/presets', async (c) => {
    const modelIds = (process.env.SWITCHBOARD_PLAYGROUND_MODELS ?? 'nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3-ultra-550b-a55b:free')
      .split(',').map((id) => id.trim()).filter((id) => id.endsWith(':free'));
    return c.json({
      presets: playground.presets(),
      models: [
        { provider: 'fake', id: 'fake', label: 'Offline demo model (scripted, no key)' },
        { provider: 'fake', id: 'fake-gullible', label: 'Offline gullible model (obeys injected instructions)' },
        ...(process.env.OPENROUTER_API_KEY ? modelIds.map((id) => ({ provider: 'openrouter', id, label: `${id} (OpenRouter, free)` })) : []),
      ],
    });
  });

  app.post('/playground/runs', async (c) => {
    const body = (await c.req.json()) as { user?: string; prompt?: string; model?: string; exposeAll?: boolean };
    if (!body.user || !body.prompt || body.prompt.length > 2000) return c.json({ error: 'user and prompt (max 2000 characters) are required' }, 400);
    const modelId = body.model ?? 'fake';
    const id = await playground.start({
      userId: body.user,
      prompt: body.prompt,
      provider: modelId.startsWith('fake') ? 'fake' : 'openrouter',
      ...(modelId.startsWith('fake') ? { gullible: modelId === 'fake-gullible' } : { model: modelId }),
      exposeAll: body.exposeAll === true && config.evalMode,
    });
    await deps.audit.write({ tenant: deps.tenantName, userId: c.get('admin'), role: 'admin', clientId: 'switchboard-admin', method: 'admin', target: 'playground', decision: 'allowed', reason: `run ${id} as ${body.user} with ${modelId}` });
    return c.json({ id });
  });

  app.get('/playground/runs/:id/events', (c) => {
    const id = c.req.param('id');
    const run = playground.get(id);
    if (!run) return c.json({ error: 'unknown run' }, 404);
    return streamSSE(c, async (stream) => {
      const queue: { seq: number; event: unknown }[] = [...run.events];
      let wake: (() => void) | undefined;
      const unsubscribe = playground.subscribe(id, (entry) => {
        queue.push(entry);
        wake?.();
      });
      try {
        let finished = false;
        while (!finished && !stream.aborted) {
          while (queue.length > 0) {
            const entry = queue.shift();
            if (!entry) break;
            await stream.writeSSE({ id: String(entry.seq), event: 'message', data: JSON.stringify(entry.event) });
            const type = (entry.event as { type?: string }).type;
            if (type === 'done' || type === 'error') finished = true;
          }
          if (finished || run.done) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 15_000);
          });
          wake = undefined;
          if (queue.length === 0) await stream.writeSSE({ event: 'ping', data: '{}' });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.post('/playground/runs/:id/confirm', async (c) => {
    const body = (await c.req.json()) as { key?: string; action?: string };
    const ok = playground.answer(c.req.param('id'), String(body.key), body.action === 'accept' ? 'accept' : 'decline');
    return ok ? c.json({ ok: true }) : c.json({ error: 'no pending confirmation with that key' }, 404);
  });

  return app;
}
