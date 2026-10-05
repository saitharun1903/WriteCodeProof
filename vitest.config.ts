import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const path = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));
const pkg = (name: string) => ({
  find: new RegExp(`^@writecode-proof/${name}$`),
  replacement: path(`${name}/src/index.ts`),
});

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Run tests against source, so `npm test` works without a build first.
    alias: [
      { find: /^@writecode-proof\/core\/labels$/, replacement: path('core/src/labels.ts') },
      pkg('core'),
      pkg('db'),
      pkg('github'),
      pkg('worker'),
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    // Needs Docker; run separately with npm run test:sandbox.
    exclude: ['**/node_modules/**', 'tests/sandbox/**'],
    environment: 'node',
  },
});
