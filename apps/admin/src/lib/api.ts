import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { ACCESS_COOKIE, GATEWAY_INTERNAL_URL } from './config';

/** Server-side call to the gateway's admin API with the signed-in admin's token. */
export async function adminFetch<T>(path: string): Promise<T> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect('/login');
  const response = await fetch(`${GATEWAY_INTERNAL_URL}/admin/api${path}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (response.status === 401) redirect('/login');
  if (!response.ok) throw new Error(`admin API ${path}: ${response.status}`);
  return (await response.json()) as T;
}
