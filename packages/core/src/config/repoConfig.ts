import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_POLICY, type Policy } from '../score/weights.js';
import { CHECK_DEFAULTS } from './defaults.js';

/** Where a target repository keeps its settings (spec section 9). */
export const REPO_CONFIG_PATH = '.writecode/proof.yml';

const range = z.tuple([z.number(), z.number()]);

const schema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['advise', 'enforce']).default('advise'),
    languages: z.array(z.enum(['typescript', 'javascript', 'python'])).optional(),
    tests: z
      .object({
        command: z.string().default(''),
        time_budget_seconds: z.number().int().positive().optional(),
      })
      .strict()
      .default({ command: '' }),
    ignore: z.array(z.string()).default([]),
    generated_tests: z
      .object({
        max_functions: z
          .number()
          .int()
          .min(0)
          .default(CHECK_DEFAULTS.GENERATED_TESTS_MAX_FUNCTIONS),
      })
      .strict()
      .default({ max_functions: CHECK_DEFAULTS.GENERATED_TESTS_MAX_FUNCTIONS }),
    policies: z
      .object({
        auto_approve_below: z.number().min(0).max(10).optional(),
        one_reviewer: range.optional(),
        code_owner_above: z.number().min(0).max(10).optional(),
        block_on: z.array(z.enum(['critical_security', 'secret_leak'])).optional(),
        ai_authored_weight: z.number().min(0).max(10).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type RawRepoConfig = z.infer<typeof schema>;

export interface RepoConfig {
  mode: 'advise' | 'enforce';
  languages: ('typescript' | 'javascript' | 'python')[] | null;
  testCommand: string | null;
  testTimeBudgetS: number | null;
  ignore: string[];
  maxGeneratedFunctions: number;
  policy: Policy;
}

export interface LoadedRepoConfig {
  config: RepoConfig;
  /** `null` when the repo has no config file. */
  source: string | null;
  /** Set when the file was invalid; defaults were used instead. */
  error: string | null;
}

function toPolicy(p: RawRepoConfig['policies']): Policy {
  // The spec's three knobs describe one set of bands; the one_reviewer range wins when given.
  const mediumFrom = p.one_reviewer?.[0] ?? p.auto_approve_below ?? DEFAULT_POLICY.mediumFrom;
  const highFrom =
    p.code_owner_above ??
    (p.one_reviewer ? p.one_reviewer[1] + 1 : undefined) ??
    DEFAULT_POLICY.highFrom;
  return {
    mediumFrom,
    highFrom: Math.max(highFrom, mediumFrom),
    aiAuthoredWeight: p.ai_authored_weight ?? DEFAULT_POLICY.aiAuthoredWeight,
    blockOn: p.block_on ?? DEFAULT_POLICY.blockOn,
  };
}

function fromRaw(raw: RawRepoConfig): RepoConfig {
  return {
    mode: raw.mode,
    languages: raw.languages ?? null,
    testCommand: raw.tests.command.trim() || null,
    testTimeBudgetS: raw.tests.time_budget_seconds ?? null,
    ignore: raw.ignore,
    maxGeneratedFunctions: raw.generated_tests.max_functions,
    policy: toPolicy(raw.policies),
  };
}

export const DEFAULT_REPO_CONFIG: RepoConfig = fromRaw(schema.parse({ version: 1 }));

/** Validate YAML text. Invalid config falls back to defaults with an error (spec section 9). */
export function parseRepoConfig(text: string, source: string): LoadedRepoConfig {
  let data: unknown;
  try {
    data = parse(text) ?? {};
  } catch (error) {
    return {
      config: DEFAULT_REPO_CONFIG,
      source,
      error: `${source} is not valid YAML: ${(error as Error).message.split('\n')[0]}`,
    };
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return {
      config: DEFAULT_REPO_CONFIG,
      source,
      error: `${source} is invalid, using defaults. ${issues.join('; ')}`,
    };
  }
  return { config: fromRaw(result.data), source, error: null };
}

export async function loadRepoConfig(dir: string): Promise<LoadedRepoConfig> {
  const path = join(dir, REPO_CONFIG_PATH);
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return { config: DEFAULT_REPO_CONFIG, source: null, error: null };
  return parseRepoConfig(text, REPO_CONFIG_PATH);
}
