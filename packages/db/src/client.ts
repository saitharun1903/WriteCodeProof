import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** Apply pending migrations from packages/db/migrations. Safe to call on every start. */
  migrate(): Promise<void>;
  /** Throws when Postgres is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function connectDb(url: string): DbHandle {
  const pool = new pg.Pool({ connectionString: url });
  // An idle client losing its connection must not crash the process.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return {
    db,
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_DIR }),
    ping: async () => {
      await pool.query('select 1');
    },
    close: () => pool.end(),
  };
}
