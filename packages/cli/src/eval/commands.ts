import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BudgetedModel, type ChatModel, OpenAiCompatibleModel, createModel, ensureFreeModels } from '@switchboard/agent';
import { databaseUrl } from '@switchboard/core';
import { fakeScripts, repoRoot } from '@switchboard/gateway';
import type { Command } from 'commander';

import { type TaskResult, runTask, summarize } from './runner.js';
import { startStack } from './stack.js';
import { loadTasks } from './tasks.js';

const resultsDir = () => process.env.SWITCHBOARD_RESULTS_DIR ?? join(repoRoot(), 'results');
const ledgerPath = () => process.env.SWITCHBOARD_LLM_LEDGER ?? join(resultsDir(), 'calls.jsonl');
const cacheDir = () => process.env.SWITCHBOARD_LLM_CACHE_DIR ?? join(repoRoot(), '.cache', 'llm');

function writeJson(name: string, value: unknown): string {
  mkdirSync(resultsDir(), { recursive: true });
  const path = join(resultsDir(), name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

interface RunOptions {
  name: string;
  provider: 'fake' | 'openrouter';
  model?: string;
  fallbacks?: string;
  tasks?: string;
  subset?: boolean;
  exposeAll?: boolean;
  gullible?: boolean;
}

export function registerEvalCommands(program: Command): void {
  const evalCommand = program.command('eval').description('Evaluation: free-model smoke test, task runs, summaries, the call ledger');

  evalCommand
    .command('free-models')
    .description('List the free OpenRouter models that support tool calling (no key needed)')
    .action(async () => {
      const response = await fetch('https://openrouter.ai/api/v1/models');
      const data = (await response.json()) as { data: { id: string; context_length?: number; supported_parameters?: string[] }[] };
      const free = data.data
        .filter((model) => model.id.endsWith(':free'))
        .map((model) => ({ id: model.id, context_length: model.context_length ?? null, tools: (model.supported_parameters ?? []).includes('tools') }));
      const path = writeJson('free_models.json', { fetched_at: new Date().toISOString(), models: free });
      for (const model of free) console.log(`${model.tools ? 'tools' : '     '}  ${model.id}`);
      console.log(`wrote ${path}`);
    });

  evalCommand
    .command('smoke')
    .description('One tool-calling request per free model, to pick models that work today')
    .requiredOption('--models <ids>', 'comma-separated OpenRouter ids (each must end in :free)')
    .action(async (opts: { models: string }) => {
      const models = list(opts.models);
      ensureFreeModels(models);
      const results = [];
      for (const id of models) {
        const inner = new OpenAiCompatibleModel({ model: id, apiKey: process.env.OPENROUTER_API_KEY ?? '', reasoningEffort: 'low' });
        const model = new BudgetedModel(inner, {
          ledgerPath: ledgerPath(), cacheDir: cacheDir(), maxCalls: Number(process.env.SWITCHBOARD_LLM_MAX_CALLS ?? 500),
          minIntervalMs: 3000, maxRetries: 2, tag: `smoke:${id}`, requestedModels: { model: id, fallbacks: [] },
        });
        const started = Date.now();
        try {
          const completion = await model.complete({
            messages: [
              { role: 'system', content: 'You are an assistant with tools. Today is 2026-10-01.' },
              { role: 'user', content: 'Which open tickets does ACME Logistics have? Use the tool.' },
            ],
            tools: [{
              type: 'function',
              function: {
                name: 'helpdesk_search_tickets',
                description: 'Find support tickets by company and status',
                parameters: { type: 'object', properties: { company: { type: 'string' }, status: { type: 'array', items: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] } } }, required: [] },
              },
            }],
          });
          const call = completion.message.tool_calls?.[0];
          const args = call ? (JSON.parse(call.function.arguments || '{}') as Record<string, unknown>) : {};
          const ok = call?.function.name === 'helpdesk_search_tickets' && /acme/i.test(String(args.company ?? ''));
          results.push({ model: id, ok, served: completion.model, tool_call: call?.function ?? null, latency_s: (Date.now() - started) / 1000 });
          console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} ${((Date.now() - started) / 1000).toFixed(1)} s ${call ? call.function.arguments : completion.message.content?.slice(0, 80)}`);
        } catch (error) {
          results.push({ model: id, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error), latency_s: (Date.now() - started) / 1000 });
          console.log(`FAIL ${id} ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
        }
      }
      writeJson('smoke.json', { date: new Date().toISOString(), results });
    });

  evalCommand
    .command('run')
    .description('Run the tasks through the gateway with an agent loop and score them')
    .requiredOption('--name <name>', 'result file name (results/<name>.json)')
    .option('--provider <provider>', 'fake | openrouter', 'fake')
    .option('--model <id>', 'OpenRouter model id (must end in :free)')
    .option('--fallbacks <ids>', 'comma-separated free fallback models', '')
    .option('--tasks <ids>', 'comma-separated task ids')
    .option('--subset', 'only the tasks marked subset (ablation and model comparison)')
    .option('--expose-all', 'list every tool to every user (calls are still authorized): the ablation')
    .option('--gullible', 'offline model that obeys injected instructions (fake provider)')
    .action(async (opts: RunOptions) => {
      const tasks = loadTasks().filter((task) => (opts.tasks ? list(opts.tasks).includes(task.id) : opts.subset ? task.subset : true));
      let model: ChatModel;
      if (opts.provider === 'openrouter') {
        const fallbacks = list(opts.fallbacks);
        if (!opts.model) throw new Error('--model is required with --provider openrouter');
        ensureFreeModels([opts.model, ...fallbacks]);
        model = createModel({ provider: 'openrouter', model: opts.model, fallbacks, tag: `eval:${opts.name}` }, { ledgerPath: ledgerPath(), cacheDir: cacheDir() });
      } else {
        model = createModel({ provider: 'fake', gullible: opts.gullible ?? false }, { scripts: fakeScripts() });
      }
      const stack = await startStack({ databaseUrl: process.env.EVAL_DATABASE_URL ?? databaseUrl(), evalMode: true, callsPerMinute: 1000, writesPerMinute: 1000 });
      const results: TaskResult[] = [];
      const startedAt = new Date().toISOString();
      try {
        for (const [index, task] of tasks.entries()) {
          console.log(`[${index + 1}/${tasks.length}] ${task.id} (${task.user}) ${task.title}`);
          const result = await runTask(task, { stack, model, exposeAll: opts.exposeAll ?? false, onProgress: (line) => console.log(line) });
          results.push(result);
          const failed = result.checks.filter((check) => !check.pass).map((check) => `${check.check}: ${check.detail}`);
          console.log(`  ${result.success ? 'PASS' : 'FAIL'} ${result.llmCalls} LLM calls, ${result.toolCalls} tool calls, ${(result.latencyMs / 1000).toFixed(1)} s${failed.length ? ` | ${failed.join('; ')}` : ''}${result.error ? ` | error: ${result.error}` : ''}`);
          writeJson(`${opts.name}.json`, {
            meta: { name: opts.name, provider: opts.provider, model: opts.model ?? model.label, fallbacks: list(opts.fallbacks), exposeAll: opts.exposeAll ?? false, startedAt, finishedAt: null, tasks: tasks.length },
            summary: summarize(results),
            results,
          });
        }
      } finally {
        await stack.close();
      }
      const summary = summarize(results);
      const path = writeJson(`${opts.name}.json`, {
        meta: { name: opts.name, provider: opts.provider, model: opts.model ?? model.label, fallbacks: list(opts.fallbacks), exposeAll: opts.exposeAll ?? false, startedAt, finishedAt: new Date().toISOString(), tasks: tasks.length },
        summary,
        results,
      });
      console.log(`\n${summary.succeeded}/${summary.tasks} tasks succeeded (${summary.successRate}%) · ${summary.llmCalls} LLM calls · wrong-tool ${summary.wrongToolRate}% · unauthorized attempts ${summary.unauthorizedAttempts} · p50 ${(summary.latency.p50 / 1000).toFixed(1)} s`);
      console.log(`wrote ${path}`);
      process.exit(0);
    });

  evalCommand
    .command('ledger')
    .description('Summarize the call ledger into results/calls_summary.json')
    .action(() => {
      const path = ledgerPath();
      const rows = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
      const count = (key: string) => rows.reduce<Record<string, number>>((acc, row) => {
        const value = String(row[key] ?? '');
        acc[value] = (acc[value] ?? 0) + 1;
        return acc;
      }, {});
      const requested = [...new Set(rows.flatMap((row) => [String(row.requested_model ?? ''), ...((row.fallback_models as string[] | undefined) ?? [])]).filter(Boolean))].sort();
      const served = rows.filter((row) => row.served_model).reduce<Record<string, number>>((acc, row) => {
        const id = String(row.served_model);
        acc[id] = (acc[id] ?? 0) + 1;
        return acc;
      }, {});
      const tagGroup = rows.reduce<Record<string, number>>((acc, row) => {
        const tag = String(row.tag ?? '').split(':').slice(0, 2).join(':');
        acc[tag] = (acc[tag] ?? 0) + 1;
        return acc;
      }, {});
      const summary = {
        total_requests: rows.length,
        by_status: count('status'),
        by_tag: tagGroup,
        requested_models: requested,
        served_models: served,
        all_model_ids_free: requested.every((id) => id.endsWith(':free')) && Object.keys(served).every((id) => id.endsWith(':free')),
        input_tokens: rows.reduce((t, row) => t + Number(row.input_tokens ?? 0), 0),
        output_tokens: rows.reduce((t, row) => t + Number(row.output_tokens ?? 0), 0),
        first_call: rows[0]?.ts ?? null,
        last_call: rows[rows.length - 1]?.ts ?? null,
      };
      writeJson('calls_summary.json', summary);
      console.log(JSON.stringify(summary, null, 2));
    });

  evalCommand
    .command('summary')
    .description('Combine the run files into results/summary.json (README tables and the admin evaluation page)')
    .action(() => {
      const dir = resultsDir();
      const runs: Record<string, { meta: Record<string, unknown>; summary: ReturnType<typeof summarize>; results: TaskResult[] }> = {};
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const content = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
        if (content.meta && content.summary && content.results) runs[file.replace(/\.json$/, '')] = content as (typeof runs)[string];
      }
      const brief = Object.fromEntries(
        Object.entries(runs).map(([name, run]) => [
          name,
          {
            meta: run.meta,
            summary: run.summary,
            tasks: run.results.map((r) => ({
              id: r.id, title: r.title, user: r.user, role: r.role, category: r.category, success: r.success, llmCalls: r.llmCalls,
              toolCalls: r.toolCalls, wrongToolCalls: r.wrongToolCalls, unauthorizedAttempts: r.unauthorizedAttempts, confirmations: r.confirmationsRequested,
              latencyMs: r.latencyMs, attack: r.attack ?? null, failed: r.checks.filter((c) => !c.pass).map((c) => `${c.check}: ${c.detail}`), error: r.error ?? null,
            })),
          },
        ]),
      );
      const path = writeJson('summary.json', { generated_at: new Date().toISOString(), runs: brief });
      console.log(`wrote ${path} (${Object.keys(brief).join(', ')})`);
    });
}
