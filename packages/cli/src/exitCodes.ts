import type { RiskBand } from '@writecode-proof/core';

/** Spec section 14. */
export const EXIT = {
  ok: 0,
  high: 1,
  blocked: 2,
  toolError: 3,
} as const;

export function exitCodeFor(band: RiskBand): number {
  if (band === 'blocked') return EXIT.blocked;
  if (band === 'high') return EXIT.high;
  return EXIT.ok;
}
