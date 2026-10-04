import { randomUUID } from 'node:crypto';
import type { PullRequestGitHub, PullRequestTarget } from './client.js';
import type { QueuedRun } from './queue.js';
import type { RunStore } from './store.js';
import { pullRequestJob, verifySignature, type PullRequestJob } from './webhook.js';

export interface WebhookRequest {
  event: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  rawBody: string;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookDeps {
  secret: string;
  enqueue(run: Omit<QueuedRun, 'key'>): Promise<QueuedRun[]>;
  githubFor(installationId: number, target: PullRequestTarget): Promise<PullRequestGitHub>;
  store: RunStore | null;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

const SUPERSEDED = {
  title: 'Superseded by a newer push',
  summary: 'A newer commit was pushed before this one was checked.',
};

const targetOf = (job: PullRequestJob): PullRequestTarget => ({
  owner: job.owner,
  repo: job.repo,
  prNumber: job.prNumber,
});

/** Spec section 12: verify, set a pending status check, enqueue. */
export async function handleWebhook(
  req: WebhookRequest,
  deps: WebhookDeps,
): Promise<WebhookResponse> {
  const log = deps.log ?? (() => undefined);
  if (!(await verifySignature(deps.secret, req.rawBody, req.signature))) {
    return { status: 401, body: { error: 'invalid signature' } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: 'body is not JSON' } };
  }
  if (req.event === 'ping') return { status: 200, body: { ok: true } };

  const job = pullRequestJob(req.event, payload, req.deliveryId ?? null);
  if (!job) return { status: 202, body: { ignored: req.event ?? 'unknown event' } };

  const runId = randomUUID();
  const github = await deps.githubFor(job.installationId, targetOf(job));
  let checkRunId: number | null = null;
  try {
    checkRunId = await github.createCheckRun(job.headSha, 'queued');
  } catch (error) {
    // The worker creates it later; a missing pending status must not lose the run.
    log('could not create check run', { error: (error as Error).message });
  }
  await deps.store?.queued(job, runId);
  const replaced = await deps.enqueue({ ...job, runId, checkRunId });

  for (const old of replaced) {
    await deps.store
      ?.finish(old.runId, { status: 'cancelled', error: SUPERSEDED.title, durationMs: 0 })
      .catch(() => undefined);
    if (old.checkRunId) {
      await github.completeCheckRun(old.checkRunId, 'neutral', SUPERSEDED).catch(() => undefined);
    }
  }
  log('queued', { runId, repo: job.fullName, pr: job.prNumber, replaced: replaced.length });
  return { status: 202, body: { queued: runId, replaced: replaced.length } };
}
