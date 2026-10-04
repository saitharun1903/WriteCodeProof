import { BAND_ACTION, BAND_LABEL, formatScore } from '../score/score.js';
import type { CheckResult, Finding } from '../types.js';
import {
  CHECK_LABEL,
  changeSummary,
  formatDuration,
  orderedChecks,
  shortId,
  STATUS_ICON,
  type Report,
} from './common.js';

/** Hidden marker used to find and update our own PR comment (spec section 8). */
export const COMMENT_MARKER = '<!-- writecode-proof -->';
const PRODUCT = 'WriteCode Proof';

/** Escape text for a Markdown table cell or inline text. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/([*_`[\]<>])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

function heading({ risk }: Report): string {
  const band = BAND_LABEL[risk.band];
  return `## ${PRODUCT} · Risk ${formatScore(risk.score)}/10 · ${band} — ${BAND_ACTION[risk.band]}`;
}

function findingLine(f: Finding): string {
  const where = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
  return `- **${f.severity}** ${escapeMarkdown(f.title)}${where}`;
}

function examples(f: Finding): string[] {
  const list = f.detail.examples;
  if (!Array.isArray(list) || list.length <= 1) return [];
  return list
    .slice(1)
    .map((e) => `  - ${escapeMarkdown(String((e as { summary?: string }).summary ?? ''))}`);
}

function checkDetails(check: CheckResult): string[] {
  if (check.findings.length === 0 && check.notes.length === 0) return [];
  const lines = [`#### ${CHECK_LABEL[check.check]}`, ''];
  for (const f of check.findings) {
    lines.push(findingLine(f), ...examples(f));
    const message = f.detail.message;
    if (typeof message === 'string' && message) {
      lines.push(`  <pre>${escapeHtml(message)}</pre>`);
    }
  }
  for (const note of check.notes) lines.push(`- _${escapeMarkdown(note)}_`);
  lines.push('');
  return lines;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The PR comment and `--out` file (spec section 8). */
export function renderMarkdown(report: Report): string {
  const { run, risk } = report;
  const checks = orderedChecks(run);
  const lines = [
    COMMENT_MARKER,
    heading(report),
    '',
    changeSummary(run),
    '',
    '| Check | Result |',
    '|---|---|',
    ...checks.map(
      (c) => `| ${CHECK_LABEL[c.check]} | ${STATUS_ICON[c.status]} ${escapeMarkdown(c.summary)} |`,
    ),
    '',
    `**${escapeMarkdown(risk.why).replace(/^(Why [\d.]+:)/, '$1**')}`,
    '',
  ];

  const details = checks.flatMap(checkDetails);
  const runNotes = run.notes.map((n) => `- _${escapeMarkdown(n)}_`);
  if (details.length || runNotes.length) {
    lines.push(
      '<details><summary>Details</summary>',
      '',
      ...details,
      ...runNotes,
      '',
      '</details>',
      '',
    );
  }
  lines.push(
    `<sub>Run ${shortId(run.runId)} · ${formatDuration(run.durationMs)} · ${PRODUCT}</sub>`,
  );
  return `${lines.join('\n')}\n`;
}

/** Comment for a run that could not finish: says what went wrong, replaces any older report. */
export function renderErrorMarkdown(message: string, runId: string, durationMs: number): string {
  return [
    COMMENT_MARKER,
    `## ${PRODUCT} · Could not finish`,
    '',
    'The checks did not complete for this push, so there is no risk score.',
    '',
    '```',
    message.replace(/```/g, "'''"),
    '```',
    '',
    'Push again or re-run the check to retry.',
    '',
    `<sub>Run ${shortId(runId)} · ${formatDuration(durationMs)} · ${PRODUCT}</sub>`,
    '',
  ].join('\n');
}
