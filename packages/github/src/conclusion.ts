import type { RepoConfig, RiskBand } from '@writecode-proof/core';

export type CheckConclusion = 'success' | 'neutral' | 'failure';

/** Spec section 8: the name of the status check. */
export const CHECK_NAME = 'WriteCode Proof';

/**
 * Spec section 8: success for Low/Medium, neutral for High in advise mode,
 * failure for Blocked, and for High when the repo uses `mode: enforce`.
 */
export function checkConclusion(
  band: RiskBand,
  mode: RepoConfig['mode'],
  incomplete = false,
): CheckConclusion {
  if (band === 'blocked') return 'failure';
  // Checks that did not run cannot vouch for the change.
  if (incomplete) return 'neutral';
  if (band === 'high') return mode === 'enforce' ? 'failure' : 'neutral';
  return 'success';
}
