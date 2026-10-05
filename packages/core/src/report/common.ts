import type { ProofRun } from '../run.js';
import type { Risk } from '../score/score.js';
import { CHECK_ORDER } from '../labels.js';

export interface Report {
  run: ProofRun;
  risk: Risk;
}

/** "Changed 6 functions in 4 files." */
export function changeSummary(run: ProofRun): string {
  const fns = run.changes.changedFunctions;
  const files = new Set(fns.map((f) => f.file)).size;
  if (fns.length === 0) {
    const n = run.changes.files.length;
    return n ? `Changed ${n} file${n === 1 ? '' : 's'}, no functions.` : 'No changes.';
  }
  return `Changed ${fns.length} function${fns.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}.`;
}

export const orderedChecks = (run: ProofRun) =>
  CHECK_ORDER.map((name) => run.checks.find((c) => c.check === name)).filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
