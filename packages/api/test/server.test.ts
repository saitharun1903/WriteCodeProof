import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from '@octokit/webhooks-methods';
import { afterAll, describe, expect, it } from 'vitest';
import { RunQueue, type WebhookDeps } from '@writecode-proof/github';
import { buildServer } from '../src/server.js';

describe('API without a database or GitHub App', () => {
  const app = buildServer({ logLevel: 'silent' });
  afterAll(() => app.close());

  it('reports what is not configured on /health', async () => {
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body).toMatchObject({ status: 'ok', database: 'off', queue: 'off' });
  });

  it('answers 503 instead of failing', async () => {
    expect((await app.inject({ method: 'POST', url: '/webhook', payload: {} })).statusCode).toBe(
      503,
    );
    expect((await app.inject({ method: 'GET', url: '/api/runs' })).statusCode).toBe(503);
  });
});

describe('POST /webhook', () => {
  const secret = 'shh';
  const received: string[] = [];
  const deps: WebhookDeps = {
    secret,
    enqueue: async (run) => {
      received.push(`${run.fullName}#${run.prNumber}`);
      return [];
    },
    githubFor: async () => ({
      cloneToken: async () => null,
      createCheckRun: async () => 1,
      startCheckRun: async () => undefined,
      completeCheckRun: async () => undefined,
      upsertComment: async () => 'created',
    }),
    store: null,
  };
  const app = buildServer({ logLevel: 'silent', webhook: deps });
  afterAll(() => app.close());

  // Formatting matters: the signature is over the exact bytes.
  const body = `{"action":"opened","installation":{"id":1},"repository":{"name":"r","full_name":"o/r","owner":{"login":"o"}},
    "pull_request":{"number":3,"base":{"sha":"${'b'.repeat(40)}"},"head":{"sha":"${'h'.repeat(40)}"}}}`;

  it('accepts a correctly signed delivery and checks the raw bytes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'abc',
        'x-hub-signature-256': await sign(secret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(received).toEqual(['o/r#3']);
  });

  it('rejects a wrong signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': await sign('wrong', body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('runs API input checks', () => {
  const fakeDb = {
    db: {},
    migrate: async () => undefined,
    ping: async () => undefined,
    close: async () => undefined,
  };
  const app = buildServer({ logLevel: 'silent', database: fakeDb as never });
  afterAll(() => app.close());

  it.each(['page=0', 'pageSize=1000', 'source=svn'])('rejects %s', async (query) => {
    expect((await app.inject({ method: 'GET', url: `/api/runs?${query}` })).statusCode).toBe(400);
  });

  it('answers 404 for an id that is not a run id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/runs/not-a-uuid' })).statusCode).toBe(404);
  });
});

describe('serving the dashboard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wcp-dash-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app-1.js'), 'console.log(1)');
  const app = buildServer({
    logLevel: 'silent',
    dashboardDir: dir,
    githubWebUrl: 'https://github.com',
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the app and its files', async () => {
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.headers['content-type']).toMatch(/text\/html/);
    const js = await app.inject({ method: 'GET', url: '/assets/app-1.js' });
    expect(js.headers['content-type']).toMatch(/javascript/);
  });

  it('serves the app for page paths so deep links work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/runs/0b80aa3e-1111-2222-3333-444455556666?x=1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });

  it('picks up files built after start-up', async () => {
    writeFileSync(join(dir, 'assets', 'app-2.js'), 'console.log(2)');
    const res = await app.inject({ method: 'GET', url: '/assets/app-2.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('answers 404, never the page, for missing files and API paths', async () => {
    for (const url of ['/assets/gone.js', '/api/nope', '/webhook/x']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('id="root"');
    }
  });

  it('tells the dashboard where pull requests live', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(res.json()).toMatchObject({ githubWebUrl: 'https://github.com' });
  });
});

describe('protection', () => {
  it('rate-limits clients but never /health', async () => {
    const app = buildServer({ logLevel: 'silent', rateLimitPerMinute: 2 });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++)
        codes.push((await app.inject({ method: 'GET', url: '/api/meta' })).statusCode);
      expect(codes).toEqual([200, 200, 429]);
      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  const failingDb = (error: Error) =>
    ({
      db: {
        select: () => {
          throw error;
        },
      },
      migrate: async () => undefined,
      ping: async () => undefined,
      close: async () => undefined,
    }) as never;

  it('answers 503 when the database is down, without internals', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), {
      code: 'ECONNREFUSED',
    });
    const app = buildServer({ logLevel: 'silent', database: failingDb(down) });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs' });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('5433');
    } finally {
      await app.close();
    }
  });

  it('answers a plain 500 for unexpected errors, never the SQL', async () => {
    const app = buildServer({
      logLevel: 'silent',
      database: failingDb(new Error('relation "runs" does not exist')),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Something went wrong on the server.' });
    } finally {
      await app.close();
    }
  });

  it(
    'answers 503 to GitHub when the queue (Redis) is down, so it can redeliver',
    { timeout: 20_000 },
    async () => {
      const secret = 'shh';
      // A real queue client pointed at a port where nothing listens.
      const queue = new RunQueue('redis://127.0.0.1:1');
      const app = buildServer({
        logLevel: 'silent',
        webhook: {
          secret,
          enqueue: (run) => queue.enqueue(run),
          githubFor: async () => ({
            cloneToken: async () => null,
            createCheckRun: async () => 1,
            startCheckRun: async () => undefined,
            completeCheckRun: async () => undefined,
            upsertComment: async () => 'created',
          }),
          store: null,
        },
      });
      try {
        const body = JSON.stringify({
          action: 'opened',
          installation: { id: 1 },
          repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
          pull_request: { number: 3, base: { sha: 'b'.repeat(40) }, head: { sha: 'h'.repeat(40) } },
        });
        const res = await app.inject({
          method: 'POST',
          url: '/webhook',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'pull_request',
            'x-hub-signature-256': await sign(secret, body),
          },
          payload: body,
        });
        expect(res.statusCode).toBe(503);
        // The server is still up and serving.
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      } finally {
        await app.close();
        await queue.close();
      }
    },
  );
});
