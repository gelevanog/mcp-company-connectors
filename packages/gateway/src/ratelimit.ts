import type { TenantConfig } from './config.js';

interface Bucket {
  tokens: number;
  updated: number;
}

/**
 * Token buckets per user: one for all calls, one for writes. In-process (one gateway instance); a fleet would
 * keep the buckets in Redis.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly tenant: TenantConfig) {}

  private limits(role: string): { calls: number; writes: number } {
    const base = this.tenant.rate_limits.default;
    const specific = this.tenant.rate_limits.roles[role] ?? {};
    return { calls: specific.calls_per_minute ?? base.calls_per_minute, writes: specific.writes_per_minute ?? base.writes_per_minute };
  }

  private take(key: string, perMinute: number): { ok: boolean; retryAfterSeconds: number } {
    if (perMinute <= 0) return { ok: false, retryAfterSeconds: 60 };
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: perMinute, updated: now };
    bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.updated) / 60_000) * perMinute);
    bucket.updated = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return { ok: false, retryAfterSeconds: Math.ceil(((1 - bucket.tokens) / perMinute) * 60) };
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { ok: true, retryAfterSeconds: 0 };
  }

  check(tenant: string, userId: string, role: string, write: boolean): { ok: boolean; retryAfterSeconds: number; limit: string } {
    const limits = this.limits(role);
    const calls = this.take(`${tenant}/${userId}/calls`, limits.calls);
    if (!calls.ok) return { ...calls, limit: `${limits.calls} calls per minute` };
    if (write) {
      const writes = this.take(`${tenant}/${userId}/writes`, limits.writes);
      if (!writes.ok) return { ...writes, limit: `${limits.writes} writes per minute` };
    }
    return { ok: true, retryAfterSeconds: 0, limit: '' };
  }

  reset(): void {
    this.buckets.clear();
  }
}
