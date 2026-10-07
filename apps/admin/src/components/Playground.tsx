'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface Preset {
  id: string;
  user: string;
  prompt: string;
  title?: string;
}
interface ModelOption {
  provider: string;
  id: string;
  label: string;
}
interface User {
  id: string;
  name: string;
  role: string;
  title: string;
}
interface Outcome {
  isError: boolean;
  text: string;
  flags: string[];
  decision?: string;
  upstream?: string;
  latencyMs: number;
  confirmations: number;
}
type RunEvent =
  | { type: 'started'; user: string; role: string; model: string; tools: string[] }
  | { type: 'llm_call'; index: number; model: string; latencyMs: number; cached: boolean; toolCalls: number }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; outcome: Outcome }
  | { type: 'progress'; id: string; message: string }
  | { type: 'confirmation'; key: string; message: string }
  | { type: 'confirmation_answered'; key: string; action: string }
  | { type: 'answer'; text: string }
  | { type: 'done'; answer: string; llmCalls: number; latencyMs: number }
  | { type: 'error'; message: string };

function resultKind(outcome: Outcome): { label: string; tone: string } {
  if (!outcome.isError) return { label: 'ok', tone: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20' };
  if (/^Blocked:/.test(outcome.text)) return { label: 'blocked by Switchboard', tone: 'bg-violet-50 text-violet-800 ring-violet-600/25' };
  if (/not available to the|switched off|needs the .* scope/.test(outcome.text)) return { label: 'denied: role', tone: 'bg-rose-50 text-rose-800 ring-rose-600/20' };
  if (/declined this change/.test(outcome.text)) return { label: 'declined by user', tone: 'bg-rose-50 text-rose-800 ring-rose-600/20' };
  if (/REQUIRED/.test(outcome.text)) return { label: 'waiting for approval', tone: 'bg-amber-50 text-amber-800 ring-amber-600/25' };
  return { label: 'error', tone: 'bg-slate-100 text-slate-700 ring-slate-500/20' };
}

/** Renders a tool result, shading the [UNTRUSTED DATA ...] blocks the gateway inserted. */
function ResultText({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\[UNTRUSTED DATA [0-9a-f]{8} \|[^\]]*\][\s\S]*?\[\/UNTRUSTED DATA [0-9a-f]{8}\])/g), [text]);
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-slate-700">
      {parts.map((part, index) =>
        part.startsWith('[UNTRUSTED DATA') ? (
          <span key={index} className="untrusted rounded px-0.5 text-orange-950 ring-1 ring-orange-300">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </pre>
  );
}

export function Playground({ presets, models, users }: { presets: Preset[]; models: ModelOption[]; users: User[] }) {
  const [user, setUser] = useState(presets[0]?.user ?? users[0]?.id ?? 'alice');
  const [model, setModel] = useState(models.find((m) => m.provider === 'openrouter')?.id ?? 'fake');
  const [prompt, setPrompt] = useState(presets[0]?.prompt ?? '');
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const source = useRef<EventSource | null>(null);

  useEffect(() => () => source.current?.close(), []);

  async function start() {
    source.current?.close();
    setEvents([]);
    setAnswered({});
    setRunning(true);
    const response = await fetch('/api/admin/playground/runs', { method: 'POST', body: JSON.stringify({ user, prompt, model }) });
    const data = (await response.json()) as { id?: string; error?: string };
    if (!data.id) {
      setEvents([{ type: 'error', message: data.error ?? 'could not start' }]);
      setRunning(false);
      return;
    }
    setRunId(data.id);
    const es = new EventSource(`/api/admin/playground/runs/${data.id}/events`);
    source.current = es;
    es.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as RunEvent;
      setEvents((previous) => [...previous, event]);
      if (event.type === 'done' || event.type === 'error') {
        setRunning(false);
        es.close();
      }
    };
    es.onerror = () => {
      setRunning(false);
      es.close();
    };
  }

  async function answer(key: string, action: 'accept' | 'decline') {
    if (!runId) return;
    setAnswered((previous) => ({ ...previous, [key]: action }));
    await fetch(`/api/admin/playground/runs/${runId}/confirm`, { method: 'POST', body: JSON.stringify({ key, action }) });
  }

  const started = events.find((e): e is Extract<RunEvent, { type: 'started' }> => e.type === 'started');
  const results = new Map(events.filter((e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result').map((e) => [e.id, e.outcome]));
  const progress = new Map<string, string>();
  for (const e of events) if (e.type === 'progress') progress.set(e.id, e.message);
  const done = events.find((e): e is Extract<RunEvent, { type: 'done' }> => e.type === 'done');
  const llmCalls = events.filter((e) => e.type === 'llm_call').length;
  const toolCalls = events.filter((e) => e.type === 'tool_call').length;
  const flagged = [...results.values()].filter((o) => o.flags.includes('injection_suspected')).length;
  const selectedUser = users.find((u) => u.id === user);

  // A confirmation belongs to the tool call that was waiting for it (the last call before it without a result yet).
  const attached = new Set<string>();
  const confirmationsFor = (callIndex: number): Extract<RunEvent, { type: 'confirmation' }>[] => {
    const call = events[callIndex];
    if (!call || call.type !== 'tool_call') return [];
    const found: Extract<RunEvent, { type: 'confirmation' }>[] = [];
    for (let i = callIndex + 1; i < events.length; i += 1) {
      const e = events[i];
      if (!e || e.type === 'tool_call' || (e.type === 'tool_result' && e.id === call.id)) break;
      if (e.type === 'confirmation') found.push(e);
    }
    for (const c of found) attached.add(c.key);
    return found;
  };
  events.forEach((_, i) => confirmationsFor(i));
  const renderConfirmation = (event: Extract<RunEvent, { type: 'confirmation' }>, key: string) => {
    const decided = answered[event.key] ?? events.find((e): e is Extract<RunEvent, { type: 'confirmation_answered' }> => e.type === 'confirmation_answered' && e.key === event.key)?.action;
    return (
      <div key={key} className="mt-2.5 rounded-lg border-2 border-amber-300 bg-amber-50/70 p-3">
        <div className="text-[11px] font-semibold tracking-wide text-amber-800 uppercase">Confirmation requested through MCP elicitation</div>
        <pre className="mt-1.5 font-sans text-[13px] whitespace-pre-wrap text-slate-800">{event.message}</pre>
        {decided ? (
          <div className={`mt-2 text-[12.5px] font-medium ${decided === 'accept' ? 'text-emerald-700' : 'text-rose-700'}`}>{decided === 'accept' ? 'Approved by you' : 'Declined by you'}</div>
        ) : (
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={() => answer(event.key, 'accept')} className="rounded-md bg-signal px-3 py-1.5 text-[12.5px] font-medium text-white">
              Approve
            </button>
            <button type="button" onClick={() => answer(event.key, 'decline')} className="rounded-md border border-rule bg-white px-3 py-1.5 text-[12.5px]">
              Decline
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-rule bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-[11px] text-slate-500 uppercase">Act as</span>
            <select value={user} onChange={(e) => setUser(e.target.value)} className="rounded-md border border-rule bg-white px-2 py-1.5 text-[13px]">
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-[11px] text-slate-500 uppercase">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="rounded-md border border-rule bg-white px-2 py-1.5 text-[13px]">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setUser(preset.user);
                  setPrompt(preset.prompt);
                }}
                className="rounded-full border border-rule px-2.5 py-1 text-[11.5px] text-slate-600 hover:border-signal hover:text-teal-800"
              >
                {preset.title ?? preset.id}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex gap-3">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} className="flex-1 rounded-lg border border-rule px-3 py-2 text-[14px] focus:border-signal focus:outline-none" />
          <button type="button" disabled={running || !prompt.trim()} onClick={start} className="self-stretch rounded-lg bg-console px-5 text-[13.5px] font-medium text-white disabled:opacity-50">
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>

      {events.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[1fr_260px]">
          <ol className="min-w-0 space-y-2.5">
            {started && (
              <li className="rounded-lg border border-rule bg-white px-4 py-2.5 text-[12.5px] text-slate-600">
                Connected to the gateway over MCP as <strong className="text-console">{selectedUser?.name ?? started.user}</strong> ({started.role}). The model sees{' '}
                <strong className="text-console">{started.tools.length} tools</strong> for this role · <span className="font-mono">{started.model}</span>
              </li>
            )}
            {events.map((event, index) => {
              if (event.type === 'tool_call') {
                const outcome = results.get(event.id);
                const kind = outcome ? resultKind(outcome) : undefined;
                return (
                  <li key={index} className="rounded-lg border border-rule bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-console px-1.5 py-0.5 font-mono text-[11px] text-white">tool</span>
                        <span className="font-mono text-[13px] text-console">{event.name}</span>
                        {outcome?.upstream && <span className="text-[11px] text-slate-400">→ {outcome.upstream} server</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {outcome?.flags.filter((f) => f !== 'untrusted:0').map((flag) => (
                          <span key={flag} className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] ${flag === 'injection_suspected' ? 'bg-rose-50 text-rose-700' : flag.startsWith('untrusted') ? 'bg-orange-50 text-orange-800' : 'bg-signal-soft text-teal-800'}`}>
                            {flag}
                          </span>
                        ))}
                        {kind && <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${kind.tone}`}>{kind.label}</span>}
                        {outcome && <span className="text-[11px] text-slate-400 tabular-nums">{outcome.latencyMs} ms</span>}
                        {!outcome && <span className="text-[11px] text-slate-400">{progress.get(event.id) ?? 'running…'}</span>}
                      </div>
                    </div>
                    <pre className="mt-1.5 font-mono text-[11.5px] break-all whitespace-pre-wrap text-slate-500">{JSON.stringify(event.args)}</pre>
                    {confirmationsFor(index).map((c) => renderConfirmation(c, c.key))}
                    {outcome && (
                      <details className="mt-1.5" open={outcome.isError || outcome.flags.includes('injection_suspected')}>
                        <summary className="cursor-pointer text-[11.5px] text-slate-500">result</summary>
                        <ResultText text={outcome.text.length > 2400 ? `${outcome.text.slice(0, 2400)}\n…` : outcome.text} />
                      </details>
                    )}
                  </li>
                );
              }
              if (event.type === 'confirmation' && attached.has(event.key)) return null;
              if (event.type === 'confirmation') {
                return <li key={index}>{renderConfirmation(event, event.key)}</li>;
              }
              if (event.type === 'llm_call') {
                return (
                  <li key={index} className="pl-3 text-[11.5px] text-slate-400">
                    model call {event.index} · {event.cached ? 'cache' : `${(event.latencyMs / 1000).toFixed(1)} s`} · {event.toolCalls > 0 ? `${event.toolCalls} tool call${event.toolCalls > 1 ? 's' : ''}` : 'answer'}
                  </li>
                );
              }
              if (event.type === 'answer') {
                return (
                  <li key={index} className="rounded-lg border border-signal/40 bg-white p-4">
                    <div className="mb-1 text-[11px] font-semibold tracking-wide text-teal-800 uppercase">Answer</div>
                    <div className="text-[14px] leading-relaxed whitespace-pre-wrap text-slate-800">{event.text}</div>
                  </li>
                );
              }
              if (event.type === 'error') {
                return (
                  <li key={index} className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800">
                    {event.message}
                  </li>
                );
              }
              return null;
            })}
          </ol>
          <aside className="space-y-2 text-[12.5px]">
            <div className="rounded-lg border border-rule bg-white p-3">
              <div className="text-[11px] text-slate-500 uppercase">This run</div>
              <dl className="mt-1.5 grid grid-cols-2 gap-y-1">
                <dt className="text-slate-500">Model calls</dt>
                <dd className="text-right tabular-nums">{llmCalls}</dd>
                <dt className="text-slate-500">Tool calls</dt>
                <dd className="text-right tabular-nums">{toolCalls}</dd>
                <dt className="text-slate-500">Confirmations</dt>
                <dd className="text-right tabular-nums">{events.filter((e) => e.type === 'confirmation').length}</dd>
                <dt className="text-slate-500">Injections flagged</dt>
                <dd className={`text-right tabular-nums ${flagged > 0 ? 'text-rose-700' : ''}`}>{flagged}</dd>
                <dt className="text-slate-500">Time</dt>
                <dd className="text-right tabular-nums">{done ? `${(done.latencyMs / 1000).toFixed(1)} s` : '…'}</dd>
              </dl>
            </div>
            {started && (
              <div className="rounded-lg border border-rule bg-white p-3">
                <div className="text-[11px] text-slate-500 uppercase">Tools this role sees</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {started.tools.map((tool) => (
                    <span key={tool} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600">
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
