/**
 * Risk weights (spec section 7). The only place they are defined;
 * `.writecode/proof.yml` → `policies` can override the policy values.
 */
export const WEIGHTS = {
  /** Existing test that passed on base and fails on head. */
  failingExistingTest: { each: 3.0, max: 6 },
  /** Function whose behaviour changed for at least one input. */
  behaviourChange: { each: 3.0, max: 6 },
  /** Generated test that fails on head and passed on base. */
  failingGeneratedTest: { each: 1.5, max: 4.5 },
  /** Per security finding, by severity. A critical one blocks instead. */
  security: { low: 0.5, medium: 1.5, high: 3.0 },
  /** Linear from 0 at `fromLines` changed lines to `max` at `toLines`. */
  diffSize: { fromLines: 50, toLines: 400, max: 1 },
  /** Scaled by the share of changed source files no test imports. */
  lowCoverage: { max: 1.5 },
  /** Added when the change is AI-authored. */
  aiAuthored: 1.0,
} as const;

export type BlockReason = 'critical_security' | 'secret_leak';

export interface Policy {
  /** Scores below this are Low. */
  mediumFrom: number;
  /** Scores from this up are High. */
  highFrom: number;
  aiAuthoredWeight: number;
  blockOn: BlockReason[];
}

/** Spec section 7 bands: 0–2 Low, 3–6 Medium, 7–10 High. */
export const DEFAULT_POLICY: Policy = {
  mediumFrom: 3,
  highFrom: 7,
  aiAuthoredWeight: WEIGHTS.aiAuthored,
  blockOn: ['critical_security', 'secret_leak'],
};

export const MAX_SCORE = 10;
