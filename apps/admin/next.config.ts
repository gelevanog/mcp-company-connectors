import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
};

export default config;
