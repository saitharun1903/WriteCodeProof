/**
 * Display names and formatting shared by every report: terminal, PR comment
 * and the dashboard. Browser-safe: type imports only, so the dashboard can use
 * it via `@writecode-proof/core/labels` without pulling in Node code.
 */
import type { RiskBand } from './score/score.js';
import type { CheckName, CheckStatus, Severity } from './types.js';

export const BAND_LABEL: Record<RiskBand, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  blocked: 'Blocked',
};

export const BAND_ACTION: Record<RiskBand, string> = {
  low: 'auto-approve allowed',
  medium: 'one reviewer required',
  high: 'code owner review required',
  blocked: 'merge blocked',
};

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

/** Most severe first. */
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** "6", "4.5" */
export const formatScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "3m 12s", "48s" */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export const shortId = (runId: string) => runId.slice(0, 8);
