import { randomUUID } from 'node:crypto';
import {
  behaviourDiffCheck,
  planBehaviourDiff,
  type BehaviourPlan,
} from './checks/behaviourDiff.js';
import { existingTestsCheck } from './checks/existingTests.js';
import {
  draftGeneratedTests,
  generatedTestsCheck,
  type DraftedTests,
} from './checks/generatedTests.js';
import { securityCheck } from './checks/security.js';
import { DEFAULT_REPO_CONFIG, type RepoConfig } from './config/repoConfig.js';
import { collectChanges, type CollectOptions } from './diff/collect.js';
import type { LlmProvider } from './llm/types.js';
import { RunBudget } from './sandbox/budget.js';
import type { Sandbox } from './sandbox/runner.js';
import type { ChangeSet, CheckName, CheckResult } from './types.js';
import { prepareWorkspace, type RunContext } from './workspace/context.js';

export interface ProofOptions extends CollectOptions {
  sandbox: Sandbox;
  /** `null` turns off everything that needs a model (generated tests, LLM inputs). */
  llm: LlmProvider | null;
  /** Skip generated tests even when an LLM is available (CLI --no-generate). */
  generateTests?: boolean;
  maxGeneratedFunctions?: number;
  /** The target repo's `.writecode/proof.yml` (defaults when omitted). */
  config?: RepoConfig;
  runId?: string;
  onProgress?: (message: string) => void;
}

export interface ProofRun {
  runId: string;
  changes: ChangeSet;
  checks: CheckResult[];
  /** Run-level notes, e.g. a failed dependency install. */
  notes: string[];
  durationMs: number;
}

const skipped = (check: CheckName, summary: string): CheckResult => ({
  check,
  status: 'skipped',
  summary,
  findings: [],
  stats: {},
  notes: [],
  durationMs: 0,
});

/** Spec section 5: changes → workspace → checks. Always cleans up the workdir and containers. */
export async function runProof(options: ProofOptions): Promise<ProofRun> {
  const started = Date.now();
  const runId = options.runId ?? randomUUID();
  const progress = options.onProgress ?? (() => undefined);
  const { sandbox, llm } = options;

  const config = options.config ?? DEFAULT_REPO_CONFIG;

  progress('Reading the diff');
  const changes = await collectChanges({
    ...options,
    ignore: [...(options.ignore ?? []), ...config.ignore],
  });
  if (config.languages) {
    const allowed = new Set(config.languages);
    changes.changedFunctions = changes.changedFunctions.filter((f) =>
      allowed.has(f.language === 'tsx' ? 'typescript' : f.language),
    );
  }
  const done = (checks: CheckResult[], notes: string[] = []): ProofRun => ({
    runId,
    changes,
    checks,
    notes,
    durationMs: Date.now() - started,
  });

  if (changes.files.length === 0) {
    const none = 'No changes';
    return done([
      skipped('existing_tests', none),
      skipped('generated_tests', none),
      skipped('behaviour_diff', none),
      skipped('security', none),
    ]);
  }

  await sandbox.ping();
  const budget = new RunBudget(sandbox.settings.runBudgetMs);
  const generate = options.generateTests !== false && llm !== null;
  const testOptions = {
    llm,
    maxFunctions: options.maxGeneratedFunctions ?? config.maxGeneratedFunctions,
  };
  // The model starts as soon as the code is on disk and works while
  // dependencies install and the sandbox runs the other checks.
  let plan: Promise<BehaviourPlan> | undefined;
  let drafted: Promise<DraftedTests> | undefined;
  const startModel = (ctx: RunContext) => {
    if (llm) progress('Asking the model for inputs and tests (in the background)');
    plan = planBehaviourDiff(ctx, { llm });
    drafted = plan.then(() =>
      generate
        ? draftGeneratedTests(ctx, testOptions)
        : { drafts: [], notes: [], modelError: null, planned: 0 },
    );
    // Handled where they are awaited; this keeps an early failure from going unhandled.
    plan.catch(() => undefined);
    drafted.catch(() => undefined);
  };

  const ctx = await prepareWorkspace(changes, {
    sandbox,
    budget,
    runId,
    onProgress: progress,
    onCheckedOut: startModel,
  });
  try {
    progress('Running existing tests');
    const existing = await existingTestsCheck(ctx, {
      command: config.testCommand,
      timeoutMs: config.testTimeBudgetS ? config.testTimeBudgetS * 1000 : null,
    });
    progress('Scanning for security issues');
    const security = await securityCheck(ctx);
    progress('Comparing behaviour of changed functions');
    const behaviour = await behaviourDiffCheck(ctx, { llm, plan });
    if (generate) progress('Running generated tests');
    const generated = generate
      ? await generatedTestsCheck(ctx, { ...testOptions, drafted })
      : skipped('generated_tests', llm ? 'Skipped (--no-generate)' : 'Skipped (no LLM)');

    return done([existing, generated, behaviour, security], ctx.notes);
  } finally {
    await ctx.dispose();
  }
}
