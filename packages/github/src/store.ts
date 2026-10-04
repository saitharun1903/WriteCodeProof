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
