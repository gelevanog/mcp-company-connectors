import { randomBytes } from 'node:crypto';

import {
  type CallToolResult,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
  type Tool,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server';
import { type Db, argsHash, queryOne } from '@switchboard/core';

import type { AuditLog } from './audit.js';
import type { TenantConfig } from './config.js';
import { type Session, confirmationRule } from './policy.js';
import type { TaintTracker } from './untrusted.js';

export interface ConfirmState {
  tool: string;
  hash: string;
  user: string;
  nonce: string;
}

export type ConfirmOutcome =
  | { proceed: true; idempotencyKey: string; via: 'elicitation' | 'token' | 'approval' }
  | { proceed: false; result: CallToolResult | InputRequiredResult };

export interface ConfirmDeps {
  db: Db;
  tenant: TenantConfig;
  audit: AuditLog;
  taint: TaintTracker;
  stateCodec: RequestStateCodec<ConfirmState>;
}

export function stripControlArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { confirmation_token: _token, idempotency_key: _key, ...rest } = args;
  return rest;
}

/** A plain-language description of the change, shown to the user before it runs. */
export function describeCall(tool: Tool, args: Record<string, unknown>): string {
  const lines = Object.entries(stripControlArgs(args)).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `• ${key}: ${text.length > 600 ? `${text.slice(0, 597)}...` : text}`;
  });
  return `${tool.title ?? tool.name} (${tool.name})\n${lines.join('\n')}`;
}

function failure(text: string, meta: Record<string, unknown> = {}): { proceed: false; result: CallToolResult } {
  return { proceed: false, result: { content: [{ type: 'text', text }], isError: true, _meta: meta } };
}

/**
 * Writes are never applied on the model's word alone.
 *
 * 1. Clients that support elicitation get an `input_required` result (2026-07-28 multi round-trip; the SDK's
 *    legacy shim turns it into an `elicitation/create` request for 2025 sessions) with an HMAC-signed
 *    requestState that binds the answer to this user, tool and these exact arguments.
 * 2. Other clients get a single-use confirmation token bound to the same three things: the model must show the
 *    change to the user and call again with the token.
 * 3. High-risk tools, or any write after content flagged as a possible prompt injection, need an admin's
 *    approval in the console before the token works.
 *
 * Every path yields an idempotency key, so a retried confirmation never applies the change twice.
 */
