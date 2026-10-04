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

/**
 * Defaults for change analysis. Callers (CLI flags, `.writecode/proof.yml`)
 * can override each of these per run.
 */
export const ANALYSIS_DEFAULTS = {
  BASE_REF: 'main',
  /** Files above this size are not parsed. */
  MAX_FILE_BYTES: 1024 * 1024,
  /** Largest `git` output we will buffer (big diffs, big blobs). */
  GIT_MAX_BUFFER_BYTES: 64 * 1024 * 1024,
  /** Paths never analysed: docs, lockfiles, build output, generated code, and tests themselves. */
  IGNORE: [
    'docs/**',
    '**/*.md',
    '**/*.mdx',
    '**/package-lock.json',
    '**/npm-shrinkwrap.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/bun.lockb',
    '**/poetry.lock',
    '**/Pipfile.lock',
    '**/uv.lock',
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/coverage/**',
    '**/vendor/**',
    '**/.venv/**',
    '**/venv/**',
    '**/__pycache__/**',
    '**/__generated__/**',
    '**/*.generated.*',
    '**/*.min.js',
    '**/*.d.ts',
    '**/*.test.*',
    '**/*.spec.*',
    '**/__tests__/**',
    '**/test/**',
    '**/tests/**',
    '**/test_*.py',
    '**/*_test.py',
    '**/conftest.py',
  ],
} as const;

export const LLM_PROVIDERS = ['ollama', 'openai-compatible', 'anthropic'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
