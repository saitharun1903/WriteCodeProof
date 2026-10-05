import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { connectDb, DbUnavailableError, describeDbUrl } from '../src/index.js';

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('connectDb', () => {
  it('says in plain words when Postgres is not running, without the password', async () => {
    const port = await closedPort();
    const handle = connectDb(`postgresql://proof:hunter2@127.0.0.1:${port}/proof`);
    try {
      const error = await handle.migrate().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DbUnavailableError);
      expect((error as Error).message).toBe(
        `Cannot reach Postgres at 127.0.0.1:${port}. Is it running? Start it with: npm run infra:up`,
      );
      expect((error as Error).message).not.toContain('hunter2');
    } finally {
      await handle.close();
    }
  });
});

describe('describeDbUrl', () => {
  it('keeps only the host and port', () => {
    expect(describeDbUrl('postgresql://u:secret@db.internal:5433/x')).toBe('db.internal:5433');
    expect(describeDbUrl('postgresql://u:secret@db.internal/x')).toBe('db.internal:5432');
    expect(describeDbUrl('not a url')).toBe('DATABASE_URL');
  });
});
