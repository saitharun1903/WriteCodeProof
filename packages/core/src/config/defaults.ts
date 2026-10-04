/**
 * The only place default settings live. Every value here can be overridden
 * through the environment (see `.env.example`) — code elsewhere must read
 * settings from `loadEnv()` and never repeat these numbers.
 */
export const DEFAULTS = {
  HOST: '127.0.0.1',
  PORT: 3100,
  LOG_LEVEL: 'info',

  LLM_PROVIDER: 'ollama',
  OLLAMA_URL: 'http://localhost:11434',
  LLM_MODEL: 'qwen2.5-coder:7b',

  SANDBOX_CPUS: 1,
  SANDBOX_MEMORY: '2g',
  SANDBOX_STEP_TIMEOUT_S: 120,
  RUN_BUDGET_S: 480,
  MAX_CONCURRENT_RUNS: 1,
} as const;

export const LLM_PROVIDERS = ['ollama', 'openai-compatible', 'anthropic'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
