import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

import { ACCESS_COOKIE, ADMIN_PUBLIC_URL, CLIENT_ID, FLOW_COOKIE, GATEWAY_INTERNAL_URL, GATEWAY_PUBLIC_URL, REFRESH_COOKIE } from '@/lib/config';

const secure = ADMIN_PUBLIC_URL.startsWith('https://');

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const flow = JSON.parse((await cookies()).get(FLOW_COOKIE)?.value ?? '{}') as { verifier?: string; state?: string };
  if (!flow.verifier || params.get('state') !== flow.state) return new NextResponse('Sign-in state mismatch. Start again.', { status: 400 });
  if (params.get('iss') !== GATEWAY_PUBLIC_URL) return new NextResponse('Unexpected issuer.', { status: 400 });
  if (params.get('error')) return new NextResponse(`Sign-in refused: ${params.get('error')}`, { status: 403 });
  const response = await fetch(`${GATEWAY_INTERNAL_URL}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code') ?? '',
      code_verifier: flow.verifier,
      client_id: CLIENT_ID,
      redirect_uri: `${ADMIN_PUBLIC_URL}/auth/callback`,
      resource: `${GATEWAY_PUBLIC_URL}/admin/api`,
    }),
    cache: 'no-store',
  });
  if (!response.ok) return new NextResponse(`Token exchange failed: ${await response.text()}`, { status: 400 });
  const tokens = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const res = NextResponse.redirect(`${ADMIN_PUBLIC_URL}/`);
  res.cookies.set(ACCESS_COOKIE, tokens.access_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: tokens.expires_in });
  res.cookies.set(REFRESH_COOKIE, tokens.refresh_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 30 * 86400 });
  res.cookies.delete(FLOW_COOKIE);
  return res;
}
