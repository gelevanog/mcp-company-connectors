import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@switchboard/core': pkg('core'),
      '@switchboard/server-crm': pkg('server-crm'),
      '@switchboard/server-helpdesk': pkg('server-helpdesk'),
      '@switchboard/server-analytics': pkg('server-analytics'),
      '@switchboard/server-kb': pkg('server-kb'),
      '@switchboard/server-workspace': pkg('server-workspace'),
      '@switchboard/agent': pkg('agent'),
      '@switchboard/gateway': pkg('gateway'),
      '@switchboard/cli': pkg('cli'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { SWITCHBOARD_LOG: 'silent', SWITCHBOARD_LLM_LEDGER: '', SWITCHBOARD_TODAY: '2026-10-01' },
  },
});
