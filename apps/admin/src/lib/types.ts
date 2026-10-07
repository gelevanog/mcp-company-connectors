export interface AuditEntry {
  id: number;
  ts: string;
  user_id: string | null;
  role: string | null;
  client_id: string | null;
  client_name: string | null;
  method: string;
  target: string | null;
  args_hash: string | null;
  result_bytes: number | null;
  decision: string;
  reason: string | null;
  latency_ms: number | null;
  flags: string[];
}

export interface Overview {
  tenant: string;
  upstreams: Record<string, { ok: boolean; error?: string; tools: number; refreshedAt: string }>;
  tools: number;
  decisions: { decision: string; n: number }[];
  pending: { emails: number; confirmations: number };
  grants: number;
  activeUsers: number;
  flagged: number;
}

export interface RoleAccess {
  enabled: boolean;
  reason: string | null;
  scopeAllowed: boolean;
  override: boolean | null;
}

export interface ToolRow {
  name: string;
  title: string;
  description: string;
  upstream: string;
  scope: string;
  write: boolean;
  annotations: Record<string, boolean | undefined>;
  roles: Record<string, RoleAccess>;
}

export interface ToolsResponse {
  roles: { name: string; description: string; scopes: string[] }[];
  tools: ToolRow[];
}
