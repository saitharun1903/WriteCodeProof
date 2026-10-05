import pc from 'picocolors';
import {
  CHECK_LABEL,
  changeSummary,
  formatDuration,
  formatScore,
  orderedChecks,
  riskHeadline,
  shortId,
  type CheckStatus,
  type Finding,
  type Report,
  type RiskBand,
  type Severity,
} from '@writecode-proof/core';

const BAND_COLOR: Record<RiskBand, (s: string) => string> = {
  low: pc.green,
  medium: pc.yellow,
  high: pc.red,
  blocked: (s) => pc.bold(pc.red(s)),
};

const STATUS: Record<CheckStatus, string> = {
  passed: pc.green('✔'),
  warning: pc.yellow('⚠'),
  failed: pc.red('✖'),
  skipped: pc.dim('–'),
  error: pc.magenta('!'),
};

const SEVERITY: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bold(pc.red(s)),
  high: pc.red,
  medium: pc.yellow,
  low: pc.cyan,
  info: pc.dim,
};

const LABEL_WIDTH = Math.max(...Object.values(CHECK_LABEL).map((l) => l.length)) + 2;
const SEVERITY_WIDTH = 'critical'.length + 1;

const MESSAGE_WIDTH = 140;

/** Assertion output on one line, without diff markers: "Expected …: 123.45 !== 123.46". */
export function oneLine(message: string): string {
  const text = message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '^' && l !== '+ actual - expected')
    .join(' ');
  return text.length > MESSAGE_WIDTH ? `${text.slice(0, MESSAGE_WIDTH - 1)}…` : text;
}

function finding(f: Finding): string[] {
  const where = f.file ? pc.dim(`  ${f.file}${f.line ? `:${f.line}` : ''}`) : '';
  const lines = [
    `    ${SEVERITY[f.severity](f.severity.padEnd(SEVERITY_WIDTH))}${f.title}${where}`,
  ];
  const examples = Array.isArray(f.detail.examples) ? f.detail.examples.slice(1) : [];
  for (const e of examples) {
    lines.push(
      pc.dim(`    ${' '.repeat(SEVERITY_WIDTH)}also: ${(e as { summary?: string }).summary ?? ''}`),
    );
  }
  const message = typeof f.detail.message === 'string' ? oneLine(f.detail.message) : '';
  if (message) lines.push(pc.dim(`    ${' '.repeat(SEVERITY_WIDTH)}${message}`));
  return lines;
}

/** Terminal version of the Proof Pack: same content as the PR comment, in colour. */
export function renderTerminal(report: Report, footerExtra = ''): string {
  const { run, risk } = report;
  const { label, action } = riskHeadline(risk);
  const incomplete = risk.incompleteChecks.length > 0 && risk.band !== 'blocked';
  const color = incomplete ? pc.magenta : BAND_COLOR[risk.band];
  const checks = orderedChecks(run);
  const out = [
    '',
    pc.bold(
      `WriteCode Proof · ${color(`Risk ${formatScore(risk.score)}/10 · ${label}`)} — ${action}`,
    ),
    ...(incomplete
      ? [pc.magenta('Some checks did not finish, so this score only covers what ran.')]
      : []),
    changeSummary(run),
    '',
    ...checks.map(
      (c) => `  ${STATUS[c.status]} ${CHECK_LABEL[c.check].padEnd(LABEL_WIDTH)}${c.summary}`,
    ),
    '',
    `${pc.bold(risk.why.replace(/:.*/, ':'))}${risk.why.replace(/^[^:]*:/, '')}`,
  ];

  const withFindings = checks.filter((c) => c.findings.length);
  if (withFindings.length) {
    out.push('', pc.bold('Findings'));
    for (const c of withFindings) {
      out.push(`  ${CHECK_LABEL[c.check]}`, ...c.findings.flatMap(finding));
    }
  }

  const notes = [
    ...checks.flatMap((c) => c.notes.map((n) => `${CHECK_LABEL[c.check]}: ${n}`)),
    ...run.notes,
  ];
  if (notes.length) {
    out.push('', pc.bold('Notes'), ...notes.map((n) => pc.dim(`  ${n}`)));
  }
  out.push(
    '',
    pc.dim(`Run ${shortId(run.runId)} · ${formatDuration(run.durationMs)}${footerExtra}`),
    '',
  );
  return out.join('\n');
}
