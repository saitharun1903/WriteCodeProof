export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Ask the model for a JSON reply (uses the provider's JSON mode where it has one). */
  json?: boolean;
}

/** Spec section 10. */
export interface LlmProvider {
  name: string;
  /** Model identifier; part of the cache key. */
  model: string;
  complete(opts: CompleteOptions): Promise<string>;
}

export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LlmError';
  }
}

/** The model replied, but not in the shape we asked for (after one retry). */
export class LlmOutputError extends LlmError {
  constructor(
    message: string,
    readonly reply: string,
  ) {
    super(message);
    this.name = 'LlmOutputError';
  }
}
