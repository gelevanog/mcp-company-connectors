import { PolicyViolationError } from './types.js';

/**
 * The free-only guard (on by default): any model id must end in ":free", fallbacks included, and an answer served
 * by a model whose id does not end in ":free" is rejected. This holds for OpenRouter and for any other
 * OpenAI-compatible endpoint. Paid models need an explicit opt-in: SWITCHBOARD_ALLOW_PAID_MODELS=1 (or the older
 * SWITCHBOARD_REQUIRE_FREE_MODELS=false).
 */
export function ensureFreeModels(ids: readonly string[]): void {
  const paid = ids.filter((id) => !id.endsWith(':free'));
  if (paid.length > 0) {
    throw new PolicyViolationError(`free-only guard: refusing non-free model id(s): ${paid.join(', ')} (set SWITCHBOARD_ALLOW_PAID_MODELS=1 to allow paid models)`);
  }
}

export function ensureServedFree(served: string | undefined): void {
  if (served && !served.endsWith(':free')) {
    throw new PolicyViolationError(`free-only guard: the endpoint served non-free model ${JSON.stringify(served)}; answer rejected`);
  }
}

const truthy = (value: string | undefined) => value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
const falsy = (value: string | undefined) => value !== undefined && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());

/** The explicit opt-in for paid (non-":free") models. Off unless SWITCHBOARD_ALLOW_PAID_MODELS is 1/true/yes/on. */
export function allowPaidModels(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.SWITCHBOARD_ALLOW_PAID_MODELS);
}

export function requireFreeModels(env: NodeJS.ProcessEnv = process.env): boolean {
  return !allowPaidModels(env) && !falsy(env.SWITCHBOARD_REQUIRE_FREE_MODELS);
}
