import type { Db, DbClient } from './db.js';
import { withTransaction } from './db.js';
import { ToolError } from './errors.js';
import { canonicalJson, sha256 } from './hash.js';

export interface IdempotencyOptions {
  tool: string;
  key: string | undefined;
  args: Record<string, unknown>;
  actor: string;
}

/** Arguments that steer the call rather than describe the change are left out of the hash. */
export function argsHash(args: Record<string, unknown>): string {
  const { idempotency_key: _key, confirmation_token: _token, ...rest } = args;
  return sha256(canonicalJson(rest));
}

/**
 * Run a write once per idempotency key. The same key with the same arguments returns the stored result
 * (`replayed: true`) without touching the data again; the same key with different arguments is refused.
 * Without a key the write simply runs in a transaction.
 */
export async function withIdempotency<T>(
  db: Db,
  options: IdempotencyOptions,
  write: (client: DbClient) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  return withTransaction(db, async (client) => {
    if (!options.key) {
      return { result: await write(client), replayed: false };
    }
    if (options.key.length > 200) throw new ToolError('idempotency_key is longer than 200 characters');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${options.tool}:${options.key}`]);
    const hash = argsHash(options.args);
    const existing = await client.query('SELECT args_hash, result FROM core.idempotency_keys WHERE tool = $1 AND key = $2', [options.tool, options.key]);
    const row = existing.rows[0] as { args_hash: string; result: T } | undefined;
    if (row) {
      if (row.args_hash !== hash) {
        throw new ToolError(`idempotency_key "${options.key}" was already used for ${options.tool} with different arguments`, 'idempotency_conflict');
      }
      return { result: row.result, replayed: true };
    }
    const result = await write(client);
    await client.query(
      'INSERT INTO core.idempotency_keys (key, tool, args_hash, result, actor) VALUES ($1, $2, $3, $4, $5)',
      [options.key, options.tool, hash, JSON.stringify(result), options.actor],
    );
    return { result, replayed: false };
  });
}
