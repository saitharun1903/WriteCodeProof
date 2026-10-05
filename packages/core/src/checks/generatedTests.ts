import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { CHECK_DEFAULTS } from '../config/defaults.js';
import { extractCode } from '../llm/json.js';
import { generatedTestsPrompt } from '../llm/prompts/generatedTests.js';
import { LlmError, LlmOutputError, type LlmProvider } from '../llm/types.js';
import { extractFunctions } from '../parse/functions.js';
import type { ChangedFunction, CheckResult, Finding } from '../types.js';
import { SCRATCH, type RunContext, type Side } from '../workspace/context.js';
import { clip, readOptional, runCheck } from './common.js';
import { makeMutants } from './mutants.js';
import { parseJUnit, type TestCase } from './testResults.js';

export interface GeneratedTestsOptions {
  llm: LlmProvider | null;
  maxFunctions?: number;
  mutantsPerFunction?: number;
  testTimeoutMs?: number;
}

/** Folder (inside base/ and head/) the generated test files are written to. */
const GENERATED_DIR = 'wcp_generated';
const MAX_CONTEXT_IMPORTS = 20;
const MAX_FINDINGS_PER_FUNCTION = 3;

interface Target {
  fn: ChangedFunction;
  slug: string;
  testFile: string;
  /** Name the test file imports (function, or class for methods). */
  importName: string;
}

