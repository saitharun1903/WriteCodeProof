import { removeStaleFolders, type Sandbox } from '@writecode-proof/core';
import { markStaleRuns, type DbHandle } from '@writecode-proof/db';

/** How often the worker looks for leftovers of crashed runs. */
export const MAINTENANCE_INTERVAL_MS = 10 * 60_000;
/** Beyond the run budget: nothing live is ever this old. */
export const STALE_GRACE_MS = 10 * 60_000;

export const INTERRUPTED =
  'Interrupted: the worker stopped during this run. Push again or re-run to retry.';

export interface MaintenanceDeps {
  sandbox: Sandbox;
  database: DbHandle | null;
  cloneRoot: string;
  /** Age from which leftovers are removed. Default: run budget + STALE_GRACE_MS. */
  olderThanMs?: number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface CleanUpResult {
  containers: number;
  folders: number;
  runs: number;
}

/**
 * Remove what crashed runs left behind: containers, run folders and clones,
 * and runs stuck as "running". Only things older than the run budget plus a
 * grace period are touched, so other workers' live runs are safe.
 */
export async function cleanUp(deps: MaintenanceDeps): Promise<CleanUpResult> {
  const { sandbox, database, cloneRoot } = deps;
  const olderThan = deps.olderThanMs ?? sandbox.settings.runBudgetMs + STALE_GRACE_MS;
  const log = deps.log ?? (() => undefined);
  const attempt = async (what: string, task: () => Promise<number>) =>
    task().catch((error: unknown) => {
      log(`clean-up of ${what} failed`, { error: (error as Error).message });
      return 0;
    });

  const result = {
    containers: await attempt('containers', () => sandbox.removeStaleContainers(olderThan)),
    folders:
      (await attempt('run folders', () =>
        removeStaleFolders(sandbox.settings.workdirRoot, olderThan),
      )) + (await attempt('clones', () => removeStaleFolders(cloneRoot, olderThan))),
    runs: database
      ? await attempt('stuck runs', () => markStaleRuns(database.db, olderThan, INTERRUPTED))
      : 0,
  };
  if (result.containers || result.folders || result.runs)
    log('cleaned up after crashed runs', { ...result });
  return result;
}

/** Clean up now and then every MAINTENANCE_INTERVAL_MS. Returns a stop function. */
export function startMaintenance(deps: MaintenanceDeps): () => void {
  void cleanUp(deps);
  const timer = setInterval(() => void cleanUp(deps), MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
