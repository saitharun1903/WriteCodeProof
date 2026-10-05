import { basename } from 'node:path';
import { git, type ProofRun, type Risk } from '@writecode-proof/core';
import { connectDb, createRun, finishRun } from '@writecode-proof/db';

/** "owner/repo" from the origin remote, or the folder name. */
export async function repoLabel(root: string): Promise<string> {
  const url = (await git(root, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? basename(root);
}

/** Save a finished CLI run so it shows on the dashboard. */
export async function saveRun(databaseUrl: string, root: string, run: ProofRun, risk: Risk) {
  const database = connectDb(databaseUrl);
  try {
    await database.migrate();
    await createRun(database.db, {
      id: run.runId,
      source: 'cli',
      repoLabel: await repoLabel(root),
      baseSha: run.changes.baseSha,
      headSha: run.changes.headSha,
      status: 'running',
    });
    await finishRun(database.db, run.runId, {
      status: 'done',
      risk,
      checks: run.checks,
      durationMs: run.durationMs,
    });
  } finally {
    await database.close();
  }
}
