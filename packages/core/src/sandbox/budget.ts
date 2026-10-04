import { BudgetExceededError } from './errors.js';

/** Tracks the time left for a whole run, so no single step can overrun it. */
export class RunBudget {
  private readonly deadline: number;

  constructor(
    readonly totalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + totalMs;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  get exhausted(): boolean {
    return this.remainingMs() === 0;
  }

  /** Timeout for the next step: its own limit, cut short by what is left of the run. */
  stepTimeoutMs(stepLimitMs: number): number {
    const remaining = this.remainingMs();
    if (remaining === 0) throw new BudgetExceededError(this.totalMs);
    return Math.min(stepLimitMs, remaining);
  }
}
