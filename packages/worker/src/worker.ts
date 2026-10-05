import { Worker } from 'bullmq';
import type { LlmProvider, Sandbox } from '@writecode-proof/core';
import {
  processPullRequest,
  QUEUE_NAME,
  reportFailedRun,
  redisConnection,
  type ProcessOutcome,
  type PullRequestGitHub,
  type PullRequestTarget,
  type QueuedRun,
  type RunQueue,
  type RunStore,
} from '@writecode-proof/github';

export interface WorkerOptions {
  redisUrl: string;
  /** Redis key prefix; tests use their own. */
  prefix?: string;
  concurrency: number;
  queue: Pick<RunQueue, 'isLatest'>;
  githubFor(installationId: number, target: PullRequestTarget): Promise<PullRequestGitHub>;
  store: RunStore | null;
  sandbox: Sandbox;
  llm: LlmProvider | null;
  cloneRoot: string;
  cloneDepth: number;
  aiLabel: string;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** BullMQ consumer: one pull request push per job (spec section 5, GitHub side). */
export function startWorker(options: WorkerOptions): Worker<QueuedRun, ProcessOutcome> {
  const worker = new Worker<QueuedRun, ProcessOutcome>(
    QUEUE_NAME,
    async (job) => {
      const run = job.data;
      const github = await options.githubFor(run.installationId, {
        owner: run.owner,
        repo: run.repo,
        prNumber: run.prNumber,
      });
      return processPullRequest(run, {
        github,
        store: options.store,
        isLatest: (key, sha) => options.queue.isLatest(key, sha),
        sandbox: options.sandbox,
        llm: options.llm,
        cloneRoot: options.cloneRoot,
        cloneDepth: options.cloneDepth,
        aiLabel: options.aiLabel,
        log: options.log,
      });
    },
    {
      connection: redisConnection(options.redisUrl),
      ...(options.prefix ? { prefix: options.prefix } : {}),
      concurrency: options.concurrency,
    },
  );

  // Redis going away must not crash the worker; BullMQ reconnects by itself.
  worker.on('error', (error) => {
    (options.log ?? (() => undefined))('queue connection problem', { error: error.message });
  });

  // processPullRequest reports its own failures. A job only fails here when it
  // died outside it, e.g. the worker crashed and BullMQ gave up on the job.
  worker.on('failed', (job, error) => {
    if (!job) return;
    void reportAbandoned(job.data, job.timestamp, error, options);
  });
  return worker;
}

async function reportAbandoned(
  run: QueuedRun,
  queuedAt: number,
  error: Error,
  options: WorkerOptions,
): Promise<void> {
  const log = options.log ?? (() => undefined);
  log('run abandoned', { runId: run.runId, error: error.message });
  try {
    const github = await options.githubFor(run.installationId, {
      owner: run.owner,
      repo: run.repo,
      prNumber: run.prNumber,
    });
    await reportFailedRun(
      run,
      {
        github,
        store: options.store,
        checkRunId: run.checkRunId,
        durationMs: Date.now() - queuedAt,
      },
      `The worker stopped while checking this push (${error.message}).`,
    );
  } catch (reportError) {
    log('could not report the abandoned run', { error: (reportError as Error).message });
  }
}