export async function confirmWrite(
  deps: ConfirmDeps,
  session: Session,
  ctx: ServerContext,
  tool: Tool,
  args: Record<string, unknown>,
  canElicit: boolean,
): Promise<ConfirmOutcome> {
  const rule = confirmationRule(deps.tenant, tool.name);
  const hash = argsHash(args);
  const taint = deps.taint.state(session.tenant, session.userId, session.clientId);
  const summary = describeCall(tool, args);
  const base = { tenant: session.tenant, userId: session.userId, role: session.role, clientId: session.clientId, clientName: session.clientName, method: 'tools/call', target: tool.name, args: stripControlArgs(args) };

  // A confirmation token from an earlier round.
  if (typeof args.confirmation_token === 'string') {
    const token = args.confirmation_token;
    const row = await queryOne<{ id: string; user_id: string; tool: string; args_hash: string; mode: string; status: string; expired: boolean }>(
      deps.db,
      'SELECT id, user_id, tool, args_hash, mode, status, expires_at < now() AS expired FROM gateway.confirmations WHERE id = $1',
      [token],
    );
    if (!row || row.user_id !== session.userId || row.tool !== tool.name) return failure('Unknown confirmation_token for this tool and user. Nothing was written.');
    if (row.args_hash !== hash) return failure('The arguments differ from the ones the user confirmed. Nothing was written; ask for a new confirmation.');
    if (row.status === 'used') {
      // Same confirmation retried: replay through the same idempotency key (the upstream returns the stored result).
      return { proceed: true, idempotencyKey: `sb-${row.id}`, via: row.mode === 'approval' ? 'approval' : 'token' };
    }
    if (row.expired) return failure('The confirmation expired. Nothing was written; ask the user again.');
    if (row.status === 'rejected') return failure(`An admin rejected this change (request ${row.id}). Nothing was written.`);
    if (row.mode === 'approval' && row.status !== 'approved') {
      return failure(`Still waiting for an admin to approve request ${row.id} in the Switchboard console. Nothing was written yet.`, { 'io.switchboard/confirmation': { id: row.id, mode: 'approval', status: row.status } });
    }
    await deps.db.query(`UPDATE gateway.confirmations SET status = 'used' WHERE id = $1`, [row.id]);
    return { proceed: true, idempotencyKey: `sb-${row.id}`, via: row.mode === 'approval' ? 'approval' : 'token' };
  }

  const warning = taint.suspicious
    ? `\n\n⚠ Earlier content in this session was flagged as a possible prompt injection (${taint.sources.slice(0, 2).join('; ')}). Approve only if you asked for this change yourself.`
    : '';

  if (rule.mode === 'elicit' && canElicit) {
    const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
    if (view.kind === 'elicit') {
      const state = ctx.mcpReq.requestState<ConfirmState>();
      if (view.action !== 'accept' || view.content?.confirm !== true) {
        await deps.audit.write({ ...base, decision: 'declined', reason: `user ${view.action === 'accept' ? 'did not tick confirm' : view.action}` });
        return failure('The user declined this change. Nothing was written. Do not retry unless the user asks again.', { 'io.switchboard/confirmation': { status: 'declined' } });
      }
      if (!state || state.hash !== hash || state.tool !== tool.name || state.user !== session.userId) {
        return failure('The confirmation does not match this call. Nothing was written.');
      }
      return { proceed: true, idempotencyKey: `sb-elicit-${state.nonce}`, via: 'elicitation' };
    }
    await deps.audit.write({ ...base, decision: 'confirmation_requested', reason: 'elicitation', flags: taint.suspicious ? ['tainted_session'] : [] });
    return {
      proceed: false,
      result: inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Switchboard: ${session.userName} is about to make this change:\n\n${summary}${warning}`,
            requestedSchema: {
              type: 'object',
              properties: { confirm: { type: 'boolean', title: 'Apply this change', description: 'Tick to apply; leave unticked or decline to cancel.' } },
              required: ['confirm'],
            },
          }),
        },
        requestState: await deps.stateCodec.mint({ tool: tool.name, hash, user: session.userId, nonce: randomBytes(9).toString('base64url') }),
      }),
    };
  }

  let mode: 'token' | 'approval' = rule.mode === 'elicit' ? rule.fallback : rule.mode;
  if (taint.suspicious && mode === 'token') mode = 'approval';
  const id = `cf_${randomBytes(9).toString('base64url')}`;
  await deps.db.query(
    `INSERT INTO gateway.confirmations (id, tenant, user_id, client_id, tool, args_hash, arguments, summary, mode, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', now() + ($10 || ' minutes')::interval)`,
    [id, session.tenant, session.userId, session.clientId, tool.name, hash, stripControlArgs(args), summary, mode, String(rule.ttl_minutes)],
  );
  await deps.audit.write({ ...base, decision: mode === 'approval' ? 'awaiting_approval' : 'confirmation_requested', reason: mode, flags: taint.suspicious ? ['tainted_session'] : [] });
  const text =
    mode === 'token'
      ? `CONFIRMATION REQUIRED: nothing was written. Show the user exactly this change and ask whether to apply it:\n\n${summary}${warning}\n\n` +
        `Only if the user explicitly confirms, call ${tool.name} again with the same arguments plus "confirmation_token": "${id}". ` +
        `The token works once, for these exact arguments, for ${rule.ttl_minutes} minutes.`
      : `APPROVAL REQUIRED: nothing was written. An admin must approve request ${id} in the Switchboard console (Approvals):\n\n${summary}${warning}\n\n` +
        `Tell the user. After approval, call ${tool.name} again with the same arguments plus "confirmation_token": "${id}".`;
  return failure(text, { 'io.switchboard/confirmation': { id, mode, status: 'pending', ttl_minutes: rule.ttl_minutes } });
}
