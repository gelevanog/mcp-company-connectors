import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { ACCESS_COOKIE, GATEWAY_INTERNAL_URL } from '@/lib/config';

/** Browser → console → gateway admin API. The access token stays in an httpOnly cookie; SSE streams pass through. */
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return Response.json({ error: 'signed out' }, { status: 401 });
  const { path } = await context.params;
  const target = `${GATEWAY_INTERNAL_URL}/admin/api/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  const upstream = await fetch(target, {
    method: request.method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body }),
    cache: 'no-store',
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
}

export { proxy as GET, proxy as POST, proxy as PUT };
