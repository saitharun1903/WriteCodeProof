// Phase 8: when Docker or the model goes away mid-run, the pull request gets
// a clear, honest report, nothing crashes, and leftovers get cleaned up.
// Needs Docker, the images, Postgres and Redis (npm run infra:up).

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadEnvFromFile,
  OllamaProvider,
  RUN_LABEL,
  SANDBOX_LABEL,
  Sandbox,
  sandboxSettingsFromEnv,
  type CompleteOptions,
  type LlmProvider,
} from '@writecode-proof/core';
import { createRun, getRun } from '@writecode-proof/db';
import {
  dbRunStore,
  processPullRequest,
  RunQueue,
  type ProcessDeps,
} from '@writecode-proof/github';
import { cleanUp, INTERRUPTED, startWorker } from '@writecode-proof/worker';
import { FakeGitHub, pullRequestRemote, queuedRun, testDatabase } from './helpers.js';

const env = loadEnvFromFile();
const root = mkdtempSync(join(tmpdir(), 'wcp-resilience-'));
const workdirRoot = join(root, 'runs');
const cloneRoot = join(root, 'clones');
mkdirSync(workdirRoot);
mkdirSync(cloneRoot);

let db: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  if (!env.DATABASE_URL || !env.REDIS_URL) throw new Error('Run npm run infra:up first');
  db = await testDatabase(env.DATABASE_URL);
});
afterAll(async () => {
  await db?.drop();
  rmSync(root, { recursive: true, force: true });
});

const sandboxFor = () => new Sandbox({ ...sandboxSettingsFromEnv(env), workdirRoot });

/**
 * Point the Docker client at a socket that does not exist: exactly what it
 * sees when Docker Desktop stops. Returns a function that reconnects it.
 */
function cutDocker(sandbox: Sandbox): () => void {
  const modem = sandbox.docker.modem as { socketPath?: unknown; socketPathCache?: unknown };
  const saved = { path: modem.socketPath, cache: modem.socketPathCache };
  const nowhere =
    process.platform === 'win32' ? '//./pipe/wcp-no-docker-here' : join(root, 'no-docker.sock');
  modem.socketPath = nowhere;
  modem.socketPathCache = nowhere;
  return () => {
    modem.socketPath = saved.path;
    modem.socketPathCache = saved.cache;
  };
}

async function run(example: string, deps: Partial<ProcessDeps> & { github: FakeGitHub }) {
  const { work, remote } = pullRequestRemote(example, mkdtempSync(join(root, 'repo-')));
  const store = dbRunStore(db.handle.db);
  const job = queuedRun(work, remote, await deps.github.createCheckRun('', 'queued'));
  await store.queued(job, job.runId);
  const outcome = await processPullRequest(job, {
    store,
    isLatest: async () => true,
    sandbox: sandboxFor(),
    llm: null,
    cloneRoot,
    cloneDepth: env.CLONE_DEPTH,
    aiLabel: env.GITHUB_AI_LABEL,
    ...deps,
  });
  return { job, outcome, comment: [...deps.github.comments.values()].at(-1) ?? '' };
}

describe('Docker stops in the middle of a run', () => {
  it('reports the run as incomplete, with the reason, and never as safe', async () => {
    const github = new FakeGitHub();
    const sandbox = sandboxFor();
    let reconnect: (() => void) | null = null;
    const { job, outcome, comment } = await run('py-sample', {
      github,
      sandbox,
      // Existing tests have run; Docker "stops" as the security scan starts.
      log: (message) => {
        if (message === 'Scanning for security issues' && !reconnect)
          reconnect = cutDocker(sandbox);
      },
    });
    (reconnect as (() => void) | null)?.();
    await sandbox.removeContainers(job.runId);

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.risk.incompleteChecks).toEqual(['behaviour_diff', 'security']);

    expect(comment).toContain('· Incomplete — 2 checks could not run, review by hand');
    expect(comment).toContain('> [!WARNING]');
    expect(comment).toMatch(
      /Security: Could not run: Lost connection to Docker while .+\. Is Docker Desktop running\?/,
    );
    expect(comment).not.toContain('auto-approve');

    const check = github.checks.get(1)!;
    expect(check.conclusion).toBe('neutral');
    expect(check.output!.title).toContain('Incomplete');

    const stored = await getRun(db.handle.db, job.runId);
    expect(stored).toMatchObject({ status: 'done', incomplete: true });
  });

  it('works again once Docker is back', async () => {
    const github = new FakeGitHub();
    const { outcome } = await run('py-sample', { github });
    expect(outcome).toMatchObject({ status: 'done', risk: { score: 6, incompleteChecks: [] } });
    expect(github.checks.get(1)!.conclusion).toBe('success');
  });
});

