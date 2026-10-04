import { verify } from '@octokit/webhooks-methods';

/** Spec section 12: these pull_request actions start a run. */
export const PR_ACTIONS = ['opened', 'synchronize', 'reopened'] as const;

/** Everything the worker needs about one pull request push. Serialisable (queue payload). */
export interface PullRequestJob {
  installationId: number;
  accountLogin: string;
  owner: string;
  repo: string;
  fullName: string;
  cloneUrl: string;
  prNumber: number;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  author: { login: string; type: string };
  labels: string[];
  deliveryId: string | null;
}

export async function verifySignature(
  secret: string,
  rawBody: string,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature || !signature.startsWith('sha256=')) return false;
  try {
    return await verify(secret, rawBody, signature);
  } catch {
    return false;
  }
}

interface PullRequestPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  repository?: {
    name?: string;
    full_name?: string;
    clone_url?: string;
    owner?: { login?: string };
  };
  pull_request?: {
    number?: number;
    base?: { ref?: string; sha?: string };
    head?: { ref?: string; sha?: string };
    user?: { login?: string; type?: string };
    labels?: { name?: string }[];
  };
}

/** A job for this delivery, or null when the event is not one we run on. */
export function pullRequestJob(
  event: string | undefined,
  payload: unknown,
  deliveryId: string | null,
): PullRequestJob | null {
  if (event !== 'pull_request') return null;
  const p = payload as PullRequestPayload;
  if (!PR_ACTIONS.includes(p.action as (typeof PR_ACTIONS)[number])) return null;
  const pr = p.pull_request;
  const repo = p.repository;
  const installationId = p.installation?.id;
  if (!pr?.number || !pr.base?.sha || !pr.head?.sha || !repo?.full_name || !installationId) {
    return null;
  }
  const [owner = '', name = ''] = repo.full_name.split('/');
  return {
    installationId,
    accountLogin: p.installation?.account?.login ?? repo.owner?.login ?? owner,
    owner: repo.owner?.login ?? owner,
    repo: repo.name ?? name,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url ?? '',
    prNumber: pr.number,
    baseRef: pr.base.ref ?? '',
    baseSha: pr.base.sha,
    headRef: pr.head.ref ?? '',
    headSha: pr.head.sha,
    author: { login: pr.user?.login ?? '', type: pr.user?.type ?? 'User' },
    labels: (pr.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    deliveryId,
  };
}

/** Spec section 7: bot author, or the AI label. */
export function isAiAuthored(
  job: Pick<PullRequestJob, 'author' | 'labels'>,
  aiLabel: string,
): boolean {
  return job.author.type === 'Bot' || job.labels.includes(aiLabel);
}
