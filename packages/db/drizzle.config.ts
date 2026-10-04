import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from the schema: npm run db:generate
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
