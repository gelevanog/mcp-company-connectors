import { randomBytes } from 'node:crypto';

import { type Db, queryRows, sha256 } from '@switchboard/core';
import { type CryptoKey, type JWK, SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWTPayload } from 'jose';

/**
 * The gateway's ES256 signing key, generated on first start and kept in PostgreSQL (never in the repository or
 * in an environment variable). Access tokens for clients and the short-lived downstream tokens for the MCP
 * servers are both signed with it; their audiences differ, so neither can be used in place of the other.
 */
export class KeyManager {
  private constructor(
    readonly kid: string,
    private readonly privateKey: CryptoKey,
    readonly publicJwk: JWK,
    /** HMAC key for audit-log argument hashes and confirmation ids, derived from the private key. */
    readonly secret: Buffer,
  ) {}

  static async load(db: Db): Promise<KeyManager> {
    let rows = await queryRows<{ kid: string; private_jwk: JWK; public_jwk: JWK }>(db, 'SELECT kid, private_jwk, public_jwk FROM gateway.signing_keys WHERE active ORDER BY created_at DESC LIMIT 1');
    if (rows.length === 0) {
      const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
      const kid = randomBytes(8).toString('hex');
      const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'ES256', use: 'sig' };
      const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
      await db.query('INSERT INTO gateway.signing_keys (kid, private_jwk, public_jwk) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [kid, privateJwk, publicJwk]);
      rows = await queryRows(db, 'SELECT kid, private_jwk, public_jwk FROM gateway.signing_keys WHERE active ORDER BY created_at DESC LIMIT 1');
    }
    const row = rows[0];
    if (!row) throw new Error('no signing key');
    const privateKey = (await importJWK(row.private_jwk, 'ES256')) as CryptoKey;
    const secret = Buffer.from(sha256(`switchboard-secret:${String(row.private_jwk.d)}`), 'hex');
    return new KeyManager(row.kid, privateKey, row.public_jwk, secret);
  }

  jwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }

  async sign(payload: JWTPayload, options: { audience: string; ttlSeconds: number; issuer: string; subject: string }): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: this.kid, typ: 'at+jwt' })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setSubject(options.subject)
      .setIssuedAt()
      .setJti(randomBytes(12).toString('base64url'))
      .setExpirationTime(Math.floor(Date.now() / 1000) + options.ttlSeconds)
      .sign(this.privateKey);
  }

  async verify(token: string, options: { audience: string; issuer: string }): Promise<JWTPayload> {
    const key = await importJWK(this.publicJwk, 'ES256');
    const { payload } = await jwtVerify(token, key, { audience: options.audience, issuer: options.issuer, algorithms: ['ES256'], typ: 'at+jwt' });
    return payload;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
