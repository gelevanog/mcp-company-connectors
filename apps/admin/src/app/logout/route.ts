import { NextResponse } from 'next/server';

import { ACCESS_COOKIE, ADMIN_PUBLIC_URL, REFRESH_COOKIE } from '@/lib/config';

export async function GET(): Promise<NextResponse> {
  const res = NextResponse.redirect(`${ADMIN_PUBLIC_URL}/`);
  res.cookies.delete(ACCESS_COOKIE);
  res.cookies.delete(REFRESH_COOKIE);
  return res;
}
