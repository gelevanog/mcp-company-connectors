import { AuditTable } from '@/components/AuditTable';
import { Card, PageHeader, Stat } from '@/components/ui';
import { adminFetch } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AuditEntry, Overview } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [overview, audit] = await Promise.all([adminFetch<Overview>('/overview'), adminFetch<{ entries: AuditEntry[] }>('/audit?limit=12')]);
  const count = (names: string[]) => overview.decisions.filter((d) => names.includes(d.decision)).reduce((t, d) => t + d.n, 0);
  const total = overview.decisions.reduce((t, d) => t + d.n, 0);
  const refused = count(['denied_role', 'denied_scope', 'denied_disabled', 'rate_limited', 'blocked_untrusted_recipient', 'declined']);
  return (
    <>
      <PageHeader title={`${overview.tenant}: gateway overview`} subtitle="Every assistant connected to Switchboard goes through these checks: role, scope, confirmation for changes, rate limits, untrusted-content marking, audit. Last 24 hours." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Calls" value={total} note={`${count(['allowed', 'confirmed', 'replayed'])} completed`} />
        <Stat label="Refused or declined" value={refused} tone={refused > 0 ? 'bad' : 'default'} note="role, scope, limits, user" />
        <Stat label="Waiting for approval" value={overview.pending.emails + overview.pending.confirmations} tone={overview.pending.emails + overview.pending.confirmations > 0 ? 'warn' : 'default'} note={`${overview.pending.emails} emails · ${overview.pending.confirmations} changes`} />
        <Stat label="Injections flagged" value={overview.flagged} tone={overview.flagged > 0 ? 'bad' : 'good'} note="in untrusted content" />
        <Stat label="Active grants" value={overview.grants} note={`${overview.activeUsers} users active`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card title="Latest calls" action={<a className="text-[12px] text-teal-700 hover:underline" href="/audit">Full audit log →</a>}>
          <AuditTable entries={audit.entries} compact />
        </Card>
        <Card title={`Upstream MCP servers (${overview.tools} tools)`}>
          <ul className="space-y-2 text-[13px]">
            {Object.entries(overview.upstreams).map(([name, status]) => (
              <li key={name} className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${status.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                  <span className="font-mono">{name}</span>
                </span>
                <span className="text-slate-500">{status.ok ? `${status.tools} tools · ${ago(status.refreshedAt)}` : (status.error ?? 'unavailable')}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
