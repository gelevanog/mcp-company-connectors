export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

/** Decision → badge style. Green: allowed; amber: waiting on a person; red: refused; violet: blocked as an attack. */
export function decisionTone(decision: string): string {
  if (decision === 'allowed' || decision === 'confirmed' || decision === 'replayed') return 'bg-emerald-50 text-emerald-800 ring-emerald-600/20';
  if (decision === 'confirmation_requested' || decision === 'awaiting_approval') return 'bg-amber-50 text-amber-800 ring-amber-600/25';
  if (decision === 'blocked_untrusted_recipient') return 'bg-violet-50 text-violet-800 ring-violet-600/25';
  if (decision === 'error' || decision === 'cancelled') return 'bg-slate-100 text-slate-700 ring-slate-500/20';
  return 'bg-rose-50 text-rose-800 ring-rose-600/20';
}

export const DECISION_LABEL: Record<string, string> = {
  allowed: 'allowed',
  confirmed: 'confirmed',
  replayed: 'replayed (idempotent)',
  confirmation_requested: 'asked user',
  awaiting_approval: 'awaiting approval',
  declined: 'declined by user',
  denied_role: 'denied: role',
  denied_scope: 'denied: scope',
  denied_disabled: 'denied: switched off',
  rate_limited: 'rate limited',
  blocked_untrusted_recipient: 'blocked: injection',
  auth_failed: 'auth failed',
  error: 'error',
  cancelled: 'cancelled',
};
