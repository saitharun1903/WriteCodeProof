import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BAND_ACTION,
  BAND_LABEL,
  formatScore,
  parseRepoConfig,
  REPO_CONFIG_PATH,
  DEFAULT_REPO_CONFIG,
  renderErrorMarkdown,
  renderMarkdown,
  riskInputFromRun,
  runProof,
  scoreRisk,
  type LlmProvider,
  type LoadedRepoConfig,
  type Risk,
  type Sandbox,
} from '@writecode-proof/core';
import type { PullRequestGitHub } from './client.js';
import { fetchPullRequest, fileAtCommit } from './clone.js';
import { checkConclusion } from './conclusion.js';
import type { QueuedRun } from './queue.js';
import type { RunStore } from './store.js';
import { isAiAuthored } from './webhook.js';

export interface ProcessDeps {
  github: PullRequestGitHub;
  store: RunStore | null;
  isLatest(key: string, headSha: string): Promise<boolean>;
  sandbox: Sandbox;
  llm: LlmProvider | null;
  cloneRoot: string;
  cloneDepth: number;
  aiLabel: string;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export type ProcessOutcome =
  { status: 'done'; risk: Risk } | { status: 'superseded' } | { status: 'error'; error: string };

const SUPERSEDED = {
  title: 'Superseded by a newer push',
  summary: 'A newer commit was pushed to this pull request; it is being checked instead.',
};

/**
 * Config comes from the base commit, so a pull request cannot loosen the
 * rules it is checked against.
 */
async function configAtBase(dir: string, baseSha: string): Promise<LoadedRepoConfig> {
  const text = await fileAtCommit(dir, baseSha, REPO_CONFIG_PATH);
  if (text === null) return { config: DEFAULT_REPO_CONFIG, source: null, error: null };
  return parseRepoConfig(text, REPO_CONFIG_PATH);
}

/** Spec section 5, GitHub side: clone → checks → comment + status check → store. */
export async function processPullRequest(
  job: QueuedRun,
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  const started = Date.now();
  const { github, store } = deps;
  const log = deps.log ?? (() => undefined);
  const elapsed = () => Date.now() - started;
  let checkRunId = job.checkRunId;

  const supersede = async (): Promise<ProcessOutcome> => {
    if (checkRunId)
      await github.completeCheckRun(checkRunId, 'neutral', SUPERSEDED).catch(() => undefined);
    await store
      ?.finish(job.runId, { status: 'cancelled', error: SUPERSEDED.title, durationMs: elapsed() })
      .catch(() => undefined);
    return { status: 'superseded' };
  };

  if (!(await deps.isLatest(job.key, job.headSha))) return supersede();

  await store?.running(job.runId);
  if (checkRunId) await github.startCheckRun(checkRunId);
  else checkRunId = await github.createCheckRun(job.headSha, 'in_progress');

  const cloneDir = join(deps.cloneRoot, job.runId);
  try {
    log('fetching pull request', { repo: job.fullName, pr: job.prNumber });
    const { exactBase } = await fetchPullRequest(cloneDir, {
      cloneUrl: job.cloneUrl,
      token: await github.cloneToken(),
      baseSha: job.baseSha,
      headSha: job.headSha,
      prNumber: job.prNumber,
      depth: deps.cloneDepth,
    });
    const loaded = await configAtBase(cloneDir, job.baseSha);
    await store?.saveConfig(job, loaded.error ? { error: loaded.error } : loaded.config);

    const run = await runProof({
      repoPath: cloneDir,
      base: job.baseSha,
      head: job.headSha,
      exactBase,
      sandbox: deps.sandbox,
      llm: deps.llm,
      config: loaded.config,
      runId: job.runId,
      onProgress: (message) => log(message, { runId: job.runId }),
    });
    if (exactBase) {
      run.notes.push(
        `The merge-base was not in the last ${deps.cloneDepth} commits; compared against the base commit instead.`,
      );
    }
    if (loaded.error) run.notes.unshift(loaded.error);

    // A newer push arrived while this one ran: its result would be stale.
    if (!(await deps.isLatest(job.key, job.headSha))) return supersede();

    const risk = scoreRisk(
      riskInputFromRun(run, isAiAuthored(job, deps.aiLabel)),
      loaded.config.policy,
    );
    const body = renderMarkdown({ run: { ...run, durationMs: elapsed() }, risk });
    await github.upsertComment(body);
    await github.completeCheckRun(checkRunId, checkConclusion(risk.band, loaded.config.mode), {
      title: `Risk ${formatScore(risk.score)}/10 · ${BAND_LABEL[risk.band]} — ${BAND_ACTION[risk.band]}`,
      summary: body,
    });
    await store?.finish(job.runId, {
      status: 'done',
      risk,
      checks: run.checks,
      durationMs: elapsed(),
    });
    return { status: 'done', risk };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('run failed', { runId: job.runId, error: message });
    // Report on every channel we can; one failing must not hide the others.
    await github
      .upsertComment(renderErrorMarkdown(message, job.runId, elapsed()))
      .catch(() => undefined);
    await github
      .completeCheckRun(checkRunId, 'neutral', { title: 'Could not finish', summary: message })
      .catch(() => undefined);
    await store
      ?.finish(job.runId, { status: 'error', error: message, durationMs: elapsed() })
      .catch(() => undefined);
    return { status: 'error', error: message };
  } finally {
    await rm(cloneDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
