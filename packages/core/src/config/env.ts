import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULTS, LLM_PROVIDERS, LOG_LEVELS } from './defaults.js';

// `.env` files often contain `KEY=` with nothing after it. Treat that the
// same as the key being absent so defaults and "optional" behave as expected.
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const optionalUrl = z.preprocess(blankToUndefined, z.url().optional());
const positiveInt = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(fallback));
const positiveNumber = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().positive().default(fallback));

const dockerSize = (fallback: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d+[kmg]$/i, 'use a Docker size like 512m or 2g')
      .default(fallback),
  );
const imageName = (fallback: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\w[\w./:@-]*$/, 'not a valid image reference')
      .default(fallback),
  );

export const envSchema = z
  .object({
    // GitHub App
    GITHUB_APP_ID: optionalString,
    GITHUB_PRIVATE_KEY_PATH: optionalString,
    GITHUB_WEBHOOK_SECRET: optionalString,
    WEBHOOK_PROXY_URL: optionalUrl,
    GITHUB_API_URL: z.preprocess(blankToUndefined, z.url().default(DEFAULTS.GITHUB_API_URL)),
    GITHUB_AI_LABEL: z.preprocess(blankToUndefined, z.string().default(DEFAULTS.GITHUB_AI_LABEL)),
    CLONE_DEPTH: positiveInt(DEFAULTS.CLONE_DEPTH),
    // Where PR clones go. Blank = the OS temp folder.
    CLONE_ROOT: optionalString,

    // Infra
    DATABASE_URL: optionalUrl,
    REDIS_URL: optionalUrl,
    HOST: z.preprocess(blankToUndefined, z.string().default(DEFAULTS.HOST)),
    PORT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(65535).default(DEFAULTS.PORT),
    ),
    LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(LOG_LEVELS).default(DEFAULTS.LOG_LEVEL)),

    // LLM
    LLM_PROVIDER: z.preprocess(
      blankToUndefined,
      z.enum(LLM_PROVIDERS).default(DEFAULTS.LLM_PROVIDER),
    ),
    OLLAMA_URL: z.preprocess(blankToUndefined, z.url().default(DEFAULTS.OLLAMA_URL)),
    LLM_MODEL: z.preprocess(blankToUndefined, z.string().default(DEFAULTS.LLM_MODEL)),
    LLM_BASE_URL: optionalUrl,
    LLM_API_KEY: optionalString,
    LLM_TIMEOUT_S: positiveInt(DEFAULTS.LLM_TIMEOUT_S),
    LLM_TEMPERATURE: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(2).default(DEFAULTS.LLM_TEMPERATURE),
    ),
    LLM_MAX_TOKENS: positiveInt(DEFAULTS.LLM_MAX_TOKENS),
    // Where LLM replies are cached. Blank = the user cache folder.
    LLM_CACHE_DIR: optionalString,

    // Sandbox
    SANDBOX_CPUS: positiveNumber(DEFAULTS.SANDBOX_CPUS),
    SANDBOX_MEMORY: dockerSize(DEFAULTS.SANDBOX_MEMORY),
    SANDBOX_PIDS_LIMIT: positiveInt(DEFAULTS.SANDBOX_PIDS_LIMIT),
    SANDBOX_TMPFS_SIZE: dockerSize(DEFAULTS.SANDBOX_TMPFS_SIZE),
    SANDBOX_USER: z.preprocess(
      blankToUndefined,
      z
        .string()
        .regex(/^\d+:\d+$/, 'use numeric uid:gid, e.g. 1000:1000')
        .refine(
          (v) => !v.split(':').some((id) => Number(id) === 0),
          'sandboxes must not run as root',
        )
        .default(DEFAULTS.SANDBOX_USER),
    ),
    SANDBOX_STEP_TIMEOUT_S: positiveInt(DEFAULTS.SANDBOX_STEP_TIMEOUT_S),
    SANDBOX_MAX_OUTPUT_BYTES: positiveInt(DEFAULTS.SANDBOX_MAX_OUTPUT_BYTES),
    // Where per-run temp folders are created. Blank = the OS temp folder.
    SANDBOX_WORKDIR_ROOT: optionalString,
    SANDBOX_IMAGE_NODE: imageName(DEFAULTS.SANDBOX_IMAGE_NODE),
    SANDBOX_IMAGE_PYTHON: imageName(DEFAULTS.SANDBOX_IMAGE_PYTHON),
    SANDBOX_IMAGE_TOOLS: imageName(DEFAULTS.SANDBOX_IMAGE_TOOLS),
    RUN_BUDGET_S: positiveInt(DEFAULTS.RUN_BUDGET_S),
    MAX_CONCURRENT_RUNS: positiveInt(DEFAULTS.MAX_CONCURRENT_RUNS),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === 'openai-compatible' && !env.LLM_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_BASE_URL'],
        message: 'required when LLM_PROVIDER=openai-compatible',
      });
    }
    if (env.LLM_PROVIDER !== 'ollama' && !env.LLM_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_API_KEY'],
        message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
      });
    }
    if (env.SANDBOX_STEP_TIMEOUT_S > env.RUN_BUDGET_S) {
      ctx.addIssue({
        code: 'custom',
        path: ['SANDBOX_STEP_TIMEOUT_S'],
        message: 'cannot be larger than RUN_BUDGET_S',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof Env)[];

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validate settings from `source` (defaults to `process.env`). Throws `ConfigError`. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/**
 * Locate the `.env` file to load: `ENV_FILE` if set, otherwise the nearest
 * `.env` walking up from `startDir`. Returns `undefined` when there is none,
 * which is fine — every setting can also come from the real environment.
 */
export function findEnvFile(startDir: string = process.cwd()): string | undefined {
  const explicit = process.env.ENV_FILE;
  if (explicit) return resolve(explicit);

  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load the nearest `.env` into `process.env` (existing variables win), then validate. */
export function loadEnvFromFile(startDir?: string): Env {
  const file = findEnvFile(startDir);
  if (file) {
    if (!existsSync(file)) throw new ConfigError([`ENV_FILE: ${file} does not exist`]);
    process.loadEnvFile(file);
  }
  return loadEnv();
}
