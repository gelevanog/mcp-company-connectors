/** Where the admin console reaches the gateway (server side) and where browsers are sent to sign in. */
export const GATEWAY_INTERNAL_URL = (process.env.GATEWAY_INTERNAL_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
export const GATEWAY_PUBLIC_URL = (process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');
export const ADMIN_PUBLIC_URL = (process.env.ADMIN_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const CLIENT_ID = 'switchboard-admin';
export const ACCESS_COOKIE = 'sb_admin_at';
export const REFRESH_COOKIE = 'sb_admin_rt';
export const FLOW_COOKIE = 'sb_admin_flow';
