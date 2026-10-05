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

/** Without this, pg waits forever for an unreachable server. */
const CONNECT_TIMEOUT_MS = 5_000;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Postgres is not running or not reachable: a setup problem, not a bug. */
export class DbUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DbUnavailableError';
  }
}

/** Codes pg gives when nothing answers at the address. */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH']);

function isUnreachable(error: unknown): boolean {
  for (let e = error as { code?: string; message?: string; cause?: unknown } | undefined; e;) {
    if (UNREACHABLE_CODES.has(e.code ?? '') || /connection timeout/i.test(e.message ?? '')) {
      return true;
    }
    e = e.cause as typeof e;
  }
  return false;
}

/** Host and port only: the URL holds the password. */
export function describeDbUrl(url: string): string {
  try {
    const { hostname, port } = new URL(url);
    return `${hostname}:${port || '5432'}`;
  } catch {
    return 'DATABASE_URL';
  }
}

function explain(error: unknown, url: string): unknown {
  if (!isUnreachable(error)) return error;
  return new DbUnavailableError(
    `Cannot reach Postgres at ${describeDbUrl(url)}. Is it running? Start it with: npm run infra:up`,
    { cause: error },
  );
}

export function connectDb(url: string): DbHandle {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // An idle client losing its connection must not crash the process.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return {
    db,
    migrate: () =>
      migrate(db, { migrationsFolder: MIGRATIONS_DIR }).catch((error: unknown) => {
        throw explain(error, url);
      }),
    ping: async () => {
      await pool.query('select 1');
    },
    close: () => pool.end(),
  };
}
