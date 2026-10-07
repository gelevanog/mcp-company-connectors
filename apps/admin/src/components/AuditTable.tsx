import { Chip, DecisionBadge } from '@/components/ui';
import { when } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';

export function AuditTable({ entries, compact = false }: { entries: AuditEntry[]; compact?: boolean }) {
  if (entries.length === 0) return <p className="text-[13px] text-slate-500">No calls yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12.5px]">
        <thead className="text-[11px] tracking-wide text-slate-500 uppercase">
          <tr className="border-b border-rule">
            <th className="py-2 pr-3 font-medium">Time</th>
            <th className="py-2 pr-3 font-medium">User</th>
            {!compact && <th className="py-2 pr-3 font-medium">Client</th>}
            <th className="py-2 pr-3 font-medium">Call</th>
            <th className="py-2 pr-3 font-medium">Decision</th>
            {!compact && <th className="py-2 pr-3 font-medium">Args hash</th>}
            <th className="py-2 pr-3 text-right font-medium">Result</th>
            <th className="py-2 pr-3 text-right font-medium">ms</th>
            {!compact && <th className="py-2 font-medium">Flags / reason</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-rule/70 align-top last:border-0">
              <td className="py-1.5 pr-3 whitespace-nowrap text-slate-500 tabular-nums">{when(entry.ts)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {entry.user_id ?? '—'} {entry.role && <span className="text-slate-400">· {entry.role}</span>}
              </td>
              {!compact && <td className="max-w-40 truncate py-1.5 pr-3 text-slate-600" title={entry.client_id ?? ''}>{entry.client_name ?? entry.client_id ?? '—'}</td>}
              <td className="py-1.5 pr-3">
                <span className="font-mono text-[12px] text-console">{entry.target ?? entry.method}</span>
                {entry.method !== 'tools/call' && <span className="ml-1 text-[11px] text-slate-400">{entry.method}</span>}
              </td>
              <td className="py-1.5 pr-3"><DecisionBadge decision={entry.decision} /></td>
              {!compact && <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-400">{entry.args_hash?.slice(0, 12) ?? ''}</td>}
              <td className="py-1.5 pr-3 text-right text-slate-600 tabular-nums">{entry.result_bytes ? `${(entry.result_bytes / 1024).toFixed(1)} kB` : ''}</td>
              <td className="py-1.5 pr-3 text-right text-slate-600 tabular-nums">{entry.latency_ms ?? ''}</td>
              {!compact && (
                <td className="max-w-96 py-1.5 text-slate-600">
                  <div className="flex flex-wrap gap-1">
                    {entry.flags.map((flag) => (
                      <Chip key={flag} tone={flag === 'injection_suspected' ? 'rose' : flag.startsWith('untrusted') ? 'amber' : flag.startsWith('confirmed') ? 'signal' : 'slate'}>{flag}</Chip>
                    ))}
                  </div>
                  {entry.reason && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-slate-500">{entry.reason}</div>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
