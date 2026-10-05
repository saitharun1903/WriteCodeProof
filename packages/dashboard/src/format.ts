import type { RunSummary } from './api.js';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];
/** Under this many seconds, say "just now". */
const JUST_NOW_S = 45;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago", "yesterday". */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Math.abs(seconds) < JUST_NOW_S) return 'just now';
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(Math.round(seconds / 60), 'minute');
}

export const fullTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Abbreviated commit, as git shows it. */
export const shortSha = (sha: string) => sha.slice(0, 7);

export const STATUS_LABEL: Record<RunSummary['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Could not finish',
  cancelled: 'Superseded',
};

/** Link to the pull request on GitHub, when the run came from one. */
export function pullRequestUrl(run: RunSummary, githubWebUrl: string | null): string | null {
  if (run.source !== 'github' || !run.repo || !run.prNumber || !githubWebUrl) return null;
  return `${githubWebUrl}/${run.repo}/pull/${run.prNumber}`;
}

/** What a run checked: "#12", the head commit, or the working tree. */
export function changeLabel(run: RunSummary): string {
  if (run.prNumber) return `#${run.prNumber}`;
  return run.headSha ? shortSha(run.headSha) : 'working tree';
}
