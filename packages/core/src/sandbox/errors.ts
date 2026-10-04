export class SandboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SandboxError';
  }
}

/** The whole-run time budget ran out before a step could start. */
export class BudgetExceededError extends SandboxError {
  constructor(budgetMs: number) {
    super(`Run budget of ${Math.round(budgetMs / 1000)}s used up`);
    this.name = 'BudgetExceededError';
  }
}
