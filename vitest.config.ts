import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source, so `npm test` works without a build first.
    alias: {
      '@writecode-proof/core': src('core'),
      '@writecode-proof/db': src('db'),
      '@writecode-proof/github': src('github'),
      '@writecode-proof/worker': src('worker'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    // Needs Docker; run separately with npm run test:sandbox.
    exclude: ['**/node_modules/**', 'tests/sandbox/**'],
    environment: 'node',
  },
});
