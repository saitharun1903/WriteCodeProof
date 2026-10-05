/**
 * The only place default settings live. Every value here can be overridden
 * through the environment (see `.env.example`) — code elsewhere must read
 * settings from `loadEnv()` and never repeat these numbers.
 */
export const DEFAULTS = {
  HOST: '127.0.0.1',
  PORT: 3100,
  /** Vite dev server for the dashboard (npm run dev:dashboard); production uses PORT. */
  DASHBOARD_PORT: 3101,
  LOG_LEVEL: 'info',
  /** Requests per minute per client on the API (health checks exempt). */
  RATE_LIMIT_PER_MINUTE: 120,
  /** Set when the API sits behind a proxy (nginx), so limits apply per real client. */
  TRUST_PROXY: false,

  GITHUB_API_URL: 'https://api.github.com',
  /** PRs with this label count as AI-authored (spec section 7). */
  GITHUB_AI_LABEL: 'ai-generated',
  /** Spec 5 step 1–2: shallow clone depth for PR checkouts. */
  CLONE_DEPTH: 50,

  LLM_PROVIDER: 'ollama',
  OLLAMA_URL: 'http://localhost:11434',
  LLM_MODEL: 'qwen2.5-coder:7b',
  ANTHROPIC_URL: 'https://api.anthropic.com',
  LLM_TIMEOUT_S: 180,
  LLM_TEMPERATURE: 0.2,
  LLM_MAX_TOKENS: 2048,

  SANDBOX_CPUS: 1,
  SANDBOX_MEMORY: '2g',
  SANDBOX_PIDS_LIMIT: 256,
  SANDBOX_TMPFS_SIZE: '512m',
  SANDBOX_USER: '1000:1000',
  SANDBOX_STEP_TIMEOUT_S: 120,
  SANDBOX_MAX_OUTPUT_BYTES: 1024 * 1024,
  SANDBOX_IMAGE_NODE: 'writecode-proof/sandbox-node:1',
  SANDBOX_IMAGE_PYTHON: 'writecode-proof/sandbox-python:1',
  SANDBOX_IMAGE_TOOLS: 'writecode-proof/sandbox-tools:1',
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

/** Per-run defaults for the checks. `.writecode/proof.yml` and CLI flags override them. */
export const CHECK_DEFAULTS = {
  /** Spec 5b: generated tests are written for at most this many functions per run. */
  GENERATED_TESTS_MAX_FUNCTIONS: 10,
  /** Spec 5b: mutants tried per function to weed out weak tests. */
  MUTANTS_PER_FUNCTION: 2,
  /** Spec 5c: inputs asked from the LLM per function. */
  BEHAVIOUR_LLM_INPUTS: 10,
  /** Upper bound after adding generic edge-case inputs. */
  BEHAVIOUR_MAX_INPUTS: 30,
  /** A single function call longer than this counts as hanging. */
  CALL_TIMEOUT_MS: 2000,
  /** Most tokens the model may write for one test file (keeps slow local models in check). */
  GENERATED_TEST_MAX_TOKENS: 900,
  /** Single generated or existing test longer than this is stopped. */
  TEST_TIMEOUT_MS: 10_000,
  /** Clock and seed used so both sides see the same "random" values and time. */
  FROZEN_TIME_ISO: '2025-01-01T00:00:00.000Z',
  RANDOM_SEED: 1337,
  /** Characters of failure output kept per finding. */
  MAX_MESSAGE_CHARS: 500,
} as const;

export const LLM_PROVIDERS = ['ollama', 'openai-compatible', 'anthropic'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
