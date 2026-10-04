import { sign } from '@octokit/webhooks-methods';
import { afterAll, describe, expect, it } from 'vitest';
import type { WebhookDeps } from '@writecode-proof/github';
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
