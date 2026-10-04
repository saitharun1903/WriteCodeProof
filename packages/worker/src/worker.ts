import { Worker } from 'bullmq';
import type { LlmProvider, Sandbox } from '@writecode-proof/core';
import {
  processPullRequest,
  QUEUE_NAME,
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
  return new Worker<QueuedRun, ProcessOutcome>(
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
}
