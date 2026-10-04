import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Docker-backed tests. Run with: npm run test:sandbox
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ['tests/sandbox/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
