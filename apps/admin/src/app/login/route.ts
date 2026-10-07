import { createHash, randomBytes } from 'node:crypto';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { ACCESS_COOKIE, ADMIN_PUBLIC_URL, CLIENT_ID, FLOW_COOKIE, GATEWAY_INTERNAL_URL, GATEWAY_PUBLIC_URL, REFRESH_COOKIE } from '@/lib/config';

const secure = ADMIN_PUBLIC_URL.startsWith('https://');

/**
 * Sign in to the admin console with OAuth 2.1 (authorization code + PKCE) against the gateway's own
 * authorization server, for the admin API resource. A stored refresh token is tried first.
 */
export async function GET(): Promise<NextResponse> {
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (refresh) {
    const response = await fetch(`${GATEWAY_INTERNAL_URL}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }),
      cache: 'no-store',
    });
    if (response.ok) {
      const tokens = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
      const res = NextResponse.redirect(`${ADMIN_PUBLIC_URL}/`);
      res.cookies.set(ACCESS_COOKIE, tokens.access_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: tokens.expires_in });
      res.cookies.set(REFRESH_COOKIE, tokens.refresh_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 30 * 86400 });
      return res;
    }
  }
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const url = new URL(`${GATEWAY_PUBLIC_URL}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: `${ADMIN_PUBLIC_URL}/auth/callback`,
    scope: 'admin',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${GATEWAY_PUBLIC_URL}/admin/api`,
  }).toString();
  const res = NextResponse.redirect(url.toString());
  res.cookies.set(FLOW_COOKIE, JSON.stringify({ verifier, state }), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 600 });
  return res;
}
