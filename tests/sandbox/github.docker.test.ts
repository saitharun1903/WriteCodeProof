// Phase 6: webhook → queue → worker → PR comment + check run + Postgres.
// Real Postgres and Redis (from docker compose), real queue and worker, a
// real git remote that serves refs/pull/N/head like GitHub; only the GitHub
// API is replaced by a recorder. Uses its own database and Redis prefix.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sign } from '@octokit/webhooks-methods';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMENT_MARKER,
  loadEnvFromFile,
  Sandbox,
  sandboxSettingsFromEnv,
} from '@writecode-proof/core';
import { connectDb, getRun, type DbHandle } from '@writecode-proof/db';
import {
  dbRunStore,
  RunQueue,
  type CheckConclusion,
  type CheckOutput,
  type ProcessOutcome,
  type PullRequestGitHub,
  type QueuedRun,
} from '@writecode-proof/github';
import { startWorker } from '@writecode-proof/worker';
import { buildServer } from '../../packages/api/src/server.js';
import { createExampleRepo, PR_BRANCH } from '../../scripts/example-repo.mjs';

const env = loadEnvFromFile();
const SECRET = 'phase-6-secret';
const PREFIX = `wcp-test-${randomUUID().slice(0, 8)}`;
const TEST_DB = `wcp_test_${randomUUID().slice(0, 8)}`;
const root = mkdtempSync(join(tmpdir(), 'wcp-gh-'));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();
}

/** Records everything the worker does on "GitHub"; comments keep their ids. */
class FakeGitHub implements PullRequestGitHub {
  events: string[] = [];
  comments = new Map<number, string>();
  checks = new Map<number, { conclusion: CheckConclusion | null; output: CheckOutput | null }>();
  private nextId = 1;

  async cloneToken() {
    return null;
  }
  async createCheckRun(_sha: string, status: 'queued' | 'in_progress') {
    const id = this.nextId++;
    this.checks.set(id, { conclusion: null, output: null });
    this.events.push(`check ${id} ${status}`);
    return id;
  }
  async startCheckRun(id: number) {
    this.events.push(`check ${id} in_progress`);
  }
  async completeCheckRun(id: number, conclusion: CheckConclusion, output: CheckOutput) {
    this.checks.set(id, { conclusion, output });
    this.events.push(`check ${id} ${conclusion}`);
  }
  async upsertComment(body: string): Promise<'created' | 'updated'> {
    for (const [id, existing] of this.comments) {
      if (existing.includes(COMMENT_MARKER)) {
        this.comments.set(id, body);
        this.events.push(`comment ${id} updated`);
        return 'updated';
      }
    }
    const id = 1000 + this.comments.size;
    this.comments.set(id, body);
    this.events.push(`comment ${id} created`);
    return 'created';
  }
}

let database: DbHandle;
let queue: RunQueue;
let worker: ReturnType<typeof startWorker>;
let app: ReturnType<typeof buildServer>;
let work: string;
let remote: string;
const github = new FakeGitHub();
const finished = new Map<string, ProcessOutcome>();

function waitFor(runId: string): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const tick = () =>
      finished.has(runId) ? resolve(finished.get(runId)!) : setTimeout(tick, 250);
    tick();
  });
}

const PR = 1;

async function deliver(action: string, headSha: string, cloneUrl = pathToFileURL(remote).href) {
  const baseSha = git(work, 'rev-parse', 'main');
  const body = JSON.stringify({
    action,
    installation: { id: 4242, account: { login: 'acme' } },
    repository: {
      name: 'shop',
      full_name: 'acme/shop',
      clone_url: cloneUrl,
      owner: { login: 'acme' },
    },
    pull_request: {
      number: PR,
      base: { ref: 'main', sha: baseSha },
      head: { ref: PR_BRANCH, sha: headSha },
      user: { login: 'dev', type: 'User' },
      labels: [],
    },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': await sign(SECRET, body),
    },
    payload: body,
  });
  expect(res.statusCode).toBe(202);
  return res.json() as { queued: string; replaced: number };
}

/** Commit a change on the PR branch and publish it as refs/pull/1/head. */
function push(file: string, content: string): string {
  writeFileSync(join(work, file), content);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'update');
  const sha = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', '--force', remote, `HEAD:refs/pull/${PR}/head`);
  return sha;
}

