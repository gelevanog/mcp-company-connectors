import { type Db, canonicalJson, hmac, log } from '@switchboard/core';

export type Decision =
  | 'allowed'
  | 'error'
  | 'denied_role'
  | 'denied_scope'
  | 'denied_disabled'
  | 'rate_limited'
  | 'confirmation_requested'
  | 'confirmed'
  | 'declined'
  | 'awaiting_approval'
  | 'blocked_untrusted_recipient'
  | 'replayed'
  | 'auth_failed'
  | 'cancelled';

export interface AuditEntry {
  tenant: string;
  userId?: string | undefined;
  role?: string | undefined;
  clientId?: string | undefined;
  clientName?: string | undefined;
  method: string;
  target?: string | undefined;
  args?: unknown;
  resultBytes?: number | undefined;
  decision: Decision;
  reason?: string | undefined;
  latencyMs?: number | undefined;
  flags?: string[] | undefined;
  requestId?: string | undefined;
}

/**
 * One row per tool call, resource read and prompt: who, which client, what, a keyed hash of the arguments (so
 * equal calls can be correlated without storing their content), result size, decision, latency, flags.
 */
export class AuditLog {
  constructor(private readonly db: Db, private readonly key: Buffer) {}

  argsHash(args: unknown): string | undefined {
    if (args === undefined) return undefined;
    return hmac(this.key, canonicalJson(args)).slice(0, 32);
  }

  async write(entry: AuditEntry): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO gateway.audit_log (tenant, user_id, role, client_id, client_name, method, target, args_hash, result_bytes, decision, reason, latency_ms, flags, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          entry.tenant, entry.userId ?? null, entry.role ?? null, entry.clientId ?? null, entry.clientName ?? null, entry.method,
          entry.target ?? null, this.argsHash(entry.args) ?? null, entry.resultBytes ?? null, entry.decision,
          entry.reason?.slice(0, 500) ?? null, entry.latencyMs ?? null, entry.flags ?? [], entry.requestId ?? null,
        ],
      );
    } catch (error) {
      log('audit', 'write failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
