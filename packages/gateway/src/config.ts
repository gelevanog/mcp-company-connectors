import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import * as z from 'zod/v4';

const ConfirmationRule = z.object({
  mode: z.enum(['elicit', 'token', 'approval']),
  fallback: z.enum(['token', 'approval']).default('token'),
  ttl_minutes: z.number().int().min(1).max(1440).default(10),
});

const RateLimit = z.object({ calls_per_minute: z.number().int().min(0), writes_per_minute: z.number().int().min(0) });

const Tenant = z.strictObject({
  name: z.string(),
  internal_domain: z.string(),
  upstreams: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.strictObject({ url: z.url(), uri_schemes: z.array(z.string()).default([]) })),
  roles: z.record(
    z.string().regex(/^[a-z][a-z0-9_-]*$/),
    z.strictObject({ description: z.string(), scopes: z.array(z.string()), tools: z.array(z.string()) }),
  ),
  confirmations: z.strictObject({
    default: ConfirmationRule,
    tools: z.record(z.string(), ConfirmationRule.partial().extend({ mode: ConfirmationRule.shape.mode })).default({}),
  }),
  rate_limits: z.strictObject({ default: RateLimit, roles: z.record(z.string(), RateLimit.partial()).default({}) }),
  untrusted: z.strictObject({
    wrap: z.boolean().default(true),
    taint_window_minutes: z.number().int().min(0).max(1440).default(30),
    block_untrusted_recipients: z.boolean().default(true),
  }),
});

export const PolicyFile = z.strictObject({ tenants: z.record(z.string(), Tenant) });
export type TenantConfig = z.infer<typeof Tenant>;
export type ConfirmationConfig = z.infer<typeof ConfirmationRule>;

export interface GatewayConfig {
  publicUrl: string;
  issuer: string;
  mcpResource: string;
  adminResource: string;
  tenants: Record<string, TenantConfig>;
  defaultTenant: string;
  demoLogin: boolean;
  evalMode: boolean;
  listPageSize: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  /** Extra hosts allowed as https redirect targets in dynamic client registration (besides any https host). */
  allowHttpsRedirects: boolean;
  cimdEnabled: boolean;
  /** First-party admin console redirect URIs (the Next.js app). */
  adminRedirectUris: string[];
  resultsDir: string;
}

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'config', 'switchboard.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

export function loadPolicy(path = process.env.SWITCHBOARD_POLICY_FILE ?? join(repoRoot(), 'config', 'switchboard.yaml')): Record<string, TenantConfig> {
  const parsed = PolicyFile.parse(parse(readFileSync(path, 'utf8')));
  for (const tenant of Object.values(parsed.tenants)) {
    for (const [name, upstream] of Object.entries(tenant.upstreams)) {
      const override = process.env[`SWITCHBOARD_UPSTREAM_${name.toUpperCase()}_URL`];
      if (override) upstream.url = override;
    }
  }
  return parsed.tenants;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const publicUrl = (overrides.publicUrl ?? process.env.SWITCHBOARD_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const tenants = overrides.tenants ?? loadPolicy();
  const defaultTenant = overrides.defaultTenant ?? process.env.SWITCHBOARD_TENANT ?? Object.keys(tenants)[0] ?? 'kestrel';
  return {
    publicUrl,
    issuer: publicUrl,
    mcpResource: `${publicUrl}/mcp`,
    adminResource: `${publicUrl}/admin/api`,
    tenants,
    defaultTenant,
    demoLogin: overrides.demoLogin ?? bool('SWITCHBOARD_DEMO_LOGIN', true),
    evalMode: overrides.evalMode ?? bool('SWITCHBOARD_EVAL_MODE', false),
    listPageSize: overrides.listPageSize ?? Number(process.env.SWITCHBOARD_LIST_PAGE_SIZE ?? 20),
    accessTokenTtlSeconds: overrides.accessTokenTtlSeconds ?? Number(process.env.SWITCHBOARD_ACCESS_TOKEN_TTL ?? 900),
    refreshTokenTtlDays: overrides.refreshTokenTtlDays ?? 30,
    allowHttpsRedirects: overrides.allowHttpsRedirects ?? bool('SWITCHBOARD_ALLOW_HTTPS_REDIRECTS', true),
    cimdEnabled: overrides.cimdEnabled ?? bool('SWITCHBOARD_CIMD', true),
    adminRedirectUris:
      overrides.adminRedirectUris ??
      (process.env.SWITCHBOARD_ADMIN_REDIRECT_URIS ?? 'http://localhost:3000/auth/callback').split(',').map((uri) => uri.trim()).filter(Boolean),
    resultsDir: overrides.resultsDir ?? process.env.SWITCHBOARD_RESULTS_DIR ?? join(repoRoot(), 'results'),
  };
}
