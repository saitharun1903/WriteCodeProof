import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Run tests against source, so `npm test` works without a build first.
    alias: {
      '@writecode-proof/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
