'use client';

import { Fragment, useState } from 'react';

import type { ToolsResponse } from '@/lib/types';

const REASON: Record<string, string> = {
  role: 'not in the role\'s allow-list',
  role_scope: 'the role does not hold this scope',
  disabled: 'switched off here',
};

export function ToolMatrix({ initial }: { initial: ToolsResponse }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(tool: string, role: string, enabled: boolean) {
    setBusy(`${tool}/${role}`);
    try {
      await fetch(`/api/admin/tools/${tool}/roles/${role}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      const fresh = (await (await fetch('/api/admin/tools')).json()) as ToolsResponse;
      setData(fresh);
    } finally {
      setBusy(null);
    }
  }

  const servers = [...new Set(data.tools.map((tool) => tool.upstream))];
  return (
    <div className="overflow-x-auto rounded-xl border border-rule bg-white">
      <table className="w-full text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-rule bg-slate-50/80 text-[11px] tracking-wide text-slate-500 uppercase">
            <th className="px-4 py-2.5 font-medium">Tool</th>
            <th className="px-2 py-2.5 font-medium">Scope</th>
            <th className="px-2 py-2.5 font-medium">Kind</th>
            {data.roles.map((role) => (
              <th key={role.name} className="px-2 py-2.5 text-center font-medium" title={role.description}>
                {role.name}
                <div className="text-[10px] font-normal tracking-normal text-slate-400 normal-case">
                  {data.tools.filter((tool) => tool.roles[role.name]?.enabled).length} tools
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <Fragment key={server}>
              <tr className="bg-slate-50/50">
                <td colSpan={3 + data.roles.length} className="px-4 pt-3 pb-1 font-mono text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  {server}
                </td>
              </tr>
              {data.tools
                .filter((tool) => tool.upstream === server)
                .map((tool) => (
                  <tr key={tool.name} className="border-b border-rule/70 last:border-0">
                    <td className="px-4 py-2" title={tool.description}>
                      <div className="font-mono text-[12px] text-console">{tool.name}</div>
                      <div className="text-[11.5px] text-slate-500">{tool.title}</div>
                    </td>
                    <td className="px-2 py-2 font-mono text-[11px] text-slate-600">{tool.scope}</td>
                    <td className="px-2 py-2">
                      {tool.write ? (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800" title={`destructive: ${String(tool.annotations.destructiveHint)}, idempotent: ${String(tool.annotations.idempotentHint)}`}>
                          write · confirm
                        </span>
                      ) : (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">read</span>
                      )}
                    </td>
                    {data.roles.map((role) => {
                      const access = tool.roles[role.name];
                      if (!access) return <td key={role.name} />;
                      const key = `${tool.name}/${role.name}`;
                      if (!access.scopeAllowed) {
                        return (
                          <td key={role.name} className="px-2 py-2 text-center text-[11px] text-slate-300" title="the role does not hold this scope">
                            no scope
                          </td>
                        );
                      }
                      return (
                        <td key={role.name} className="px-2 py-2 text-center">
                          <button
                            type="button"
                            disabled={busy === key}
                            onClick={() => toggle(tool.name, role.name, !access.enabled)}
                            title={access.enabled ? `visible to ${role.name}${access.override === true ? ' (switched on here)' : ''}` : (REASON[access.reason ?? ''] ?? 'hidden')}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${access.enabled ? 'bg-signal' : 'bg-slate-300'} ${busy === key ? 'opacity-50' : ''}`}
                          >
                            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition ${access.enabled ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                          </button>
                          {access.override !== null && <div className="mt-0.5 text-[9.5px] text-slate-400">override</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
