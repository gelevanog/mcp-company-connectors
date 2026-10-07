import { Card, Chip, PageHeader } from '@/components/ui';
import { adminFetch } from '@/lib/api';
import { ago } from '@/lib/format';

import { RevokeButton } from './RevokeButton';

export const dynamic = 'force-dynamic';

interface ClientsResponse {
  clients: { client_id: string; client_name: string; kind: string; redirect_uris: string[]; application_type: string | null; created_at: string; last_used_at: string | null }[];
  grants: { id: string; client_id: string; client_name: string | null; user_id: string; user_name: string | null; role: string | null; scope: string; resource: string; created_at: string; last_used_at: string; expires_at: string; revoked_at: string | null }[];
  activity: { user_id: string; role: string; client_id: string; client_name: string | null; calls: number; last_seen: string; denied: number }[];
}

const KIND: Record<string, string> = { dcr: 'dynamic registration', cimd: 'metadata document', first_party: 'first party' };

export default async function ClientsPage() {
  const data = await adminFetch<ClientsResponse>('/clients');
  return (
    <>
      <PageHeader
        title="Clients and sessions"
        subtitle="MCP 2026-07-28 has no protocol sessions, so a connected assistant is an OAuth grant (a refresh token for one user and one client) plus its recent traffic. Revoking a grant ends that connection at its next token refresh."
      />
      <div className="grid gap-4">
        <Card title="Active in the last 24 hours">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] text-slate-500 uppercase">
              <tr className="border-b border-rule">
                <th className="py-2 font-medium">User</th>
                <th className="py-2 font-medium">Client</th>
                <th className="py-2 text-right font-medium">Calls</th>
                <th className="py-2 text-right font-medium">Refused</th>
                <th className="py-2 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((row) => (
                <tr key={`${row.user_id}/${row.client_id}`} className="border-b border-rule/70 last:border-0">
                  <td className="py-1.5">{row.user_id} <span className="text-slate-400">· {row.role}</span></td>
                  <td className="py-1.5">{row.client_name ?? row.client_id}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.calls}</td>
                  <td className={`py-1.5 text-right tabular-nums ${row.denied > 0 ? 'text-rose-700' : 'text-slate-400'}`}>{row.denied}</td>
                  <td className="py-1.5 text-right text-slate-500">{ago(row.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="OAuth grants">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] text-slate-500 uppercase">
              <tr className="border-b border-rule">
                <th className="py-2 font-medium">Client</th>
                <th className="py-2 font-medium">User</th>
                <th className="py-2 font-medium">Scopes</th>
                <th className="py-2 font-medium">Resource</th>
                <th className="py-2 text-right font-medium">Last refresh</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {data.grants.map((grant) => (
                <tr key={grant.id} className={`border-b border-rule/70 align-top last:border-0 ${grant.revoked_at ? 'opacity-50' : ''}`}>
                  <td className="py-1.5">{grant.client_name ?? grant.client_id}</td>
                  <td className="py-1.5">{grant.user_name ?? grant.user_id} <span className="text-slate-400">· {grant.role}</span></td>
                  <td className="max-w-80 py-1.5"><div className="flex flex-wrap gap-1">{grant.scope.split(' ').map((s) => <Chip key={s}>{s}</Chip>)}</div></td>
                  <td className="py-1.5 font-mono text-[11px] text-slate-500">{new URL(grant.resource).pathname}</td>
                  <td className="py-1.5 text-right text-slate-500">{ago(grant.last_used_at)}</td>
                  <td className="py-1.5 text-right">{grant.revoked_at ? <span className="text-[11.5px] text-slate-500">revoked</span> : <RevokeButton id={grant.id} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.grants.length === 0 && <p className="text-[13px] text-slate-500">No grants yet: connect a client (see Connect).</p>}
        </Card>
        <Card title="Registered clients">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] text-slate-500 uppercase">
              <tr className="border-b border-rule">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">client_id</th>
                <th className="py-2 font-medium">Registration</th>
                <th className="py-2 font-medium">Redirect URIs</th>
                <th className="py-2 text-right font-medium">Last used</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((client) => (
                <tr key={client.client_id} className="border-b border-rule/70 align-top last:border-0">
                  <td className="py-1.5">{client.client_name}</td>
                  <td className="max-w-56 truncate py-1.5 font-mono text-[11px] text-slate-500">{client.client_id}</td>
                  <td className="py-1.5"><Chip tone={client.kind === 'dcr' ? 'amber' : 'signal'}>{KIND[client.kind] ?? client.kind}</Chip></td>
                  <td className="max-w-72 py-1.5 font-mono text-[11px] text-slate-500">{client.redirect_uris.join(' ') || '—'}</td>
                  <td className="py-1.5 text-right text-slate-500">{ago(client.last_used_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
