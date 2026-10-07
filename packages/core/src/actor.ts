import type { AuthInfo } from '@modelcontextprotocol/server';

import { ALL_SCOPES } from './scopes.js';

/** Who is acting: the end user the gateway vouches for, with the scopes their token carries. */
export interface Actor {
  userId: string;
  role: string;
  tenant: string;
  scopes: string[];
  clientId: string;
  via: 'gateway' | 'stdio' | 'test';
}

export function actorFromAuthInfo(authInfo: AuthInfo | undefined): Actor | undefined {
  if (!authInfo) return undefined;
  const extra = authInfo.extra ?? {};
  const userId = typeof extra.sub === 'string' ? extra.sub : undefined;
  if (!userId) return undefined;
  return {
    userId,
    role: typeof extra.role === 'string' ? extra.role : 'unknown',
    tenant: typeof extra.tenant === 'string' ? extra.tenant : 'kestrel',
    scopes: authInfo.scopes,
    clientId: authInfo.clientId,
    via: 'gateway',
  };
}

/**
 * Over stdio there is no token: the server acts as the single local user named in SWITCHBOARD_ACTOR, with
 * every scope it serves (the MCP authorization spec leaves stdio credentials to the environment). Use the
 * gateway (also available over stdio) when policies matter.
 */
export function stdioActor(): Actor {
  return {
    userId: process.env.SWITCHBOARD_ACTOR ?? 'adam',
    role: 'local',
    tenant: process.env.SWITCHBOARD_TENANT ?? 'kestrel',
    scopes: [...ALL_SCOPES],
    clientId: 'stdio',
    via: 'stdio',
  };
}

export function hasScope(actor: Actor, scope: string): boolean {
  return actor.scopes.includes(scope);
}
