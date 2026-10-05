import type { RiskBand } from '@writecode-proof/core';

/** Spec section 14. */
export const EXIT = {
  ok: 0,
  high: 1,
  blocked: 2,
  toolError: 3,
} as const;

/** Blocked wins; then an incomplete run is a tool error, so CI never passes on missing checks. */
export function exitCodeFor(risk: {
  band: RiskBand;
  incompleteChecks: readonly unknown[];
}): number {
  if (risk.band === 'blocked') return EXIT.blocked;
  if (risk.incompleteChecks.length) return EXIT.toolError;
  if (risk.band === 'high') return EXIT.high;
  return EXIT.ok;
}
