import { createPool } from '@switchboard/core';

import { type Stack, type StackOptions, freePort, startStack as start } from '../src/eval/stack.js';

export { freePort, type Stack };

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://switchboard:switchboard@127.0.0.1:55480/switchboard_test';

let reachable: boolean | undefined;
export async function databaseAvailable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const db = createPool(TEST_DATABASE_URL, 1);
  try {
    await db.query('SELECT 1');
    reachable = true;
  } catch {
    if (process.env.REQUIRE_TEST_DB === '1') throw new Error(`REQUIRE_TEST_DB=1 but ${TEST_DATABASE_URL} is not reachable`);
    reachable = false;
  } finally {
    await db.end();
  }
  return reachable;
}

export function startStack(options: Omit<StackOptions, 'databaseUrl'> = {}): Promise<Stack> {
  return start({ databaseUrl: TEST_DATABASE_URL, ...options });
}
