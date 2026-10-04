import type { ProofRun } from '../run.js';
import type { Risk } from '../score/score.js';
import type { CheckName, CheckStatus } from '../types.js';

export interface Report {
  run: ProofRun;
  risk: Risk;
}

/** Display order and names (spec section 8). */
export const CHECK_ORDER: CheckName[] = [
  'existing_tests',
  'generated_tests',
  'behaviour_diff',
  'security',
];

export const CHECK_LABEL: Record<CheckName, string> = {
  existing_tests: 'Existing tests',
  generated_tests: 'Generated tests',
  behaviour_diff: 'Behaviour diff',
  security: 'Security',
};

export const STATUS_ICON: Record<CheckStatus, string> = {
  passed: '✅',
  warning: '⚠️',
  failed: '❌',
  skipped: '➖',
  error: '❗',
};

/** "3m 12s", "48s" */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
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

export const shortId = (runId: string) => runId.slice(0, 8);

export const orderedChecks = (run: ProofRun) =>
  CHECK_ORDER.map((name) => run.checks.find((c) => c.check === name)).filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