describe('the model stops answering in the middle of a run', () => {
  it('still compares behaviour and says plainly that tests were not generated', async () => {
    // Answers the first request, then is gone: a real Ollama client pointed
    // at a port where nothing listens.
    const gone = new OllamaProvider('http://127.0.0.1:9', {
      model: env.LLM_MODEL,
      timeoutMs: 10_000,
      temperature: 0,
      maxTokens: 100,
    });
    let calls = 0;
    const llm: LlmProvider = {
      name: 'ollama',
      model: env.LLM_MODEL,
      complete: (opts: CompleteOptions) =>
        ++calls === 1 ? Promise.resolve('{"inputs": [[1.999], [[]]]}') : gone.complete(opts),
    };
    const github = new FakeGitHub();
    const { outcome, comment } = await run('py-sample', { github, llm });

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.risk.incompleteChecks).toEqual(['generated_tests']);
    expect(comment).toContain(
      'Generated tests: Could not run: Cannot reach Ollama at http://127.0.0.1:9. Is Ollama running?',
    );
    // The behaviour diff fell back to its own edge cases and still found both bugs.
    expect(comment).toContain('cheapest\\_item(\\[\\]) throws ValueError (was None)');
    expect(comment).toContain('round\\_money(1.999) returns 1.99 (was 2)');
    expect(github.checks.get(1)!.conclusion).toBe('neutral');
  });
});

describe('a job that dies outside the run (worker crash)', () => {
  it('is still reported on the pull request and stored as an error', async () => {
    const prefix = `wcp-test-${crypto.randomUUID().slice(0, 8)}`;
    const queue = new RunQueue(env.REDIS_URL!, prefix);
    const github = new FakeGitHub();
    const store = dbRunStore(db.handle.db);
    let first = true;
    const worker = startWorker({
      redisUrl: env.REDIS_URL!,
      prefix,
      concurrency: 1,
      queue,
      // The job blows up before the run starts; reporting it later works.
      githubFor: async () => {
        if (first) {
          first = false;
          throw new Error('GitHub API unreachable');
        }
        return github;
      },
      store,
      sandbox: sandboxFor(),
      llm: null,
      cloneRoot,
      cloneDepth: env.CLONE_DEPTH,
      aiLabel: env.GITHUB_AI_LABEL,
    });
    try {
      const { work, remote } = pullRequestRemote('py-sample', mkdtempSync(join(root, 'repo-')));
      const job = queuedRun(work, remote, await github.createCheckRun('', 'queued'));
      await store.queued(job, job.runId);
      await queue.enqueue(job);

      await expect
        .poll(() => [...github.comments.values()].join(), { timeout: 30_000 })
        .toContain('Could not finish');
      expect(github.checks.get(1)!.conclusion).toBe('neutral');
      await expect
        .poll(async () => (await getRun(db.handle.db, job.runId))?.status, { timeout: 10_000 })
        .toBe('error');
      expect((await getRun(db.handle.db, job.runId))!.error).toBe(
        'The worker stopped while checking this push (GitHub API unreachable).',
      );
    } finally {
      await worker.close();
      await queue.queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      const redis = new Redis(env.REDIS_URL!);
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  });
});

describe('clean-up after crashed runs', () => {
  it('removes old containers, folders and stuck runs, and nothing new', async () => {
    const sandbox = sandboxFor();
    const crashed = await sandbox.docker.createContainer({
      Image: sandbox.settings.images.node,
      Cmd: ['true'],
      Labels: { [SANDBOX_LABEL]: 'true', [RUN_LABEL]: 'crashed-run' },
    });
    const old = new Date(Date.now() - 60_000);
    for (const dir of [join(workdirRoot, 'run-crashed'), join(cloneRoot, 'crashed')]) {
      mkdirSync(dir, { recursive: true });
      utimesSync(dir, old, old);
    }
    const stuckId = crypto.randomUUID();
    await createRun(db.handle.db, {
      id: stuckId,
      source: 'cli',
      baseSha: 'b',
      headSha: null,
      status: 'running',
    });
    // Docker's creation time has one-second resolution.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const fresh = join(workdirRoot, 'run-live');
    mkdirSync(fresh);

    const result = await cleanUp({ sandbox, database: db.handle, cloneRoot, olderThanMs: 1_000 });

    expect(result.containers).toBeGreaterThanOrEqual(1);
    await expect(crashed.inspect()).rejects.toMatchObject({ statusCode: 404 });
    expect(result.folders).toBe(2);
    expect(mkdtempSync(join(fresh, 'still-here-'))).toBeTruthy();
    expect(await getRun(db.handle.db, stuckId)).toMatchObject({
      status: 'error',
      error: INTERRUPTED,
    });
  });
});
