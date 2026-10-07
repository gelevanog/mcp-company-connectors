import { DEMO_TODAY } from './demo/data.js';

/**
 * The demo pins "today" (SWITCHBOARD_TODAY, default 2026-10-01) so relative dates in the data, the evaluation
 * tasks and the model's answers stay reproducible. Time of day is the real one. Set SWITCHBOARD_TODAY= (empty)
 * to use the real date.
 */
export function today(): string {
  const pinned = process.env.SWITCHBOARD_TODAY ?? DEMO_TODAY;
  return pinned === '' ? new Date().toISOString().slice(0, 10) : pinned;
}

export function now(): Date {
  const real = new Date();
  const pinned = today();
  if (pinned === real.toISOString().slice(0, 10)) return real;
  return new Date(`${pinned}T${real.toISOString().slice(11)}`);
}

export function nowIso(): string {
  return now().toISOString();
}
