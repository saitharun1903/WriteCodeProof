import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckResult, Finding, Severity } from '../types.js';
import { SCRATCH, type RunContext } from '../workspace/context.js';
import { clip, plural, readOptional, runCheck, stepFailure } from './common.js';

/** Where the tools image keeps the Semgrep rules it was built with. */
const SEMGREP_RULES = '/opt/semgrep-rules/default.yml';
const LEAKS_DIR = 'leaks';
// Same heuristic git uses for binary content.
const BINARY_SNIFF_BYTES = 8000;

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number };
  extra: { message?: string; severity?: string; lines?: string; metadata?: { cwe?: unknown } };
}

interface GitleaksResult {
  RuleID: string;
  Description?: string;
  File: string;
  StartLine: number;
}

/** Spec 5d: ERROR → high, WARNING → medium, INFO → low. */
export function semgrepSeverity(level: string | undefined): Severity {
  switch ((level ?? '').toUpperCase()) {
    case 'CRITICAL':
    case 'ERROR':
    case 'HIGH':
      return 'high';
    case 'WARNING':
    case 'MEDIUM':
      return 'medium';
    default:
      return 'low';
  }
}

/** Identify a finding by rule and the code it matched, so line shifts don't make it "new". */
const fingerprint = (r: SemgrepResult, path: string) =>
  `${r.check_id}\0${path}\0${(r.extra.lines ?? '').replace(/\s+/g, ' ').trim()}`;

async function semgrep(ctx: RunContext, result: CheckResult): Promise<Finding[]> {
  const ignored = new Set(
    ctx.changes.skippedFiles
      .filter((s) => s.reason === 'ignored' || s.reason === 'binary')
      .map((s) => s.path),
  );
  const pairs = ctx.changes.files
    .filter((f) => f.newPath && !ignored.has(f.newPath) && !f.binary)
    .map((f) => ({ head: f.newPath!, base: f.oldPath }));
  if (pairs.length === 0) return [];

  const targets = [
    ...pairs.map((p) => `head/${p.head}`),
    ...pairs.filter((p) => p.base).map((p) => `base/${p.base}`),
  ];
  const report = 'semgrep.json';
  await rm(ctx.hostPath(SCRATCH, report), { force: true });
  const run = await ctx.step(
    'head',
    'tools',
    [
      'semgrep',
      'scan',
      '--metrics=off',
      '--disable-version-check',
      '--config',
      SEMGREP_RULES,
      '--json',
      '--quiet',
      '--output',
      ctx.containerPath(SCRATCH, report),
      ...targets,
    ],
    { cwd: '/work' },
  );
  const raw = await readOptional(ctx.hostPath(SCRATCH, report));
  if (!raw) throw new Error(`Semgrep failed: ${stepFailure(run)}`);
  const parsed = JSON.parse(raw) as { results?: SemgrepResult[]; errors?: unknown[] };
  if (parsed.errors?.length) {
    result.notes.push(`Semgrep could not fully parse ${plural(parsed.errors.length, 'file')}.`);
  }

  const baseToHead = new Map(pairs.filter((p) => p.base).map((p) => [p.base!, p.head]));
  const before = new Set<string>();
  const after: { r: SemgrepResult; file: string }[] = [];
  for (const r of parsed.results ?? []) {
    if (r.path.startsWith('base/')) {
      const head = baseToHead.get(r.path.slice('base/'.length));
      if (head) before.add(fingerprint(r, head));
    } else if (r.path.startsWith('head/')) {
      after.push({ r, file: r.path.slice('head/'.length) });
    }
  }

  const fresh = after.filter(({ r, file }) => !before.has(fingerprint(r, file)));
  result.stats.preexisting = after.length - fresh.length;
  return fresh.map(({ r, file }) => ({
    check: 'security',
    severity: semgrepSeverity(r.extra.severity),
    title: clip(`${r.extra.message ?? r.check_id}`.split('\n')[0]!, 160),
    file,
    line: r.start.line,
    function: null,
    detail: { tool: 'semgrep', rule: r.check_id, cwe: r.extra.metadata?.cwe ?? null },
  }));
}

/** Copy of each changed file with every line blanked except the added ones. */
async function writeAddedLines(ctx: RunContext): Promise<number> {
  let written = 0;
  for (const file of ctx.changes.files) {
    if (!file.newPath || file.binary || file.addedRanges.length === 0) continue;
    const content = await readFile(ctx.hostPath('head', file.newPath)).catch(() => null);
    if (!content || content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    const lines = content.toString('utf8').split('\n');
    const keep = new Set<number>();
    for (const range of file.addedRanges) {
      for (let n = range.start; n <= range.end; n++) keep.add(n);
    }
    const masked = lines.map((line, i) => (keep.has(i + 1) ? line : '')).join('\n');
    const dest = ctx.hostPath(SCRATCH, LEAKS_DIR, file.newPath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, masked);
    written++;
  }
  return written;
}

async function gitleaks(ctx: RunContext): Promise<Finding[]> {
  if ((await writeAddedLines(ctx)) === 0) return [];
  const report = 'gitleaks.json';
  await rm(ctx.hostPath(SCRATCH, report), { force: true });
  const run = await ctx.step(
    'head',
    'tools',
    [
      'gitleaks',
      'dir',
      ctx.containerPath(SCRATCH, LEAKS_DIR),
      '--redact',
      '--no-banner',
      '--exit-code',
      '0',
      '--log-level',
      'error',
      '--report-format',
      'json',
      '--report-path',
      ctx.containerPath(SCRATCH, report),
    ],
    { cwd: '/work' },
  );
  const raw = await readOptional(ctx.hostPath(SCRATCH, report));
  if (!raw) throw new Error(`Gitleaks failed: ${stepFailure(run)}`);
  const prefix = `${ctx.containerPath(SCRATCH, LEAKS_DIR)}/`;
  return (JSON.parse(raw) as GitleaksResult[]).map((leak) => {
    const file = leak.File.replace(prefix, '');
    return {
      check: 'security',
      severity: 'critical',
      title: `Possible secret (${leak.RuleID}) in ${file}:${leak.StartLine}`,
      file,
      line: leak.StartLine,
      function: null,
      detail: { tool: 'gitleaks', rule: leak.RuleID, description: leak.Description ?? null },
    };
  });
}

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Spec 5d: Semgrep on changed files, Gitleaks on added lines only. */
export function securityCheck(ctx: RunContext): Promise<CheckResult> {
  return runCheck('security', async (result) => {
    const leaks = await gitleaks(ctx);
    result.findings.push(...leaks);
    const code = await semgrep(ctx, result);
    result.findings.push(...code);
    result.findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));

    const count = (s: Severity) => result.findings.filter((f) => f.severity === s).length;
    result.stats = {
      ...result.stats,
      critical: count('critical'),
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
    };
    if (result.findings.length === 0) {
      result.summary = 'No new findings';
      return;
    }
    result.status = count('critical') ? 'failed' : 'warning';
    const parts = ORDER.map((s) => (count(s) ? `${count(s)} ${s}` : null)).filter(Boolean);
    result.summary = `${plural(result.findings.length, 'new finding')}: ${parts.join(', ')}`;
  });
}
