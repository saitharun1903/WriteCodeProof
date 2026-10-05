import {
  createRun,
  finishRun,
  setRepoConfig,
  setRunStatus,
  upsertInstallation,
  upsertRepo,
  type Db,
  type FailedRun,
  type FinishedRun,
} from '@writecode-proof/db';
import type { PullRequestJob } from './webhook.js';

/** Where run records go. The GitHub flow works without one (nothing is stored). */
export interface RunStore {
  queued(job: PullRequestJob, runId: string): Promise<void>;
  running(runId: string): Promise<void>;
  saveConfig(job: PullRequestJob, config: unknown): Promise<void>;
  finish(runId: string, outcome: FinishedRun | FailedRun): Promise<void>;
}

/**
 * A store whose failures are logged, never thrown: recording a run is
 * secondary to reporting it on the pull request.
 */
export function forgivingStore(
  store: RunStore,
  log: (message: string, extra?: Record<string, unknown>) => void,
): RunStore {
  const guard =
    <A extends unknown[]>(name: string, call: (...args: A) => Promise<void>) =>
    (...args: A) =>
      call(...args).catch((error: unknown) => {
        log(`could not record the run (${name})`, { error: (error as Error).message });
      });
  return {
    queued: guard('queued', store.queued),
    running: guard('running', store.running),
    saveConfig: guard('saveConfig', store.saveConfig),
    finish: guard('finish', store.finish),
  };
}

export function dbRunStore(db: Db): RunStore {
  const repoId = async (job: PullRequestJob) => {
    const installationId = await upsertInstallation(db, job.installationId, job.accountLogin);
    return upsertRepo(db, job.fullName, installationId);
  };
  return {
    async queued(job, runId) {
      await createRun(db, {
        id: runId,
        source: 'github',
        repoId: await repoId(job),
        prNumber: job.prNumber,
        baseSha: job.baseSha,
        headSha: job.headSha,
        status: 'queued',
      });
    },
    running: (runId) => setRunStatus(db, runId, 'running'),
    async saveConfig(job, config) {
      await setRepoConfig(db, await repoId(job), config);
    },
    finish: (runId, outcome) => finishRun(db, runId, outcome),
  };
}
