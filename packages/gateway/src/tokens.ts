import { type AuthInfo, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { type Db, queryOne } from '@switchboard/core';

import type { GatewayConfig } from './config.js';
import type { KeyManager } from './keys.js';
import type { Session } from './policy.js';

export interface AccessClaims {
  sub: string;
  role: string;
  tenant: string;
  scope: string;
  client_id: string;
  name?: string;
}

export async function issueAccessToken(
  keys: KeyManager,
  config: GatewayConfig,
  claims: AccessClaims,
  audience: string,
  ttlSeconds = config.accessTokenTtlSeconds,
): Promise<string> {
  return keys.sign({ ...claims }, { audience, ttlSeconds, issuer: config.issuer, subject: claims.sub });
}

/** A per-call token for one upstream server: audience = that server, five-minute lifetime, the user's scopes. */
export async function issueDownstreamToken(keys: KeyManager, config: GatewayConfig, session: Pick<Session, 'userId' | 'role' | 'tenant' | 'scopes' | 'clientId'>, upstreamUrl: string): Promise<string> {
  return keys.sign(
    { role: session.role, tenant: session.tenant, scope: session.scopes.join(' '), client_id: session.clientId, act: { sub: 'switchboard-gateway' } },
    { audience: upstreamUrl, ttlSeconds: 300, issuer: config.issuer, subject: session.userId },
  );
}

export interface VerifiedToken {
  authInfo: AuthInfo;
  claims: AccessClaims;
}

/** Verifies a bearer token for one of the gateway's resources (signature, issuer, audience, expiry, role). */
export function accessTokenVerifier(keys: KeyManager, config: GatewayConfig, audience: string, db: Db) {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        payload = await keys.verify(token, { audience, issuer: config.issuer });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid token';
        throw new OAuthError(OAuthErrorCode.InvalidToken, message.includes('"aud"') ? 'token audience is not this resource' : message);
      }
      if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || typeof payload.role !== 'string') {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'token is missing claims');
      }
      const user = await queryOne<{ role: string; name: string; can_sign_in: boolean }>(db, 'SELECT role, name, can_sign_in FROM core.employees WHERE id = $1', [payload.sub]);
      if (!user || !user.can_sign_in) throw new OAuthError(OAuthErrorCode.InvalidToken, 'user is not allowed to sign in');
      if (user.role !== payload.role) throw new OAuthError(OAuthErrorCode.InvalidToken, 'role changed since the token was issued; sign in again');
      return {
        token,
        clientId: typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
        expiresAt: payload.exp,
        resource: new URL(audience),
        extra: { sub: payload.sub, role: payload.role, tenant: payload.tenant ?? config.defaultTenant, name: user.name },
      };
    },
  };
}
