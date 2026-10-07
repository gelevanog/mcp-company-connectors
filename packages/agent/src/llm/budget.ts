import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalJson, sha256 } from '@switchboard/core';

import { BudgetExceededError, type ChatModel, type Completion, type CompletionRequest, LlmError, PolicyViolationError, RetryableLlmError } from './types.js';

/**
 * Wraps a real cloud model: disk cache, throttle (one request every few seconds), retries with backoff on 429 /
 * 5xx / timeouts, a hard call budget, and a JSONL ledger of every real request (model ids, status, latency and
 * token counts; never prompts). "How many API calls did this cost" is read from a file, not remembered.
 */
export interface BudgetOptions {
  ledgerPath: string | undefined;
  cacheDir: string | undefined;
  maxCalls: number;
  minIntervalMs: number;
  maxRetries?: number;
  retryBaseMs?: number;
  tag?: string;
  /** Asked directly when the provider refuses a prompt with HTTP 403 (not covered by OpenRouter's models list). */
  policyFallback?: ChatModel | undefined;
  requestedModels?: { model: string; fallbacks: string[] };
}

let nextSlot = 0;

export class Ledger {
  calls = 0;
  constructor(readonly path: string | undefined) {
    if (path && existsSync(path)) this.calls = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).length;
  }
  record(entry: Record<string, unknown>): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString().slice(0, 19) + 'Z', ...entry })}\n`);
  }
}

const ledgers = new Map<string, Ledger>();
export function sharedLedger(path: string | undefined): Ledger {
  const key = path ?? '';
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = new Ledger(path);
    ledgers.set(key, ledger);
  }
  return ledger;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BudgetedModel implements ChatModel {
  readonly isLocal = false;
  private readonly ledger: Ledger;

  constructor(private readonly inner: ChatModel, private readonly options: BudgetOptions) {
    this.ledger = sharedLedger(options.ledgerPath);
  }

  get label(): string {
    return this.inner.label;
  }

  withTag(tag: string): BudgetedModel {
    return new BudgetedModel(this.inner, { ...this.options, tag });
  }

  private cacheKey(request: CompletionRequest): string {
    return sha256(canonicalJson({ model: this.inner.label, fallbacks: this.options.requestedModels?.fallbacks ?? [], request }));
  }

  private cachePath(key: string): string | undefined {
    return this.options.cacheDir ? join(this.options.cacheDir, key.slice(0, 2), `${key}.json`) : undefined;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + this.options.minIntervalMs;
    if (start > now) await sleep(start - now);
  }

  private reserve(): void {
    if (this.ledger.calls >= this.options.maxCalls) {
      throw new BudgetExceededError(`call budget of ${this.options.maxCalls} real requests reached (${this.options.ledgerPath ?? 'no ledger'})`);
    }
    this.ledger.calls += 1;
  }

  private record(status: string, started: number, extra: Record<string, unknown>): void {
    this.ledger.record({
      tag: this.options.tag ?? '',
      provider: this.inner.label,
      requested_model: this.options.requestedModels?.model ?? this.inner.label,
      fallback_models: this.options.requestedModels?.fallbacks ?? [],
      status,
      latency_s: Math.round((Date.now() - started) / 10) / 100,
      ...extra,
    });
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const key = this.cacheKey(request);
    const path = this.cachePath(key);
    if (path && existsSync(path)) {
      const hit = JSON.parse(readFileSync(path, 'utf8')) as Completion;
      return { ...hit, cached: true };
    }
    const maxRetries = this.options.maxRetries ?? 4;
    let last: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      this.reserve();
      await this.throttle();
      const started = Date.now();
      try {
        const completion = await this.inner.complete(request);
        this.record('ok', started, { served_model: completion.model, input_tokens: completion.inputTokens, output_tokens: completion.outputTokens });
        if (path) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify(completion));
        }
        return completion;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof PolicyViolationError) {
          this.record('error', started, { error: message.slice(0, 200) });
          throw error;
        }
        if (error instanceof RetryableLlmError) {
          this.record('retryable_error', started, { error: message.slice(0, 200) });
          last = error;
          if (attempt < maxRetries) {
            const base = this.options.retryBaseMs ?? 5000;
            const delay = error.retryAfterSeconds ? Math.min(error.retryAfterSeconds * 1000, 60_000) : base * 2 ** attempt;
            await sleep(delay * (0.75 + Math.random() * 0.5));
          }
          continue;
        }
        this.record('error', started, { error: message.slice(0, 200) });
        if (this.options.policyFallback && /upstream 403/.test(message)) {
          const fallback = new BudgetedModel(this.options.policyFallback, {
            ...this.options,
            tag: `${this.options.tag ?? ''}:policy_fallback`,
            policyFallback: undefined,
            requestedModels: { model: this.options.policyFallback.label.replace(/^openrouter\//, ''), fallbacks: [] },
          });
          return fallback.complete(request);
        }
        throw error;
      }
    }
    throw last ?? new LlmError('retries exhausted');
  }
}
