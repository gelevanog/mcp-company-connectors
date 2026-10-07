import type { Tool } from '@modelcontextprotocol/server';
import { type Db, META, queryRows } from '@switchboard/core';

import type { ConfirmationConfig, TenantConfig } from './config.js';

export interface Session {
  tenant: string;
  userId: string;
  userName: string;
  role: string;
  scopes: string[];
  clientId: string;
  clientName: string;
  /** Eval mode only: list every tool (calls are still authorized), for the tool-filtering ablation. */
  exposeAll: boolean;
}

export function matches(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

export function toolScope(tool: Pick<Tool, '_meta'>): string {
  const scope = tool._meta?.[META.scope];
  return typeof scope === 'string' ? scope : 'admin';
}

export function isWriteTool(tool: Pick<Tool, '_meta' | 'annotations'>): boolean {
  return tool._meta?.[META.write] === true || tool.annotations?.readOnlyHint === false;
}

export function roleScopes(tenant: TenantConfig, role: string): string[] | '*' {
  const spec = tenant.roles[role];
  if (!spec) return [];
  return spec.scopes.includes('*') ? '*' : spec.scopes;
}

export function roleHasScope(tenant: TenantConfig, role: string, scope: string): boolean {
  const scopes = roleScopes(tenant, role);
  return scopes === '*' || scopes.includes(scope);
}

export type Access =
  | { allowed: true }
  | { allowed: false; reason: 'role' | 'role_scope' | 'disabled' | 'token_scope' };

/** Overrides from the admin console: tenant/role/tool → enabled. Cached; refreshed on every change. */
export class Overrides {
  private cache = new Map<string, boolean>();
  private loadedAt = 0;

  constructor(private readonly db: Db) {}

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < 5_000) return;
    const rows = await queryRows<{ tenant: string; role: string; tool: string; enabled: boolean }>(this.db, 'SELECT tenant, role, tool, enabled FROM gateway.tool_overrides');
    this.cache = new Map(rows.map((row) => [`${row.tenant}/${row.role}/${row.tool}`, row.enabled]));
    this.loadedAt = Date.now();
  }

  get(tenant: string, role: string, tool: string): boolean | undefined {
    return this.cache.get(`${tenant}/${role}/${tool}`);
  }

  async set(tenant: string, role: string, tool: string, enabled: boolean, by: string): Promise<void> {
    await this.db.query(
      `INSERT INTO gateway.tool_overrides (tenant, role, tool, enabled, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant, role, tool) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenant, role, tool, enabled, by],
    );
    await this.refresh(true);
  }

  async clear(tenant: string, role: string, tool: string): Promise<void> {
    await this.db.query('DELETE FROM gateway.tool_overrides WHERE tenant = $1 AND role = $2 AND tool = $3', [tenant, role, tool]);
    await this.refresh(true);
  }
}

/**
 * Does the role get this tool at all (before looking at the token)? Pattern allow-list, the role's scopes,
 * then the admin console's toggle (which can switch a tool off, or on for a role whose patterns miss it, but
 * never past the role's scopes).
 */
export function roleAccess(tenant: string, config: TenantConfig, overrides: Overrides, role: string, tool: Tool): Access {
  const spec = config.roles[role];
  if (!spec) return { allowed: false, reason: 'role' };
  const scope = toolScope(tool);
  if (!roleHasScope(config, role, scope)) return { allowed: false, reason: 'role_scope' };
  const override = overrides.get(tenant, role, tool.name);
  if (override === false) return { allowed: false, reason: 'disabled' };
  if (override === true) return { allowed: true };
  return spec.tools.some((pattern) => matches(pattern, tool.name)) ? { allowed: true } : { allowed: false, reason: 'role' };
}

export function confirmationRule(config: TenantConfig, tool: string): ConfirmationConfig {
  const specific = config.confirmations.tools[tool];
  return { ...config.confirmations.default, ...(specific ?? {}) };
}

/** The scopes a token gets: what the client asked for, limited to the role. No scope asked = everything the role has. */
export function grantScopes(requested: string[], roleAllowed: string[] | '*', known: string[]): string[] {
  const universe = roleAllowed === '*' ? known : roleAllowed.filter((scope) => known.includes(scope));
  if (requested.length === 0) return universe;
  return requested.filter((scope) => universe.includes(scope));
}
