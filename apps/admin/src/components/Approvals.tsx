'use client';

import { useState } from 'react';

import { when } from '@/lib/format';

export interface EmailApproval {
  id: string;
  author_id: string;
  author_name: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  body: string;
  status: string;
  related_ticket: string | null;
  related_deal: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
}

export interface ConfirmationApproval {
  id: string;
  user_id: string;
  user_name: string | null;
  tool: string;
  summary: string;
  mode: string;
  status: string;
  created_at: string;
  expires_at: string;
  expired: boolean;
  decided_by: string | null;
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'pending' || status === 'pending_approval'
      ? 'bg-amber-50 text-amber-800 ring-amber-600/25'
      : status === 'approved' || status === 'used'
        ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/20'
        : 'bg-rose-50 text-rose-800 ring-rose-600/20';
  return <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}>{status.replace('_', ' ')}</span>;
}

export function Approvals({ emails: initialEmails, confirmations: initialConfirmations }: { emails: EmailApproval[]; confirmations: ConfirmationApproval[] }) {
  const [emails, setEmails] = useState(initialEmails);
  const [confirmations, setConfirmations] = useState(initialConfirmations);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const data = (await (await fetch('/api/admin/approvals')).json()) as { emails: EmailApproval[]; confirmations: ConfirmationApproval[] };
    setEmails(data.emails);
    setConfirmations(data.confirmations);
  }

  async function decide(kind: 'email' | 'confirmation', id: string, decision: 'approve' | 'reject') {
    setBusy(id);
    try {
      await fetch(`/api/admin/approvals/${kind}/${id}`, { method: 'POST', body: JSON.stringify({ decision }) });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const pendingEmails = emails.filter((email) => email.status === 'pending_approval');
  const pendingChanges = confirmations.filter((c) => c.mode === 'approval' && c.status === 'pending' && !c.expired);
  return (
    <div className="grid gap-5 2xl:grid-cols-2">
      <section>
        <h2 className="mb-2 text-[13px] font-semibold text-slate-800">
          Outbox <span className="ml-1 rounded bg-amber-50 px-1.5 text-amber-800">{pendingEmails.length} waiting</span>
        </h2>
        <p className="mb-3 text-[12.5px] text-slate-600">Emails an assistant submitted with email_send. Nothing leaves the machine: approving delivers to the sandbox mailbox.</p>
        <div className="space-y-3">
          {emails.map((email) => (
            <article key={email.id} className={`rounded-xl border bg-white p-4 ${email.status === 'pending_approval' ? 'border-amber-300' : 'border-rule'}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-semibold text-console">{email.subject}</div>
                  <div className="mt-0.5 text-[12px] text-slate-600">
                    <span className="font-mono">{email.id}</span> · from {email.author_name} to <span className="font-mono">{email.to_addresses.join(', ')}</span>
                    {email.related_ticket && <> · ticket {email.related_ticket}</>}
                    {email.related_deal && <> · deal {email.related_deal}</>}
                  </div>
                </div>
                <StatusPill status={email.status} />
              </div>
              <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 font-sans text-[12.5px] whitespace-pre-wrap text-slate-700">{email.body}</pre>
              <div className="mt-3 flex items-center justify-between text-[11.5px] text-slate-500">
                <span>submitted {when(email.submitted_at)}{email.decided_by && <> · decided by {email.decided_by} {when(email.decided_at)}</>}</span>
                {email.status === 'pending_approval' && (
                  <span className="flex gap-2">
                    <button disabled={busy === email.id} onClick={() => decide('email', email.id, 'reject')} className="rounded-md border border-rule px-3 py-1 text-[12.5px] hover:bg-slate-50">
                      Reject
                    </button>
                    <button disabled={busy === email.id} onClick={() => decide('email', email.id, 'approve')} className="rounded-md bg-signal px-3 py-1 text-[12.5px] font-medium text-white hover:brightness-110">
                      Approve and deliver
                    </button>
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-[13px] font-semibold text-slate-800">
          Changes waiting for approval <span className="ml-1 rounded bg-amber-50 px-1.5 text-amber-800">{pendingChanges.length} waiting</span>
        </h2>
        <p className="mb-3 text-[12.5px] text-slate-600">
          Writes from clients that cannot ask the user (no elicitation) for high-risk tools, and every write after content flagged as a possible prompt injection. The assistant retries with the request id after approval.
        </p>
        <div className="space-y-3">
          {confirmations.length === 0 && <p className="text-[12.5px] text-slate-500">Nothing yet.</p>}
          {confirmations.map((c) => (
            <article key={c.id} className={`rounded-xl border bg-white p-4 ${c.mode === 'approval' && c.status === 'pending' && !c.expired ? 'border-amber-300' : 'border-rule'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="text-[12px] text-slate-600">
                  <span className="font-mono text-console">{c.tool}</span> · {c.user_name ?? c.user_id} · <span className="font-mono">{c.id}</span> · {c.mode === 'approval' ? 'admin approval' : 'confirmation token'}
                </div>
                <StatusPill status={c.expired && c.status === 'pending' ? 'expired' : c.status} />
              </div>
              <pre className="mt-2 rounded-lg bg-slate-50 p-3 font-sans text-[12.5px] whitespace-pre-wrap text-slate-700">{c.summary}</pre>
              {c.mode === 'approval' && c.status === 'pending' && !c.expired && (
                <div className="mt-3 flex justify-end gap-2">
                  <button disabled={busy === c.id} onClick={() => decide('confirmation', c.id, 'reject')} className="rounded-md border border-rule px-3 py-1 text-[12.5px] hover:bg-slate-50">
                    Reject
                  </button>
                  <button disabled={busy === c.id} onClick={() => decide('confirmation', c.id, 'approve')} className="rounded-md bg-signal px-3 py-1 text-[12.5px] font-medium text-white hover:brightness-110">
                    Approve
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
