import { join } from 'node:path';

import { BudgetedModel } from './budget.js';
import { FakeModel, type FakeScript } from './fake.js';
import { OpenAiCompatibleModel } from './openrouter.js';
import type { ChatModel } from './types.js';

export type ModelProvider = 'fake' | 'openrouter' | 'openai_compatible';

export interface ModelSpec {
  provider: ModelProvider;
  model?: string;
  fallbacks?: string[];
  /** openai_compatible: the endpoint (default SWITCHBOARD_LLM_BASE_URL). */
  baseUrl?: string;
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

/**
 * SWITCHBOARD_LLM_TEMPERATURE: a number (default 0), or "omit" to leave the field out of the request (some
 * models behind OpenAI-compatible gateways reject it).
 */
export function envTemperature(env: NodeJS.ProcessEnv = process.env): number | null {
  const value = env.SWITCHBOARD_LLM_TEMPERATURE?.trim();
  if (value === undefined || value === '') return 0;
  if (value.toLowerCase() === 'omit') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`SWITCHBOARD_LLM_TEMPERATURE must be a number or "omit", got ${JSON.stringify(value)}`);
  return parsed;
}

/** SWITCHBOARD_LLM_REASONING_EFFORT: low (default) | medium | high | none (the field is not sent). */
export function envReasoningEffort(env: NodeJS.ProcessEnv = process.env): 'low' | 'medium' | 'high' | undefined {
  const effort = env.SWITCHBOARD_LLM_REASONING_EFFORT;
  if (effort === 'none' || effort === 'omit') return undefined;
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'low';
}

/**
 * A model from the environment: SWITCHBOARD_LLM_PROVIDER=fake (default) | openrouter | openai_compatible.
 * openai_compatible talks to SWITCHBOARD_LLM_BASE_URL with SWITCHBOARD_LLM_API_KEY. The free-only guard applies to
 * every provider; non-":free" models need SWITCHBOARD_ALLOW_PAID_MODELS=1.
 */
export function createModel(spec: ModelSpec, options: ModelFactoryOptions = {}): ChatModel {
  if (spec.provider === 'fake') return new FakeModel({ scripts: options.scripts ?? [], gullible: spec.gullible ?? false });
  const model = spec.model ?? process.env.SWITCHBOARD_LLM_MODEL ?? DEFAULT_FREE_MODEL;
  const openRouter = spec.provider === 'openrouter';
  const fallbacks = spec.fallbacks ?? envList('SWITCHBOARD_LLM_FALLBACK_MODELS') ?? (openRouter ? DEFAULT_FREE_FALLBACKS.filter((id) => id !== model) : []);
  const inner = new OpenAiCompatibleModel({
    model,
    fallbackModels: fallbacks,
    provider: spec.provider,
    baseUrl: openRouter ? undefined : spec.baseUrl ?? process.env.SWITCHBOARD_LLM_BASE_URL,
    apiKey: (openRouter ? process.env.OPENROUTER_API_KEY : process.env.SWITCHBOARD_LLM_API_KEY) ?? '',
    reasoningEffort: envReasoningEffort(),
    temperature: envTemperature(),
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
