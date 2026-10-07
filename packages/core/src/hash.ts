import { createHash, createHmac } from 'node:crypto';

/** JSON with sorted keys, so equal arguments hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hmac(key: string | Buffer, text: string): string {
  return createHmac('sha256', key).update(text).digest('hex');
}
