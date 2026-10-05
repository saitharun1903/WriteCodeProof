import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { PullRequestJob } from './webhook.js';

export const QUEUE_NAME = 'writecode-proof-runs';
const JOB_NAME = 'pull_request';
/** Finished jobs kept in Redis for inspection. */
const KEEP_FINISHED = 200;
/**
 * Redis commands wait for a reconnect (BullMQ needs that), so a call while
 * Redis is down would hang; give up after this long instead.
 */
const QUEUE_CALL_TIMEOUT_MS = 5_000;

export class QueueUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The run queue (Redis) is not reachable', { cause });
    this.name = 'QueueUnavailableError';
  }
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueUnavailableError()), QUEUE_CALL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout])
    .catch((error: unknown) => {
      throw error instanceof QueueUnavailableError ? error : new QueueUnavailableError(error);
    })
    .finally(() => clearTimeout(timer));
}

export interface QueuedRun extends PullRequestJob {
  /** `owner/repo#12`: one live run per pull request (spec section 12). */
  key: string;
  runId: string;
  checkRunId: number | null;
}

export const prKey = (fullName: string, prNumber: number) => `${fullName}#${prNumber}`;

/**
 * Unique per delivery: BullMQ silently drops a job whose id it still
 * remembers, which would swallow a re-run of the same commit (reopened,
 * redelivered). Ids must not contain ':'.
 */
const jobId = (run: QueuedRun) =>
  `${run.key}@${run.headSha.slice(0, 12)}/${run.runId}`.replace(/[^\w./#@-]/g, '_');

export function redisConnection(url: string) {
  // null: commands wait for a reconnect instead of failing, as BullMQ requires.
  return { url, maxRetriesPerRequest: null };
}

/**
 * The run queue. A new push to a pull request replaces its waiting run, and
 * records the newest head so a run already in progress can tell it is stale.
 */
export class RunQueue {
  readonly queue: Queue<QueuedRun>;
  /** Our own connection for the newest-head record (BullMQ keeps its client private). */
  private readonly redis: Redis;
  private readonly latestKey: string;

  /**
   * `onError`: Redis connection problems. They are reported, not thrown: an
   * unhandled 'error' event would crash the process, and the clients
   * reconnect by themselves once Redis is back.
   */
  constructor(
    redisUrl: string,
    prefix?: string,
    onError: (error: Error) => void = () => undefined,
  ) {
    this.queue = new Queue<QueuedRun>(QUEUE_NAME, {
      connection: redisConnection(redisUrl),
      ...(prefix ? { prefix } : {}),
    });
    this.queue.on('error', onError);
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.redis.on('error', onError);
    this.latestKey = `${prefix ?? 'bull'}:${QUEUE_NAME}:latest-head`;
  }

  /** Enqueue a run; returns the waiting runs it replaced. Throws QueueUnavailableError. */
  enqueue(run: Omit<QueuedRun, 'key'>): Promise<QueuedRun[]> {
    return bounded(this.enqueueNow(run));
  }

  private async enqueueNow(run: Omit<QueuedRun, 'key'>): Promise<QueuedRun[]> {
    const key = prKey(run.fullName, run.prNumber);
    await this.redis.hset(this.latestKey, key, run.headSha);

    const replaced: QueuedRun[] = [];
    const pending = await this.queue.getJobs(['waiting', 'delayed', 'prioritized']);
    for (const job of pending) {
      if (job.data.key !== key) continue;
      try {
        await job.remove();
        replaced.push(job.data);
      } catch {
        // It started in the meantime; the worker will see it is stale.
      }
    }

    const data: QueuedRun = { ...run, key };
    await this.queue.add(JOB_NAME, data, {
      jobId: jobId(data),
      attempts: 1,
      removeOnComplete: { count: KEEP_FINISHED },
      removeOnFail: { count: KEEP_FINISHED },
    });
    return replaced;
  }

  /** False once a newer push to the same pull request has been enqueued. */
  async isLatest(key: string, headSha: string): Promise<boolean> {
    const latest = await this.redis.hget(this.latestKey, key);
    return latest === null || latest === headSha;
  }

  async ping(): Promise<void> {
    await bounded(this.redis.ping());
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.redis.disconnect();
  }
}
