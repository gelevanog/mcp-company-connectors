import { createModel } from '@switchboard/agent';
import { fakeScripts } from '@switchboard/gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runTask, summarize } from '../src/eval/runner.js';
import { answerHas, loadTasks, numbersIn } from '../src/eval/tasks.js';
import { type Stack, databaseAvailable, startStack } from './harness.js';

const available = await databaseAvailable();
const tasks = loadTasks();

describe('evaluation tasks', () => {
  it('are well formed: unique ids, known users, a reference plan for every task', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(30);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    for (const task of tasks) {
      expect(['alice', 'bruno', 'sam', 'tara', 'ana', 'adam'], task.id).toContain(task.user);
      expect(task.fake_plan, task.id).toBeDefined();
      expect(task.checks.length, task.id).toBeGreaterThan(0);
    }
  });

  it('matches numbers the way people write them', () => {
    expect(numbersIn('$1,277,000 and 120k and 1.2M')).toEqual([1277000, 120000, 1200000]);
    expect(answerHas('Total: 120,000 USD', '120000')).toBe(true);
    expect(answerHas('about $1.28M', '1277000')).toBe(true);
    expect(answerHas('T-1004 is closed', '4')).toBe(false);
    expect(answerHas('The rate is 55.1%.', '55.1')).toBe(true);
  });
});

describe.skipIf(!available)('agent loop with the deterministic offline model, through the gateway', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ evalMode: true, callsPerMinute: 1000, writesPerMinute: 1000 });
  });
  afterAll(async () => {
    await stack?.close();
  });

  it('every task passes with its reference plan (the checks are achievable)', async () => {
    const model = createModel({ provider: 'fake' }, { scripts: fakeScripts() });
    const results = [];
    for (const task of tasks) results.push(await runTask(task, { stack, model }));
    const failed = results.filter((r) => !r.success).map((r) => `${r.id}: ${r.checks.filter((c) => !c.pass).map((c) => c.detail).join('; ')}`);
    expect(failed).toEqual([]);
    const summary = summarize(results);
    expect(summary.confirmationsApproved).toBeGreaterThan(10);
    expect(summary.attacks.succeeded).toBe(0);
  });

  it('a gullible model attempts the planted injections; none succeeds', async () => {
    const model = createModel({ provider: 'fake', gullible: true }, { scripts: fakeScripts() });
    const injection = tasks.filter((task) => task.category === 'injection');
    const results = [];
    for (const task of injection) results.push(await runTask(task, { stack, model }));
    const attempted = results.filter((r) => r.attack?.attempted);
    expect(attempted.map((r) => r.id).sort()).toEqual(['p01', 'p05', 's09']);
    expect(results.filter((r) => r.attack?.succeeded)).toEqual([]);
  });

  it('exposing every tool (the ablation setting) lists more tools but still authorizes each call', async () => {
    const task = tasks.find((t) => t.id === 'a09');
    if (!task) throw new Error('a09 missing');
    const model = createModel({ provider: 'fake' }, { scripts: fakeScripts() });
    const filtered = await runTask(task, { stack, model });
    const all = await runTask(task, { stack, model, exposeAll: true });
    expect(filtered.promptToolCount).toBe(11);
    expect(all.promptToolCount).toBe(23);
    expect(all.unauthorizedAttempts).toBe(1);
    expect(all.success).toBe(true);
  });
});
