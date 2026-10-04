import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { CheckResult, Finding } from '../types.js';
import { SCRATCH, type RunContext, type Side } from '../workspace/context.js';
import type { JsTestRunner } from '../workspace/project.js';
import { changedSourceFiles, plural, readOptional, runCheck, stepFailure } from './common.js';
import { isJsTestFile, isPyTestFile, listFiles, testsImporting } from './testFiles.js';
import { parseJestJson, parseJUnit, type TestCase } from './testResults.js';

type Suite = { runner: JsTestRunner | 'pytest'; toolchain: 'node' | 'python'; files: string[] };

interface SuiteRun {
  cases: TestCase[];
  error: string | null;
}

function command(ctx: RunContext, suite: Suite, side: Side, report: string): string[] {
  const out = ctx.containerPath(SCRATCH, report);
  switch (suite.runner) {
    case 'vitest':
      return [
        'node',
        '/node_modules/vitest/vitest.mjs',
        'run',
        '--reporter=junit',
        `--outputFile=${out}`,
        '--passWithNoTests',
        ...suite.files,
      ];
    case 'jest':
      return [
        'node',
        '/node_modules/jest/bin/jest.js',
        '--ci',
        '--json',
        `--outputFile=${out}`,
        '--runTestsByPath',
        ...suite.files,
      ];
    case 'pytest':
      return [
        'python',
        '-m',
        'pytest',
        '-q',
        '-p',
        'no:cacheprovider',
        '-o',
        'junit_family=xunit2',
        `--junitxml=${out}`,
        ...suite.files,
      ];
  }
}

export interface ExistingTestsOptions {
  /** `tests.command` from the repo config: replaces runner detection. */
  command?: string | null;
  /** `tests.time_budget_seconds`: limit for each side's test run. */
  timeoutMs?: number | null;
}

async function runSuite(
  ctx: RunContext,
  suite: Suite,
  side: Side,
  timeoutMs?: number,
): Promise<SuiteRun> {
  const files = suite.files.filter((f) => existsSync(ctx.hostPath(side, f)));
  if (files.length === 0) return { cases: [], error: null };
  const report = `existing-${suite.runner}-${side}.${suite.runner === 'jest' ? 'json' : 'xml'}`;
  await rm(ctx.hostPath(SCRATCH, report), { force: true });

  const result = await ctx.step(
    side,
    suite.toolchain,
    command(ctx, { ...suite, files }, side, report),
    { timeoutMs },
  );
  const raw = await readOptional(ctx.hostPath(SCRATCH, report));
  if (!raw) return { cases: [], error: stepFailure(result) };
  try {
    const cases =
      suite.runner === 'jest' ? parseJestJson(raw, ctx.containerPath(side)) : parseJUnit(raw);
    return { cases, error: result.timedOut ? 'timed out; results are partial' : null };
  } catch {
    return { cases: [], error: stepFailure(result) };
  }
}

/** The repo's own test command: compare its exit status on base and head. */
async function runCommand(
  ctx: RunContext,
  command: string,
  timeoutMs: number | undefined,
  result: CheckResult,
): Promise<void> {
  const toolchain = ctx.projects.head.node ? 'node' : 'python';
  const head = await ctx.step('head', toolchain, ['sh', '-c', command], { timeoutMs });
  const base = await ctx.step('base', toolchain, ['sh', '-c', command], { timeoutMs });
  const passedNow = head.exitCode === 0;
  const passedBefore = base.exitCode === 0;
  result.stats = { run: 1, passed: passedNow ? 1 : 0, newlyFailing: 0, failedBefore: 0 };
  if (passedNow) {
    result.summary = `${command} passes`;
  } else if (passedBefore) {
    result.status = 'failed';
    result.stats.newlyFailing = 1;
    result.summary = `${command} now fails`;
    result.findings.push({
      check: 'existing_tests',
      severity: 'high',
      title: `Test command now fails: ${command}`,
      file: null,
      line: null,
      function: null,
      detail: { command, output: stepFailure(head) },
    });
  } else {
    result.stats.failedBefore = 1;
    result.summary = `${command} fails on both versions`;
    result.notes.push(`Already failing before the change: ${stepFailure(base)}`);
  }
}