interface GeneratedFile extends Target {
  head: TestCase[];
  base: TestCase[] | null;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function importableName(fn: ChangedFunction): string | null {
  const parts = fn.qualifiedName.split('.');
  if (fn.qualifiedName.includes('#') || fn.language === 'tsx') return null;
  if (fn.language === 'python') {
    if (parts.length === 1) return parts[0]!;
    return parts.length === 2 && fn.kind === 'method' ? parts[0]! : null;
  }
  if (!fn.exported) return null;
  if (parts.length === 1) return fn.name === 'default' ? 'subject' : parts[0]!;
  return parts.length === 2 && fn.kind === 'method' ? parts[0]! : null;
}

function pickTargets(ctx: RunContext, max: number, notes: string[]): Target[] {
  const candidates = ctx.changes.changedFunctions
    .filter((f) => f.status !== 'deleted')
    .sort((a, b) => Number(a.status !== 'modified') - Number(b.status !== 'modified'));
  const targets: Target[] = [];
  for (const fn of candidates) {
    const importName = importableName(fn);
    if (!importName) {
      notes.push(`Skipped ${fn.qualifiedName}: not importable from a test.`);
      continue;
    }
    if (targets.length >= max) {
      notes.push(`Skipped ${fn.qualifiedName}: limit of ${max} functions per run.`);
      continue;
    }
    const slug = `${targets.length + 1}_${fn.qualifiedName.replace(/[^\w]+/g, '_')}`.slice(0, 60);
    const ts = /\.[mc]?tsx?$/.test(fn.file);
    const testFile =
      fn.language === 'python' ? `test_${slug}.py` : `${slug}.test.${ts ? 'mts' : 'mjs'}`;
    targets.push({ fn, slug, testFile, importName });
  }
  return targets;
}

function pythonModule(file: string): string {
  const parts = file.replace(/\.py$/, '').split('/');
  if (parts[0] === 'src') parts.shift();
  if (parts.at(-1) === '__init__') parts.pop();
  return parts.join('.');
}

function preamble(target: Target): string[] {
  const { fn, importName } = target;
  if (fn.language === 'python') {
    return ['import pytest', `from ${pythonModule(fn.file)} import ${importName}`];
  }
  let spec = posix.relative(GENERATED_DIR, fn.file);
  if (!spec.startsWith('.')) spec = `./${spec}`;
  const subject =
    fn.name === 'default' && !fn.qualifiedName.includes('.')
      ? `import ${importName} from '${spec}';`
      : `import { ${importName} } from '${spec}';`;
  return ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", subject];
}

/** Remove imports the model added for things the preamble already provides. */
export function sanitizeTestCode(code: string, target: Pick<Target, 'fn' | 'importName'>): string {
  const name = target.importName;
  const python = target.fn.language === 'python';
  const drop = python
    ? (line: string) =>
        /^\s*import\s+pytest\s*$/.test(line) ||
        new RegExp(`^\\s*from\\s+\\S+\\s+import\\s+.*\\b${name}\\b`).test(line)
    : (line: string) =>
        /^\s*import\s.*from\s+['"](node:test|node:assert(\/strict)?|assert|vitest|@jest\/globals)['"]/.test(
          line,
        ) ||
        new RegExp(`^\\s*import\\s.*\\b${name}\\b.*from\\s+['"]\\.`).test(line) ||
        new RegExp(`^\\s*(const|let|var)\\s.*\\b${name}\\b.*require\\(`).test(line);
  return code
    .split('\n')
    .filter((line) => !drop(line))
    .join('\n')
    .trim();
}

async function moduleImports(ctx: RunContext, fn: ChangedFunction): Promise<string[]> {
  const source = await readFile(ctx.hostPath('head', fn.file), 'utf8').catch(() => '');
  const pattern =
    fn.language === 'python' ? /^\s*(from\s+\S+\s+)?import\s/ : /^\s*import\s|require\(/;
  return source
    .split('\n')
    .filter((l) => pattern.test(l))
    .slice(0, MAX_CONTEXT_IMPORTS);
}

/** Methods need their constructor to build an instance; include it as context. */
async function sourceWithContext(ctx: RunContext, fn: ChangedFunction): Promise<string> {
  if (fn.kind !== 'method') return fn.newSource!;
  const className = fn.qualifiedName.split('.')[0]!;
  const source = await readFile(ctx.hostPath('head', fn.file), 'utf8').catch(() => '');
  const { functions } = await extractFunctions(fn.language, source.replace(/\r\n/g, '\n'));
  const ctor = functions.find(
    (f) =>
      f.qualifiedName === `${className}.constructor` || f.qualifiedName === `${className}.__init__`,
  );
  const header = fn.language === 'python' ? `class ${className}:` : `class ${className} {`;
  const body = [ctor?.source, fn.newSource].filter(Boolean).join('\n\n');
  return fn.language === 'python' ? `${header}\n${body}` : `${header}\n${body}\n}`;
}

async function generate(ctx: RunContext, llm: LlmProvider, target: Target): Promise<string | null> {
  const { fn, importName } = target;
  const lines = preamble(target);
  const { system, prompt } = generatedTestsPrompt({
    language:
      fn.language === 'python'
        ? 'python'
        : fn.language === 'javascript'
          ? 'javascript'
          : 'typescript',
    subject:
      fn.kind === 'method'
        ? `method \`${fn.name}\` of class \`${importName}\``
        : `function \`${fn.name === 'default' ? importName : fn.name}\``,
    preamble: lines,
    importedName: importName,
    moduleImports: await moduleImports(ctx, fn),
    source: await sourceWithContext(ctx, fn),
  });
  const reply = await llm.complete({
    system,
    prompt,
    maxTokens: CHECK_DEFAULTS.GENERATED_TEST_MAX_TOKENS,
  });
  const code = sanitizeTestCode(extractCode(reply), target);
  const hasTests =
    fn.language === 'python' ? /^\s*def test_/m.test(code) : /\btest\s*\(/.test(code);
  if (!hasTests) throw new LlmOutputError('reply contained no tests', reply);
  return `${lines.join('\n')}\n\n${code}\n`;
}

function testCommand(
  target: Target,
  report: string,
  timeoutS: number,
  testTimeoutMs: number,
): string {
  const file = shellQuote(`${GENERATED_DIR}/${target.testFile}`);
  if (target.fn.language === 'python') {
    return `timeout ${timeoutS} python -m pytest -q -p no:cacheprovider -o junit_family=xunit2 --junitxml=${shellQuote(report)} ${file}`;
  }
  return `timeout ${timeoutS} node --test --test-reporter=junit --test-reporter-destination=${shellQuote(report)} --test-timeout=${testTimeoutMs} ${file}`;
}

/** Per-file timeout: every test may use its own limit, plus a little startup time. */
const fileTimeoutS = (testTimeoutMs: number) => Math.ceil((testTimeoutMs * 8) / 1000) + 10;

/** A file that failed to load shows up as one failing case named after the file or module. */
function loadedCases(cases: TestCase[], target: Target): TestCase[] | null {
  const stem = target.testFile.replace(/\.(test\.)?[mc]?[jt]s$|\.py$/, '');
  const fileLevel = cases.filter(
    (c) => c.outcome === 'failed' && (c.name.includes(stem) || c.name.includes(target.testFile)),
  );
  if (cases.length === 0 || fileLevel.length === cases.length) return null;
  return cases;
}

async function runFiles(
  ctx: RunContext,
  side: Side,
  targets: Target[],
  testTimeoutMs: number,
): Promise<Map<string, TestCase[] | null>> {
  const results = new Map<string, TestCase[] | null>();
  for (const toolchain of ['node', 'python'] as const) {
    const group = targets.filter((t) => (t.fn.language === 'python') === (toolchain === 'python'));
    if (group.length === 0) continue;
    const reportDir = ctx.hostPath(SCRATCH, 'generated', side);
    await rm(reportDir, { recursive: true, force: true });
    await mkdir(reportDir, { recursive: true });
    const script = group
      .map((t) =>
        testCommand(
          t,
          ctx.containerPath(SCRATCH, 'generated', side, `${t.slug}.xml`),
          fileTimeoutS(testTimeoutMs),
          testTimeoutMs,
        ),
      )
      .join('\n');
    await ctx.step(side, toolchain, ['sh', '-c', script]);
    for (const t of group) {
      const raw = await readOptional(ctx.hostPath(SCRATCH, 'generated', side, `${t.slug}.xml`));
      results.set(t.slug, raw ? loadedCases(parseJUnit(raw), t) : null);
    }
  }
  return results;
}

/**
 * Run each function's passing tests against its mutants. Returns the ids of
 * tests that failed on at least one mutant (they actually check something).
 */
async function killingTests(
  ctx: RunContext,
  files: GeneratedFile[],
  mutantsPerFunction: number,
  testTimeoutMs: number,
): Promise<{ strong: Set<string>; rated: Set<string> }> {
  const strong = new Set<string>();
  const rated = new Set<string>();
  const originals = new Map<string, string>();
  const lines: Record<'node' | 'python', string[]> = { node: [], python: [] };
  const runs: { file: GeneratedFile; report: string }[] = [];
  const mutantDir = ctx.hostPath(SCRATCH, 'mutants');
  await mkdir(mutantDir, { recursive: true });

  for (const file of files) {
    if (!file.head.some((c) => c.outcome === 'passed') || !file.fn.newRange) continue;
    const path = file.fn.file;
    const original = await readFile(ctx.hostPath('head', path), 'utf8');
    const mutants = await makeMutants(
      file.fn.language,
      original,
      file.fn.newRange,
      mutantsPerFunction,
    );
    if (mutants.length === 0) continue;
    if (!originals.has(path)) originals.set(path, original);
    for (const c of file.head) rated.add(`${file.slug}::${c.id}`);

    const target = shellQuote(ctx.containerPath('head', path));
    const originalCopy = ctx.containerPath(SCRATCH, 'mutants', `${file.slug}.orig`);
    await writeFile(ctx.hostPath(SCRATCH, 'mutants', `${file.slug}.orig`), original);
    mutants.forEach((mutant, i) => {
      const name = `${file.slug}.m${i}`;
      const report = ctx.containerPath(SCRATCH, 'mutants', `${name}.xml`);
      runs.push({ file, report: `${name}.xml` });
      lines[file.fn.language === 'python' ? 'python' : 'node'].push(
        `cp ${shellQuote(ctx.containerPath(SCRATCH, 'mutants', `${name}.src`))} ${target}`,
        testCommand(file, report, fileTimeoutS(testTimeoutMs), testTimeoutMs),
        `cp ${shellQuote(originalCopy)} ${target}`,
      );
    });
    await Promise.all(
      mutants.map((m, i) =>
        writeFile(ctx.hostPath(SCRATCH, 'mutants', `${file.slug}.m${i}.src`), m.source),
      ),
    );
  }
  if (runs.length === 0) return { strong, rated };

  try {
    for (const toolchain of ['node', 'python'] as const) {
      if (lines[toolchain].length) {
        await ctx.step('head', toolchain, ['sh', '-c', lines[toolchain].join('\n')]);
      }
    }
  } finally {
    // Never leave a mutant in place, whatever happened in the container.
    for (const [path, original] of originals) await writeFile(ctx.hostPath('head', path), original);
  }

  for (const run of runs) {
    const raw = await readOptional(ctx.hostPath(SCRATCH, 'mutants', run.report));
    const cases = raw ? parseJUnit(raw) : [];
    const outcome = new Map(cases.map((c) => [c.id, c.outcome]));
    for (const c of run.file.head) {
      if (c.outcome !== 'passed') continue;
      // Missing result = the file crashed or hung under the mutant: also a kill.
      if (outcome.get(c.id) !== 'passed') strong.add(`${run.file.slug}::${c.id}`);
    }
  }
  return { strong, rated };
}

export interface DraftedTests {
  /** Targets with their test file contents. */
  drafts: (Target & { code: string })[];
  notes: string[];
  /** Set when the model stopped answering (down, wrong model, auth): why. */
  modelError: string | null;
  /** Functions that were to get tests. */
  planned: number;
}

/**
 * Ask the model for a test file per target. Split out so it can run while
 * other checks use the sandbox; writes nothing.
 */
export async function draftGeneratedTests(
  ctx: RunContext,
  options: GeneratedTestsOptions,
): Promise<DraftedTests> {
  const notes: string[] = [];
  const { llm } = options;
  if (!llm) return { drafts: [], notes, modelError: null, planned: 0 };
  const targets = pickTargets(
    ctx,
    options.maxFunctions ?? CHECK_DEFAULTS.GENERATED_TESTS_MAX_FUNCTIONS,
    notes,
  );
  const drafts: DraftedTests['drafts'] = [];
  let modelError: string | null = null;
  for (const target of targets) {
    if (ctx.budget.exhausted) {
      notes.push(`Skipped ${target.fn.qualifiedName}: time budget used up.`);
      continue;
    }
    try {
      const code = await generate(ctx, llm, target);
      if (code) drafts.push({ ...target, code });
    } catch (error) {
      notes.push(
        `${target.fn.qualifiedName}: could not generate tests (${(error as Error).message}).`,
      );
      // The model is unreachable or misconfigured: no point asking again for each function.
      if (error instanceof LlmError && !(error instanceof LlmOutputError)) {
        modelError = (error as Error).message;
        break;
      }
    }
  }
  return { drafts, notes, modelError, planned: targets.length };
}

/** Spec 5b: LLM-written tests per changed function, filtered by mutation-lite. */
export function generatedTestsCheck(
  ctx: RunContext,
  options: GeneratedTestsOptions & { drafted?: Promise<DraftedTests> },
): Promise<CheckResult> {
  return runCheck('generated_tests', async (result) => {
    const testTimeoutMs = options.testTimeoutMs ?? CHECK_DEFAULTS.TEST_TIMEOUT_MS;
    if (!options.llm) {
      result.status = 'skipped';
      result.summary = 'Skipped (generation turned off)';
      return;
    }
    const { drafts, notes, modelError, planned } = await (options.drafted ??
      draftGeneratedTests(ctx, options));
    result.notes.push(...notes);
    if (modelError && drafts.length === 0) {
      result.status = 'error';
      result.summary = `Could not run: ${modelError}`;
      return;
    }
    if (drafts.length === 0) {
      const anyTarget = ctx.changes.changedFunctions.some((f) => f.status !== 'deleted');
      result.status = anyTarget ? 'error' : 'skipped';
      result.summary = anyTarget ? 'No tests could be generated' : 'No changed functions to test';
      return;
    }

    for (const draft of drafts) {
      for (const side of ['head', 'base'] as const) {
        if (side === 'base') {
          if (draft.fn.status !== 'modified') continue;
          if (!existsSync(ctx.hostPath('base', draft.fn.oldFile ?? draft.fn.file))) continue;
        }
        await mkdir(ctx.hostPath(side, GENERATED_DIR), { recursive: true });
        await writeFile(ctx.hostPath(side, GENERATED_DIR, draft.testFile), draft.code);
      }
    }

    const headRuns = await runFiles(ctx, 'head', drafts, testTimeoutMs);
    const baseTargets = drafts.filter((t) =>
      existsSync(ctx.hostPath('base', GENERATED_DIR, t.testFile)),
    );
    const baseRuns = await runFiles(ctx, 'base', baseTargets, testTimeoutMs);

    const files: GeneratedFile[] = [];
    let discarded = 0;
    for (const t of drafts) {
      const head = headRuns.get(t.slug);
      if (!head) {
        discarded++;
        result.notes.push(`Discarded tests for ${t.fn.qualifiedName}: the file did not load.`);
        continue;
      }
      files.push({ ...t, head, base: baseRuns.get(t.slug) ?? null });
    }

    const { strong, rated } = await killingTests(
      ctx,
      files,
      options.mutantsPerFunction ?? CHECK_DEFAULTS.MUTANTS_PER_FUNCTION,
      testTimeoutMs,
    );

    const findings: Finding[] = [];
    let total = 0;
    let passing = 0;
    let weak = 0;
    let disagreeing = 0;
    for (const file of files) {
      const hasBase = file.base !== null && file.base.length > 0;
      const passedOnBase = new Set(
        (file.base ?? []).filter((c) => c.outcome === 'passed').map((c) => c.id),
      );
      let reported = 0;
      for (const c of file.head) {
        if (c.outcome === 'skipped') continue;
        const key = `${file.slug}::${c.id}`;
        if (c.outcome === 'passed') {
          total++;
          passing++;
          if (rated.has(key) && !strong.has(key)) weak++;
          continue;
        }
        // Fails on the old code too: the test's expectation is wrong, not the change.
        if (hasBase && !passedOnBase.has(c.id)) {
          disagreeing++;
          continue;
        }
        total++;
        if (reported >= MAX_FINDINGS_PER_FUNCTION) continue;
        reported++;
        const confirmed = hasBase;
        findings.push({
          check: 'generated_tests',
          // Without an old version to compare with, a failure may be the model's mistake.
          severity: confirmed ? 'medium' : 'info',
          title: confirmed
            ? `${file.fn.qualifiedName}: "${c.name}" fails (passed on the old code)`
            : `${file.fn.qualifiedName}: "${c.name}" fails (new function, unconfirmed)`,
          file: file.fn.file,
          line: file.fn.newRange?.start ?? null,
          function: file.fn.qualifiedName,
          detail: {
            test: c.name,
            message: c.message ? clip(c.message) : null,
            confirmed,
          },
        });
      }
    }
    if (disagreeing) {
      result.notes.push(
        `Dropped ${disagreeing} generated test${disagreeing === 1 ? '' : 's'} that also failed on the old code.`,
      );
    }

    result.findings = findings;
    const confirmed = findings.filter((f) => f.severity !== 'info');
    result.stats = {
      functions: drafts.length,
      written: total,
      passing,
      failing: total - passing,
      confirmed: confirmed.length,
      unconfirmed: findings.length - confirmed.length,
      weak,
      dropped: disagreeing,
      discardedFiles: discarded,
    };
    const weakNote = weak ? ` (${weak} weak)` : '';
    const head = `${total} written, ${passing} pass${weakNote}`;
    if (confirmed.length) {
      result.status = 'warning';
      result.summary = `${head} — ${confirmed[0]!.title}`;
    } else {
      result.summary = findings.length ? `${head}, ${findings.length} unconfirmed` : head;
    }
    if (modelError) {
      // Some functions never got tests: say so and count the run as incomplete.
      result.status = 'error';
      result.summary = `${head}; the model stopped answering after ${drafts.length} of ${planned} functions (${modelError})`;
    }
  });
}
