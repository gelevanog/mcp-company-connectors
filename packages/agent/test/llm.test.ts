import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BudgetedModel } from '../src/llm/budget.js';
import { FakeModel } from '../src/llm/fake.js';
import { ensureFreeModels } from '../src/llm/guards.js';
import { OpenAiCompatibleModel } from '../src/llm/openrouter.js';
import { BudgetExceededError, type ChatModel, type Completion, PolicyViolationError, RetryableLlmError } from '../src/llm/types.js';

const reply = (model: string, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model, choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 }, ...body }), { status: 200 });

describe('free-only guard', () => {
  it('refuses non-free model ids, fallbacks included', () => {
    expect(() => ensureFreeModels(['a/b:free', 'c/d'])).toThrow(PolicyViolationError);
    expect(() => new OpenAiCompatibleModel({ model: 'openai/gpt-x', apiKey: 'test', fetch })).toThrow(/free-only guard/);
    expect(() => new OpenAiCompatibleModel({ model: 'a/b:free', fallbackModels: ['c/d'], apiKey: 'test', fetch })).toThrow(/free-only guard/);
  });

  it('rejects an answer served by a non-free model', async () => {
    const model = new OpenAiCompatibleModel({ model: 'a/b:free', apiKey: 'test', fetch: async () => reply('a/b') });
    await expect(model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(/served non-free/);
  });

  it('sends model, fallbacks, tools and reasoning in the OpenRouter request shape', async () => {
    let sent: Record<string, unknown> = {};
    const model = new OpenAiCompatibleModel({
      model: 'a/b:free',
      fallbackModels: ['c/d:free'],
      apiKey: 'test',
      reasoningEffort: 'low',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return reply('c/d:free');
      },
    });
    const result = await model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }] });
    expect(sent).toMatchObject({ model: 'a/b:free', models: ['a/b:free', 'c/d:free'], tool_choice: 'auto', reasoning: { effort: 'low' }, temperature: 0 });
    expect(result.model).toBe('c/d:free');
  });

  it('maps 429 and 5xx to retryable errors', async () => {
    const model = new OpenAiCompatibleModel({ model: 'a/b:free', apiKey: 'test', fetch: async () => new Response('rate-limited upstream', { status: 429, headers: { 'retry-after': '2' } }) });
    const error = await model.complete({ messages: [], tools: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableLlmError);
    expect((error as RetryableLlmError).retryAfterSeconds).toBe(2);
  });
});

class Scripted implements ChatModel {
  readonly isLocal = false;
  readonly label = 'test/scripted';
  calls = 0;
  constructor(private readonly outcomes: (Completion | Error)[]) {}
  async complete(): Promise<Completion> {
    const next = this.outcomes[this.calls] ?? this.outcomes[this.outcomes.length - 1];
    this.calls += 1;
    if (next instanceof Error) throw next;
    if (!next) throw new Error('no outcome');
    return next;
  }
}

const done: Completion = { message: { role: 'assistant', content: 'ok' }, model: 'x/y:free', inputTokens: 5, outputTokens: 2, cached: false };

describe('budget wrapper', () => {
  it('retries, writes a ledger without prompts, and caches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-budget-'));
    const inner = new Scripted([new RetryableLlmError('upstream 429'), done]);
    const model = new BudgetedModel(inner, { ledgerPath: join(dir, 'calls.jsonl'), cacheDir: join(dir, 'cache'), maxCalls: 10, minIntervalMs: 0, retryBaseMs: 1, tag: 'test' });
    const request = { messages: [{ role: 'user' as const, content: 'secret prompt text' }], tools: [] };
    expect((await model.complete(request)).message.content).toBe('ok');
    const again = await model.complete(request);
    expect(again.cached).toBe(true);
    expect(inner.calls).toBe(2);
    const ledger = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ledger.map((entry) => entry.status)).toEqual(['retryable_error', 'ok']);
    expect(JSON.stringify(ledger)).not.toContain('secret prompt text');
  });

  it('stops at the hard call budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-budget-'));
    const model = new BudgetedModel(new Scripted([done]), { ledgerPath: join(dir, 'calls.jsonl'), cacheDir: undefined, maxCalls: 1, minIntervalMs: 0 });
    await model.complete({ messages: [{ role: 'user', content: 'a' }], tools: [] });
    await expect(model.complete({ messages: [{ role: 'user', content: 'b' }], tools: [] })).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('fake model', () => {
  it('follows a script one tool call per turn, then answers', async () => {
    const model = new FakeModel({ scripts: [{ prompt: 'Do the thing', steps: [{ tool: 'a', args: { x: 1 } }], answer: 'done' }] });
    const first = await model.complete({ messages: [{ role: 'user', content: 'Do the thing please' }], tools: [] });
    expect(first.message.tool_calls?.[0]?.function).toEqual({ name: 'a', arguments: '{"x":1}' });
    const second = await model.complete({
      messages: [
        { role: 'user', content: 'Do the thing please' },
        { role: 'assistant', content: null, tool_calls: first.message.tool_calls ?? [] },
        { role: 'tool', tool_call_id: 'fake_0', content: 'result' },
      ],
      tools: [],
    });
    expect(second.message.content).toBe('done');
  });
});
