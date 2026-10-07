import { PolicyViolationError } from './types.js';

/**
 * The free-only guard (on by default): any OpenRouter model id must end in ":free", fallbacks included, and an
 * answer served by a model whose id does not end in ":free" is rejected. Paid models need
 * SWITCHBOARD_REQUIRE_FREE_MODELS=false, deliberately.
 */
export function ensureFreeModels(ids: readonly string[]): void {
  const paid = ids.filter((id) => !id.endsWith(':free'));
  if (paid.length > 0) {
    throw new PolicyViolationError(`free-only guard: refusing non-free OpenRouter model id(s): ${paid.join(', ')} (set SWITCHBOARD_REQUIRE_FREE_MODELS=false to allow paid models)`);
  }
}

export function ensureServedFree(served: string | undefined): void {
  if (served && !served.endsWith(':free')) {
    throw new PolicyViolationError(`free-only guard: OpenRouter served non-free model ${JSON.stringify(served)}; answer rejected`);
  }
}

export function requireFreeModels(): boolean {
  const value = process.env.SWITCHBOARD_REQUIRE_FREE_MODELS;
  return value === undefined || value === '' || !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}
