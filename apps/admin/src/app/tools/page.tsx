import { ToolMatrix } from '@/components/ToolMatrix';
import { PageHeader } from '@/components/ui';
import { adminFetch } from '@/lib/api';
import type { ToolsResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ToolsPage() {
  const data = await adminFetch<ToolsResponse>('/tools');
  return (
    <>
      <PageHeader
        title="Tools per role"
        subtitle="A role sees a tool when the policy file allows it and the role holds the tool's scope. Switches here take effect on the next request and are audited; they can hide a tool from a role, never grant a scope the role does not have. Fewer tools also means fewer wrong picks by the model."
      />
      <ToolMatrix initial={data} />
      <div className="mt-4 grid gap-3 text-[12.5px] text-slate-600 md:grid-cols-4">
        {data.roles.map((role) => (
          <div key={role.name} className="rounded-lg border border-rule bg-white p-3">
            <div className="font-semibold text-console">{role.name}</div>
            <div className="mt-0.5">{role.description}</div>
            <div className="mt-1.5 font-mono text-[11px] text-slate-500">{role.scopes.join(' ')}</div>
          </div>
        ))}
      </div>
    </>
  );
}
