'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Overview', hint: 'traffic and health' },
  { href: '/playground', label: 'Playground', hint: 'try it as a user' },
  { href: '/tools', label: 'Tools per role', hint: 'who sees what' },
  { href: '/approvals', label: 'Approvals', hint: 'outbox and writes' },
  { href: '/audit', label: 'Audit log', hint: 'every call' },
  { href: '/clients', label: 'Clients', hint: 'apps and sessions' },
  { href: '/eval', label: 'Evaluation', hint: 'measured results' },
  { href: '/connect', label: 'Connect', hint: 'client configs' },
];

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="h-7 w-7 text-signal" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="currentColor" opacity=".15" />
      <circle cx="10" cy="11" r="2.6" fill="currentColor" />
      <circle cx="22" cy="11" r="2.6" fill="currentColor" />
      <circle cx="10" cy="21" r="2.6" fill="currentColor" />
      <circle cx="22" cy="21" r="2.6" fill="currentColor" />
      <path d="M10 11 C16 11 16 21 22 21 M10 21 C16 21 16 11 22 11" stroke="currentColor" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-60 shrink-0 bg-console text-slate-300">
      <div className="sticky top-0 flex h-screen flex-col">
      <div className="flex items-center gap-2.5 px-5 pt-6 pb-5">
        <Logo />
        <div>
          <div className="text-[15px] font-semibold tracking-wide text-white">Switchboard</div>
          <div className="text-[11px] text-slate-400">MCP gateway console</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3">
        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group flex items-center justify-between rounded-md px-3 py-2 text-[13.5px] ${active ? 'bg-console-2 text-white' : 'hover:bg-console-2/60 hover:text-white'}`}
            >
              <span className="flex items-center gap-2.5">
                <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-signal' : 'bg-slate-600 group-hover:bg-slate-400'}`} />
                {item.label}
              </span>
              <span className="text-[10.5px] text-slate-500">{item.hint}</span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-console-line px-5 py-4 text-[11px] leading-relaxed text-slate-500">
        Kestrel Cloud demo tenant
        <br />
        <a href="/logout" className="text-slate-400 hover:text-white">
          Sign out
        </a>
      </div>
      </div>
    </aside>
  );
}