/** Spec 5a: run tests related to the change on base and head; flag pass → fail. */
export function existingTestsCheck(
  ctx: RunContext,
  options: ExistingTestsOptions = {},
): Promise<CheckResult> {
  return runCheck('existing_tests', async (result) => {
    const head = ctx.projects.head;
    const allFiles = await listFiles(ctx.hostPath('head'));
    const changed = changedSourceFiles(ctx);
    const changedSet = new Set(changed);
    const timeoutMs = options.timeoutMs ?? undefined;
    if (options.command) {
      await runCommand(ctx, options.command, timeoutMs, result);
      result.stats.untestedFiles = 0;
      return;
    }

    const suites: Suite[] = [];
    if (head.node) {
      const tests = allFiles.filter(isJsTestFile);
      if (!head.node.testRunner) {
        if (tests.length)
          result.notes.push('JavaScript tests found but no vitest or jest; skipped.');
      } else if (tests.length) {
        suites.push({ runner: head.node.testRunner, toolchain: 'node', files: tests });
      }
    }
    if (head.python) {
      const tests = allFiles.filter(isPyTestFile);
      if (tests.length) suites.push({ runner: 'pytest', toolchain: 'python', files: tests });
    }
    if (suites.length === 0) {
      result.status = 'skipped';
      result.summary = 'No existing tests found';
      result.stats.untestedFiles = changed.length;
      return;
    }

    // Prefer tests that import a changed file; otherwise run the whole suite.
    let untested = new Set(changed);
    for (const suite of suites) {
      const related = await testsImporting(ctx.hostPath('head'), suite.files, changedSet);
      for (const file of changed) {
        const covers = await testsImporting(ctx.hostPath('head'), related, new Set([file]));
        if (covers.length) untested.delete(file);
      }
      if (related.length) {
        suite.files = related;
      } else {
        result.notes.push(
          `No ${suite.runner} test imports the changed files; ran all ${plural(suite.files.length, 'test file')}.`,
        );
      }
    }
    if (untested.size) {
      result.notes.push(`No test imports: ${[...untested].join(', ')}`);
    }
    untested = new Set([...untested].filter((f) => !f.endsWith('.d.ts')));

    let run = 0;
    let passed = 0;
    let failedBefore = 0;
    const findings: Finding[] = [];

    for (const suite of suites) {
      const headRun = await runSuite(ctx, suite, 'head', timeoutMs);
      const baseRun = await runSuite(ctx, suite, 'base', timeoutMs);
      if (headRun.error) result.notes.push(`${suite.runner} on head: ${headRun.error}`);
      if (baseRun.error) result.notes.push(`${suite.runner} on base: ${baseRun.error}`);

      const passedOnBase = new Set(
        baseRun.cases.filter((c) => c.outcome === 'passed').map((c) => c.id),
      );
      for (const test of headRun.cases) {
        if (test.outcome === 'skipped') continue;
        run++;
        if (test.outcome === 'passed') {
          passed++;
        } else if (passedOnBase.has(test.id)) {
          findings.push({
            check: 'existing_tests',
            severity: 'high',
            title: `Test now fails: ${test.name}`,
            file: null,
            line: null,
            function: null,
            detail: { test: test.id, runner: suite.runner, message: test.message },
          });
        } else {
          failedBefore++;
        }
      }
      if (headRun.cases.length === 0 && headRun.error) {
        result.status = 'error';
      }
    }

    result.findings = findings;
    result.stats = {
      run,
      passed,
      newlyFailing: findings.length,
      failedBefore,
      untestedFiles: untested.size,
    };
    if (findings.length) {
      result.status = 'failed';
      result.summary = `${run} run, ${plural(findings.length, 'test')} newly failing`;
    } else if (result.status === 'error') {
      result.summary = 'Test run failed to start';
    } else {
      result.summary = `${run} run, ${passed} pass${failedBefore ? `, ${failedBefore} already failing before` : ''}`;
    }
  });
}
