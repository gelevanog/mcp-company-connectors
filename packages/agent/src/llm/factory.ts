import { join } from 'node:path';

import { BudgetedModel } from './budget.js';
import { FakeModel, type FakeScript } from './fake.js';
import { OpenAiCompatibleModel } from './openrouter.js';
import type { ChatModel } from './types.js';

export interface ModelSpec {
  provider: 'fake' | 'openrouter';
  model?: string;
  fallbacks?: string[];
  gullible?: boolean;
  tag?: string;
}

/** Recently working free models (smoke-tested on 2026-10-07); override with SWITCHBOARD_LLM_MODEL. */
export const DEFAULT_FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
export const DEFAULT_FREE_FALLBACKS = ['nvidia/nemotron-3-ultra-550b-a55b:free'];

export function envList(name: string): string[] | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export interface ModelFactoryOptions {
  scripts?: FakeScript[];
  ledgerPath?: string | undefined;
  cacheDir?: string | undefined;
}

/** A model from the environment: SWITCHBOARD_LLM_PROVIDER=fake (default) | openrouter. */
export function createModel(spec: ModelSpec, options: ModelFactoryOptions = {}): ChatModel {
  if (spec.provider === 'fake') return new FakeModel({ scripts: options.scripts ?? [], gullible: spec.gullible ?? false });
  const model = spec.model ?? process.env.SWITCHBOARD_LLM_MODEL ?? DEFAULT_FREE_MODEL;
  const fallbacks = spec.fallbacks ?? envList('SWITCHBOARD_LLM_FALLBACK_MODELS') ?? DEFAULT_FREE_FALLBACKS.filter((id) => id !== model);
  const effort = process.env.SWITCHBOARD_LLM_REASONING_EFFORT;
  const inner = new OpenAiCompatibleModel({
    model,
    fallbackModels: fallbacks,
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    reasoningEffort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'low',
  });
  const firstFallback = fallbacks[0];
  return new BudgetedModel(inner, {
    ledgerPath: options.ledgerPath ?? process.env.SWITCHBOARD_LLM_LEDGER ?? join(process.cwd(), 'results', 'calls.jsonl'),
    cacheDir: options.cacheDir ?? process.env.SWITCHBOARD_LLM_CACHE_DIR ?? join(process.cwd(), '.cache', 'llm'),
    maxCalls: Number(process.env.SWITCHBOARD_LLM_MAX_CALLS ?? 500),
    minIntervalMs: Number(process.env.SWITCHBOARD_LLM_MIN_INTERVAL_MS ?? 3000),
    tag: spec.tag ?? 'api',
    requestedModels: { model, fallbacks },
    ...(firstFallback && { policyFallback: inner.withModel(firstFallback, fallbacks.slice(1)) }),
  });
}
