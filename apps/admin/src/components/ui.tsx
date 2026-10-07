import type { ReactNode } from 'react';

import { DECISION_LABEL, decisionTone } from '@/lib/format';

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-console">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-[13.5px] text-slate-600">{subtitle}</p>}
      </div>
      {children}
    </header>
  );
}

export function Card({ title, children, className = '', action }: { title?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-rule bg-white ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-slate-800">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone = 'default', note }: { label: string; value: ReactNode; tone?: 'default' | 'warn' | 'bad' | 'good'; note?: string }) {
  const color = tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-rose-700' : tone === 'good' ? 'text-emerald-700' : 'text-console';
  return (
    <div className="rounded-xl border border-rule bg-white px-4 py-3">
      <div className="text-[11.5px] font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`mt-1 text-[26px] font-semibold tabular-nums ${color}`}>{value}</div>
      {note && <div className="text-[11.5px] text-slate-500">{note}</div>}
    </div>
  );
}

export function DecisionBadge({ decision }: { decision: string }) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset ${decisionTone(decision)}`}>
      {DECISION_LABEL[decision] ?? decision}
    </span>
  );
}

export function Chip({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'signal' | 'amber' | 'rose' | 'violet' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    signal: 'bg-signal-soft text-teal-800',
    amber: 'bg-amber-50 text-amber-800',
    rose: 'bg-rose-50 text-rose-700',
    violet: 'bg-violet-50 text-violet-700',
  } as const;
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] ${tones[tone]}`}>{children}</span>;
}
