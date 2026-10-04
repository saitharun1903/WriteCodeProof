import type { Report } from './common.js';

/** Bump when the shape of the JSON report changes. */
export const JSON_REPORT_VERSION = 1;

/**
 * Machine-readable report (`--json`). Function bodies are left out: the
 * report describes the change, it never carries the code (spec section 11).
 */
export function toJsonReport({ run, risk }: Report) {
  const { changes } = run;
  return {
    version: JSON_REPORT_VERSION,
    runId: run.runId,
    durationMs: run.durationMs,
    risk,
    base: { ref: changes.baseRef, sha: changes.baseSha },
    head: { ref: changes.headRef, sha: changes.headSha },
    stats: changes.stats,
    changedFunctions: changes.changedFunctions.map((f) => ({
      file: f.file,
      oldFile: f.oldFile,
      name: f.qualifiedName,
      language: f.language,
      status: f.status,
      signature: f.signature,
      line: f.newRange?.start ?? f.oldRange?.start ?? null,
    })),
    skippedFiles: changes.skippedFiles,
    checks: run.checks,
    notes: run.notes,
  };
}
