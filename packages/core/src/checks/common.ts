import { readFile } from 'node:fs/promises';
import { CHECK_DEFAULTS } from '../config/defaults.js';
import { detectLanguage } from '../parse/languages.js';
import { BudgetExceededError } from '../sandbox/errors.js';
import type { StepResult } from '../sandbox/runner.js';
import type { CheckName, CheckResult } from '../types.js';
import type { RunContext } from '../workspace/context.js';

export const clip = (text: string, max: number = CHECK_DEFAULTS.MAX_MESSAGE_CHARS) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

/** Last lines of a failed step, for an error note. */
export function stepFailure(result: StepResult): string {
  if (result.timedOut) return 'timed out';
  if (result.oomKilled) return 'ran out of memory';
  const output = (result.stderr || result.stdout).trim();
  return clip(output.split('\n').slice(-8).join('\n')) || `exit code ${result.exitCode}`;
}

export const readOptional = (path: string) => readFile(path, 'utf8').catch(() => null);

/** Repo-relative source files the change touched (supported languages, not ignored). */
export function changedSourceFiles(ctx: RunContext): string[] {
  const ignored = new Set(
    ctx.changes.skippedFiles.filter((s) => s.reason === 'ignored').map((s) => s.path),
  );
  return ctx.changes.files
    .map((f) => f.newPath)
    .filter((p): p is string => !!p && !ignored.has(p) && detectLanguage(p) !== null);
}

/** Run a check, timing it and turning unexpected errors into an `error` result. */
export async function runCheck(
  check: CheckName,
  body: (result: CheckResult) => Promise<void>,
): Promise<CheckResult> {
  const started = Date.now();
  const result: CheckResult = {
    check,
    status: 'passed',
    summary: '',
    findings: [],
    stats: {},
    notes: [],
    durationMs: 0,
  };
  try {
    await body(result);
  } catch (error) {
    const budget = error instanceof BudgetExceededError;
    result.status = result.findings.length && budget ? 'warning' : 'error';
    const message = error instanceof Error ? error.message : String(error);
    result.notes.push(budget ? `Stopped early: ${message}. Results are partial.` : message);
    if (!result.summary) result.summary = budget ? 'Stopped: time budget used up' : 'Could not run';
  }
  result.durationMs = Date.now() - started;
  return result;
}
