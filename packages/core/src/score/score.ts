import { CHECK_LABEL, formatScore } from '../labels.js';
import { detectLanguage } from '../parse/languages.js';
import type { ChangeSet, CheckName, CheckResult, Finding } from '../types.js';
import { MAX_SCORE, WEIGHTS, type BlockReason, type Policy } from './weights.js';

export type RiskBand = 'low' | 'medium' | 'high' | 'blocked';

export interface Contribution {
  /** e.g. "1 unexplained behaviour change" */
  label: string;
  points: number;
}

export interface Risk {
  /** 0–10, one decimal. */
  score: number;
  band: RiskBand;
  blocked: boolean;
  blockReasons: BlockReason[];
  contributions: Contribution[];
  /** "Why 6: 1 unexplained behaviour change (+3), AI-authored (+1)" */
  why: string;
  /**
   * Checks that could not run. When any did, the score only covers what ran
   * and may be too low, so a Low score must not be read as safe.
   */
  incompleteChecks: CheckName[];
}

export interface RiskInput {
  checks: CheckResult[];
  /** Changed lines (added + removed), ignored files excluded. */
  changedLines: number;
  /** Changed source files, and how many of them no test imports. */
  sourceFiles: number;
  untestedFiles: number;
  aiAuthored: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function findings(checks: CheckResult[], check: CheckName): Finding[] {
  return checks.find((c) => c.check === check)?.findings ?? [];
}

export function bandFor(score: number, policy: Policy): Exclude<RiskBand, 'blocked'> {
  if (score >= policy.highFrom) return 'high';
  if (score >= policy.mediumFrom) return 'medium';
  return 'low';
}

/** Spec section 7: risk = min(10, round(Σ weight × signal, 1)), with a one-line reason. */
export function scoreRisk(input: RiskInput, policy: Policy): Risk {
  const parts: Contribution[] = [];
  const add = (label: string, points: number) => {
    if (points > 0) parts.push({ label, points: round1(points) });
  };

  const failingTests = findings(input.checks, 'existing_tests').length;
  add(
    plural(failingTests, 'existing test now failing', 'existing tests now failing'),
    Math.min(failingTests * WEIGHTS.failingExistingTest.each, WEIGHTS.failingExistingTest.max),
  );

  const behaviour = findings(input.checks, 'behaviour_diff').length;
  add(
    plural(behaviour, 'unexplained behaviour change'),
    Math.min(behaviour * WEIGHTS.behaviourChange.each, WEIGHTS.behaviourChange.max),
  );

  // Only failures confirmed against the old code count; "info" ones are the model's guesses.
  const generated = findings(input.checks, 'generated_tests').filter(
    (f) => f.severity !== 'info',
  ).length;
  add(
    plural(generated, 'failing generated test'),
    Math.min(generated * WEIGHTS.failingGeneratedTest.each, WEIGHTS.failingGeneratedTest.max),
  );

  const security = findings(input.checks, 'security');
  const blockReasons = new Set<BlockReason>();
  for (const level of ['high', 'medium', 'low'] as const) {
    const n = security.filter((f) => f.severity === level).length;
    add(plural(n, `${level} security finding`), n * WEIGHTS.security[level]);
  }
  let unblockedCritical = 0;
  for (const f of security.filter((s) => s.severity === 'critical')) {
    const reason: BlockReason = f.detail.tool === 'gitleaks' ? 'secret_leak' : 'critical_security';
    if (policy.blockOn.includes(reason)) blockReasons.add(reason);
    else unblockedCritical++;
  }
  // The repo chose not to block on these; they still count as heavily as a high finding.
  add(
    plural(unblockedCritical, 'critical security finding'),
    unblockedCritical * WEIGHTS.security.high,
  );

  const { fromLines, toLines, max } = WEIGHTS.diffSize;
  const sizeShare = Math.min(
    1,
    Math.max(0, (input.changedLines - fromLines) / (toLines - fromLines)),
  );
  add(`${input.changedLines} lines changed`, sizeShare * max);

  if (input.sourceFiles > 0) {
    add(
      `${plural(input.untestedFiles, 'changed file')} without tests`,
      (input.untestedFiles / input.sourceFiles) * WEIGHTS.lowCoverage.max,
    );
  }

  if (input.aiAuthored) add('AI-authored', policy.aiAuthoredWeight);

  parts.sort((a, b) => b.points - a.points);
  const score = Math.min(MAX_SCORE, round1(parts.reduce((sum, p) => sum + p.points, 0)));
  const blocked = blockReasons.size > 0;
  const band: RiskBand = blocked ? 'blocked' : bandFor(score, policy);

  const reasons = parts.map((p) => `${p.label} (+${formatScore(p.points)})`);
  if (blocked) {
    const what = [...blockReasons].map((r) =>
      r === 'secret_leak' ? 'secret in the diff' : 'critical security finding',
    );
    reasons.unshift(`${what.join(' and ')} (blocks merge)`);
  }
  const incompleteChecks = input.checks.filter((c) => c.status === 'error').map((c) => c.check);
  const why = `Why ${formatScore(score)}: ${reasons.length ? reasons.join(', ') : 'no risk signals'}`;

  return {
    score,
    band,
    blocked,
    blockReasons: [...blockReasons],
    contributions: parts,
    why: incompleteChecks.length
      ? `${why}; incomplete: ${incompleteChecks.map((c) => CHECK_LABEL[c].toLowerCase()).join(', ')} could not run`
      : why,
    incompleteChecks,
  };
}

/** Pull the score inputs out of a finished run. */
export function riskInputFromRun(
  run: { checks: CheckResult[]; changes: ChangeSet },
  aiAuthored: boolean,
): RiskInput {
  const ignored = new Set(
    run.changes.skippedFiles.filter((s) => s.reason === 'ignored').map((s) => s.path),
  );
  const sourceFiles = run.changes.files.filter(
    (f) => f.newPath && !ignored.has(f.newPath) && detectLanguage(f.newPath),
  ).length;
  const existing = run.checks.find((c) => c.check === 'existing_tests');
  const untested =
    existing?.status === 'skipped' ? sourceFiles : (existing?.stats.untestedFiles ?? 0);
  return {
    checks: run.checks,
    changedLines: run.changes.stats.additions + run.changes.stats.deletions,
    sourceFiles,
    untestedFiles: Math.min(untested, sourceFiles),
    aiAuthored,
  };
}
