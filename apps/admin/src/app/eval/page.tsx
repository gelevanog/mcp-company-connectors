import { Card, PageHeader, Stat } from '@/components/ui';
import { adminFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface RunSummary {
  tasks: number;
  succeeded: number;
  successRate: number;
  byRole: Record<string, { tasks: number; succeeded: number }>;
  byCategory: Record<string, { tasks: number; succeeded: number }>;
  toolCalls: number;
  toolErrorRate: number;
  wrongToolRate: number;
  unauthorizedAttempts: number;
  confirmationsRequested: number;
  attacks: { tasks: number; attempted: number; attempts: number; succeeded: number; blocked: number };
  llmCallsPerTask: number;
  meanPromptTools: number;
  inputTokensPerTask: number;
  latency: { p50: number; p95: number };
}
interface TaskRow {
  id: string;
  title: string;
  user: string;
  role: string;
  category: string;
  success: boolean;
  llmCalls: number;
  toolCalls: number;
  wrongToolCalls: number;
  unauthorizedAttempts: number;
  confirmations: number;
  latencyMs: number;
  attack: { attempted: boolean; succeeded: boolean; attempts: number; blockedBy: string[] } | null;
  failed: string[];
}
interface Run {
  meta: { name: string; provider: string; model: string; exposeAll: boolean; startedAt: string; finishedAt: string | null };
  summary: RunSummary;
  tasks: TaskRow[];
}

const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((1000 * a) / b) / 10}%`);
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export default async function EvalPage() {
  const { summary } = await adminFetch<{ summary: { generated_at: string; runs: Record<string, Run> } | null }>('/eval');
  if (!summary) {
    return (
      <>
        <PageHeader title="Evaluation" />
        <Card>No results yet. Run <code>switchboard eval run</code>, then <code>switchboard eval summary</code>.</Card>
      </>
    );
  }
  const ORDER = ['main', 'ablation_all_tools', 'model_ling_3_flash', 'model_dots_3', 'main_rerun', 'main_rerun_pii', 'model_ling_3_flash_rerun', 'model_dots_3_rerun', 'fake', 'fake_gullible'];
  const runs = Object.entries(summary.runs).sort(([a], [b]) => (ORDER.indexOf(a) + 100) % 100 - (ORDER.indexOf(b) + 100) % 100);
  const main = summary.runs.main;
  return (
    <>
      <PageHeader
        title="Evaluation"
        subtitle={`Hand-written multi-system tasks (written by an AI agent, Claude, for this repository) run through the gateway by an agent loop with free OpenRouter models, as different roles. Success is checked against the database state and the answer. Generated ${summary.generated_at.slice(0, 10)}.`}
      />
      {main && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Task success" value={`${main.summary.successRate}%`} note={`${main.summary.succeeded}/${main.summary.tasks} · ${main.meta.model.replace(/^openrouter\//, '')}`} tone="good" />
          <Stat label="Injection attempts succeeded" value={main.summary.attacks.succeeded} tone={main.summary.attacks.succeeded > 0 ? 'bad' : 'good'} note={`${main.summary.attacks.attempts} attempts in ${main.summary.attacks.tasks} tasks`} />
          <Stat label="Unauthorized attempts" value={main.summary.unauthorizedAttempts} note="calls the gateway denied" />
          <Stat label="Model calls per task" value={main.summary.llmCallsPerTask} note={`${main.summary.meanPromptTools} tools in the prompt`} />
          <Stat label="Latency p50" value={sec(main.summary.latency.p50)} note={`p95 ${sec(main.summary.latency.p95)}`} />
        </div>
      )}
      <Card title="Runs" className="mb-5">
        <table className="w-full text-left text-[12.5px]">
          <thead className="text-[11px] text-slate-500 uppercase">
            <tr className="border-b border-rule">
              <th className="py-2 font-medium">Run</th>
              <th className="py-2 font-medium">Model</th>
              <th className="py-2 font-medium">Tools listed</th>
              <th className="py-2 text-right font-medium">Success</th>
              <th className="py-2 text-right font-medium">Wrong tool</th>
              <th className="py-2 text-right font-medium">Unauthorized</th>
              <th className="py-2 text-right font-medium">Tool errors</th>
              <th className="py-2 text-right font-medium">Calls/task</th>
              <th className="py-2 text-right font-medium">Prompt tokens</th>
              <th className="py-2 text-right font-medium">p50</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(([name, run]) => (
              <tr key={name} className="border-b border-rule/70 last:border-0">
                <td className="py-1.5 font-mono">{name}</td>
                <td className="py-1.5 font-mono text-[11.5px] text-slate-600">{run.meta.model.replace(/^openrouter\//, '')}</td>
                <td className="py-1.5">{run.meta.exposeAll ? 'all 23' : `role (${run.summary.meanPromptTools})`}</td>
                <td className="py-1.5 text-right tabular-nums">{run.summary.succeeded}/{run.summary.tasks} ({run.summary.successRate}%)</td>
                <td className="py-1.5 text-right tabular-nums">{run.summary.wrongToolRate}%</td>
                <td className="py-1.5 text-right tabular-nums">{run.summary.unauthorizedAttempts}</td>
                <td className="py-1.5 text-right tabular-nums">{run.summary.toolErrorRate}%</td>
                <td className="py-1.5 text-right tabular-nums">{run.summary.llmCallsPerTask}</td>
                <td className="py-1.5 text-right tabular-nums">{run.summary.inputTokensPerTask.toLocaleString('en')}</td>
                <td className="py-1.5 text-right tabular-nums">{sec(run.summary.latency.p50)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {main && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card title="Main run by role and category">
            <div className="grid grid-cols-2 gap-6 text-[12.5px]">
              {[main.summary.byRole, main.summary.byCategory].map((groups, index) => (
                <table key={index} className="w-full">
                  <tbody>
                    {Object.entries(groups).map(([key, value]) => (
                      <tr key={key} className="border-b border-rule/70 last:border-0">
                        <td className="py-1.5">{key}</td>
                        <td className="py-1.5 text-right tabular-nums">{value.succeeded}/{value.tasks}</td>
                        <td className="w-16 py-1.5 text-right text-slate-500 tabular-nums">{pct(value.succeeded, value.tasks)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </div>
          </Card>
          <Card title="Prompt injection and policy tasks (main run)">
            <table className="w-full text-left text-[12.5px]">
              <tbody>
                {main.tasks.filter((t) => t.attack).map((t) => (
                  <tr key={t.id} className="border-b border-rule/70 align-top last:border-0">
                    <td className="py-1.5 font-mono">{t.id}</td>
                    <td className="py-1.5">{t.title}</td>
                    <td className="py-1.5 text-right">{t.attack?.attempted ? `${t.attack.attempts} attempt(s)` : 'model ignored it'}</td>
                    <td className="py-1.5 text-right text-[11.5px] text-slate-600">{t.attack?.succeeded ? <span className="text-rose-700">succeeded</span> : t.attack?.blockedBy.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Every task (main run)" className="xl:col-span-2">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-[11px] text-slate-500 uppercase">
                <tr className="border-b border-rule">
                  <th className="py-2 font-medium">Task</th>
                  <th className="py-2 font-medium">User</th>
                  <th className="py-2 font-medium">Result</th>
                  <th className="py-2 text-right font-medium">Model calls</th>
                  <th className="py-2 text-right font-medium">Tool calls</th>
                  <th className="py-2 text-right font-medium">Confirmations</th>
                  <th className="py-2 text-right font-medium">Time</th>
                  <th className="py-2 pl-4 font-medium">Why it failed</th>
                </tr>
              </thead>
              <tbody>
                {main.tasks.map((t) => (
                  <tr key={t.id} className="border-b border-rule/70 align-top last:border-0">
                    <td className="py-1.5"><span className="font-mono text-slate-500">{t.id}</span> {t.title}</td>
                    <td className="py-1.5">{t.user} <span className="text-slate-400">· {t.role}</span></td>
                    <td className="py-1.5">{t.success ? <span className="text-emerald-700">pass</span> : <span className="text-rose-700">fail</span>}</td>
                    <td className="py-1.5 text-right tabular-nums">{t.llmCalls}</td>
                    <td className="py-1.5 text-right tabular-nums">{t.toolCalls}</td>
                    <td className="py-1.5 text-right tabular-nums">{t.confirmations}</td>
                    <td className="py-1.5 text-right tabular-nums">{sec(t.latencyMs)}</td>
                    <td className="max-w-96 py-1.5 pl-4 text-[11.5px] text-slate-600">{t.failed.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}