beforeAll(async () => {
  if (!env.DATABASE_URL || !env.REDIS_URL)
    throw new Error('Set DATABASE_URL and REDIS_URL (npm run infra:up)');
  const admin = new pg.Client({ connectionString: env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${TEST_DB}`;
  database = connectDb(url.toString());
  await database.migrate();

  queue = new RunQueue(env.REDIS_URL, PREFIX);
  const store = dbRunStore(database.db);

  // A "GitHub" remote: main = base, refs/pull/1/head = the PR, SHA fetches allowed.
  work = createExampleRepo('py-sample', join(root, 'work'), { mode: 'branch' });
  remote = join(root, 'remote.git');
  git(root, 'clone', '-q', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(remote, 'update-ref', `refs/pull/${PR}/head`, git(work, 'rev-parse', 'HEAD'));

  const workdirRoot = join(root, 'runs');
  mkdirSync(workdirRoot);
  const sandbox = new Sandbox({ ...sandboxSettingsFromEnv(env), workdirRoot });

  app = buildServer({
    logLevel: 'silent',
    database,
    webhook: {
      secret: SECRET,
      enqueue: (run) => queue.enqueue(run),
      githubFor: async () => github,
      store,
    },
    queuePing: () => queue.ping(),
  });
  worker = startWorker({
    redisUrl: env.REDIS_URL,
    prefix: PREFIX,
    concurrency: 1,
    queue,
    githubFor: async () => github,
    store,
    sandbox,
    llm: null,
    cloneRoot: join(root, 'clones'),
    cloneDepth: env.CLONE_DEPTH,
    aiLabel: env.GITHUB_AI_LABEL,
  });
  worker.on('completed', (job: Job<QueuedRun, ProcessOutcome>, outcome) =>
    finished.set(job.data.runId, outcome),
  );
});

afterAll(async () => {
  await worker?.close();
  await queue?.queue.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  const redis = new Redis(env.REDIS_URL!);
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  await app?.close();
  await database?.close();
  const admin = new pg.Client({ connectionString: env.DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
  rmSync(root, { recursive: true, force: true });
});

describe('pull request opened', () => {
  let runId: string;

  it('sets a pending check, then comments and completes it', async () => {
    ({ queued: runId } = await deliver('opened', git(work, 'rev-parse', 'HEAD')));
    const outcome = await waitFor(runId);
    expect(outcome).toMatchObject({ status: 'done', risk: { score: 6, band: 'medium' } });

    expect(github.events).toEqual([
      'check 1 queued',
      'check 1 in_progress',
      'comment 1000 created',
      'check 1 success',
    ]);
    const comment = github.comments.get(1000)!;
    expect(comment.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment).toContain('Risk 6/10 · Medium — one reviewer required');
    expect(comment).toContain('cheapest\\_item(\\[\\]) throws ValueError (was None)');
    expect(github.checks.get(1)!.output!.title).toBe('Risk 6/10 · Medium — one reviewer required');
  });

  it('stores the run and its findings', async () => {
    const run = await getRun(database.db, runId);
    expect(run).toMatchObject({
      source: 'github',
      repo: 'acme/shop',
      prNumber: PR,
      status: 'done',
      riskScore: 6,
      riskBand: 'medium',
    });
    expect(run!.findings.map((f) => f.check)).toEqual(['behaviour_diff', 'behaviour_diff']);
    expect(run!.checks.map((c) => c.check)).toEqual([
      'existing_tests',
      'generated_tests',
      'behaviour_diff',
      'security',
    ]);
    // Findings, not code.
    expect(JSON.stringify(run)).not.toContain('def cheapest_item');
  });

  it('lists it on the runs API', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?source=github' });
    expect(res.json()).toMatchObject({
      total: 1,
      items: [{ id: runId, repo: 'acme/shop', status: 'done' }],
    });
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(detail.json().findings).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}` })).statusCode).toBe(
      404,
    );
  });
});

describe('a new push', () => {
  it('updates the same comment instead of adding another', async () => {
    // Put the empty-list guard back: one behaviour change left.
    const fixed = push(
      'shop/cart.py',
      readCart().replace(
        'def cheapest_item(items):\n    return min',
        'def cheapest_item(items):\n    if not items:\n        return None\n    return min',
      ),
    );
    const { queued } = await deliver('synchronize', fixed);
    expect(await waitFor(queued)).toMatchObject({
      status: 'done',
      risk: { score: 3, band: 'medium' },
    });
    expect(github.comments.size).toBe(1);
    expect(github.events.slice(-2)).toEqual(['comment 1000 updated', 'check 2 success']);
    expect(github.comments.get(1000)).toContain('Risk 3/10');
  });

  it('replaces a waiting run when another push arrives first', async () => {
    await worker.pause();
    const first = push('shop/extra.py', 'def one():\n    return 1\n');
    const a = await deliver('synchronize', first);
    const second = push('shop/extra.py', 'def one():\n    return 2\n');
    const b = await deliver('synchronize', second);
    expect(b.replaced).toBe(1);
    expect((await getRun(database.db, a.queued))!.status).toBe('cancelled');
    expect(
      [...github.checks.values()].some((c) => c.output?.title === 'Superseded by a newer push'),
    ).toBe(true);

    worker.resume();
    expect(await waitFor(b.queued)).toMatchObject({ status: 'done' });
    expect(github.comments.size).toBe(1);
  });
});

describe('when the run cannot finish', () => {
  it('posts a clear error, marks the check neutral and records the error', async () => {
    const missing = pathToFileURL(join(root, 'no-such-remote.git')).href;
    const { queued } = await deliver('synchronize', git(work, 'rev-parse', 'HEAD'), missing);
    const outcome = await waitFor(queued);
    expect(outcome.status).toBe('error');
    expect(github.comments.size).toBe(1);
    expect(github.comments.get(1000)).toContain('Could not finish');
    expect(github.events.at(-1)).toMatch(/neutral$/);
    const run = await getRun(database.db, queued);
    expect(run).toMatchObject({ status: 'error' });
    expect(run!.error).toMatch(/no-such-remote/);
  });
});

function readCart(): string {
  return execFileSync('git', ['show', 'HEAD:shop/cart.py'], { cwd: work, encoding: 'utf8' });
}
