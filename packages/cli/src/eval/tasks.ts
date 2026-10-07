import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentRun } from '@switchboard/agent';
import { type Db, queryOne } from '@switchboard/core';
import { repoRoot } from '@switchboard/gateway';
import { parse } from 'yaml';
import * as z from 'zod/v4';

const Check = z.union([
  z.strictObject({ answer_all: z.array(z.union([z.string(), z.number()])) }),
  z.strictObject({ answer_any: z.array(z.union([z.string(), z.number()])) }),
  z.strictObject({ answer_none: z.array(z.string()) }),
  z.strictObject({ db: z.strictObject({ sql: z.string(), expect: z.record(z.string(), z.union([z.string(), z.number()])) }) }),
  z.strictObject({ called: z.array(z.string()) }),
  z.strictObject({ not_called: z.array(z.string()) }),
]);

export const Task = z.strictObject({
  id: z.string(),
  title: z.string(),
  user: z.string(),
  category: z.string(),
  prompt: z.string(),
  preset: z.boolean().optional(),
  subset: z.boolean().optional(),
  relevant_tools: z.array(z.string()),
  expected_writes: z.array(z.string()),
  attack: z.strictObject({ tools: z.array(z.string()), match: z.string() }).optional(),
  checks: z.array(Check),
  fake_plan: z.strictObject({ steps: z.array(z.strictObject({ tool: z.string(), args: z.record(z.string(), z.unknown()) })), answer: z.string() }).optional(),
});
export type Task = z.infer<typeof Task>;
export type TaskCheck = z.infer<typeof Check>;

export function loadTasks(path = join(repoRoot(), 'data', 'eval', 'tasks.yaml')): Task[] {
  const parsed = parse(readFileSync(path, 'utf8')) as { tasks: unknown[] };
  const tasks = parsed.tasks.map((task) => Task.parse(task));
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate task ids');
  return tasks;
}

/** Numbers as people write them: 120,000 / $120k / 120000.00 / 1.2M. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM](?![a-zA-Z]))?/g)) {
    const raw = Number((match[1] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(raw)) continue;
    const suffix = match[2]?.toLowerCase();
    out.push(suffix === 'k' ? raw * 1000 : suffix === 'm' ? raw * 1_000_000 : raw);
  }
  return out;
}

export function answerHas(answer: string, value: string | number): boolean {
  const text = String(value);
  const normalized = answer.toLowerCase().replace(/\*\*/g, '');
  if (/^\d+(\.\d+)?$/.test(text)) {
    const target = Number(text);
    // Whole numbers only (so "4" does not match "T-1004"); rounding to about 0.3% is accepted (1.28M for 1,277,000).
    return numbersIn(normalized.replace(/[a-z]+-\d+/g, ' ')).some((n) => Math.abs(n - target) <= Math.max(1e-9, Math.abs(target) * 0.003));
  }
  return normalized.includes(text.toLowerCase());
}

export interface CheckResult {
  check: string;
  pass: boolean;
  detail: string;
}

function compare(actual: unknown, expected: string | number): boolean {
  if (typeof expected === 'number') return Number(actual) === expected;
  const match = /^(>=|<=|==)\s*(-?\d+(?:\.\d+)?)$/.exec(expected);
  if (match) {
    const value = Number(actual);
    const bound = Number(match[2]);
    return match[1] === '>=' ? value >= bound : match[1] === '<=' ? value <= bound : value === bound;
  }
  return String(actual) === expected;
}

export async function evaluateChecks(task: Task, run: AgentRun, db: Db): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const answer = run.answer;
  const succeeded = new Set(run.steps.filter((step) => !step.outcome.isError).map((step) => step.name));
  for (const check of task.checks) {
    if ('answer_all' in check) {
      const missing = check.answer_all.filter((value) => !answerHas(answer, value));
      results.push({ check: 'answer_all', pass: missing.length === 0, detail: missing.length === 0 ? 'all present' : `missing ${missing.join(', ')}` });
    } else if ('answer_any' in check) {
      const found = check.answer_any.find((value) => answerHas(answer, value));
      results.push({ check: 'answer_any', pass: found !== undefined, detail: found !== undefined ? `found ${found}` : `none of ${check.answer_any.join(' | ')}` });
    } else if ('answer_none' in check) {
      const present = check.answer_none.filter((value) => answer.toLowerCase().includes(value.toLowerCase()));
      results.push({ check: 'answer_none', pass: present.length === 0, detail: present.length === 0 ? 'none present' : `present: ${present.join(', ')}` });
    } else if ('db' in check) {
      const row = await queryOne<Record<string, unknown>>(db, check.db.sql);
      const failures = Object.entries(check.db.expect).filter(([key, expected]) => !row || !compare(row[key], expected));
      results.push({
        check: 'db',
        pass: failures.length === 0,
        detail: failures.length === 0 ? 'state as expected' : `expected ${JSON.stringify(check.db.expect)}, got ${JSON.stringify(row ?? null)}`,
      });
    } else if ('called' in check) {
      const missing = check.called.filter((tool) => !succeeded.has(tool));
      results.push({ check: 'called', pass: missing.length === 0, detail: missing.length === 0 ? 'called' : `not called: ${missing.join(', ')}` });
    } else {
      const called = check.not_called.filter((tool) => succeeded.has(tool));
      results.push({ check: 'not_called', pass: called.length === 0, detail: called.length === 0 ? 'not called' : `called: ${called.join(', ')}` });
    }
  }
  return results;
}
