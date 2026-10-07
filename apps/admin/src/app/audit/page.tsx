import { AuditTable } from '@/components/AuditTable';
import { Card, PageHeader } from '@/components/ui';
import { adminFetch } from '@/lib/api';
import { DECISION_LABEL } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function AuditPage({ searchParams }: PageProps<'/audit'>) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['user', 'decision', 'target', 'flag']) {
    const value = params[key];
    if (typeof value === 'string' && value) query.set(key, value);
  }
  query.set('limit', '100');
  const { entries } = await adminFetch<{ entries: AuditEntry[] }>(`/audit?${query.toString()}`);
  const value = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="One row per tool call, resource read, prompt and sign-in failure: who, which client, what, a keyed hash of the arguments (never the arguments themselves), result size, decision and latency."
      />
      <form className="mb-4 flex flex-wrap items-end gap-2 text-[13px]">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-500 uppercase">User</span>
          <input name="user" defaultValue={value('user')} placeholder="sam" className="w-28 rounded-md border border-rule bg-white px-2 py-1.5" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-500 uppercase">Decision</span>
          <select name="decision" defaultValue={value('decision')} className="rounded-md border border-rule bg-white px-2 py-1.5">
            <option value="">any</option>
            {Object.entries(DECISION_LABEL).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-500 uppercase">Tool or URI</span>
          <input name="target" defaultValue={value('target')} placeholder="email_" className="w-40 rounded-md border border-rule bg-white px-2 py-1.5" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-500 uppercase">Flag</span>
          <select name="flag" defaultValue={value('flag')} className="rounded-md border border-rule bg-white px-2 py-1.5">
            <option value="">any</option>
            <option value="injection_suspected">injection_suspected</option>
            <option value="tainted_session">tainted_session</option>
            <option value="idempotent_replay">idempotent_replay</option>
          </select>
        </label>
        <button className="rounded-md bg-console px-3 py-1.5 text-white">Filter</button>
        <a href="/audit" className="px-2 py-1.5 text-slate-500 hover:text-console">Clear</a>
      </form>
      <Card>
        <AuditTable entries={entries} />
      </Card>
    </>
  );
}
