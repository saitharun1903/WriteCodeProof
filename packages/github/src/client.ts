import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { COMMENT_MARKER } from '@writecode-proof/core';
import { CHECK_NAME, type CheckConclusion } from './conclusion.js';
import type { GitHubSettings } from './settings.js';

/** Check-run text fields are capped at 65535 characters by GitHub. */
const MAX_OUTPUT_CHARS = 65_000;
const MAX_TITLE_CHARS = 250;
const COMMENTS_PER_PAGE = 100;
/** Retries when GitHub rate-limits a request. */
const RATE_LIMIT_RETRIES = 2;
/** Longer waits than this would hold a run past its budget: fail instead. */
const MAX_RATE_LIMIT_WAIT_S = 60;

/**
 * Octokit that waits out GitHub rate limits (primary and secondary) and
 * retries server errors, instead of failing the run on the first 403/429/5xx.
 */
const ResilientOctokit = Octokit.plugin(throttling, retry);
const retryRateLimit = (retryAfter: number, _options: unknown, _octokit: unknown, count: number) =>
  count < RATE_LIMIT_RETRIES && retryAfter <= MAX_RATE_LIMIT_WAIT_S;

export interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
}

/** Everything the worker does on GitHub for one pull request. */
export interface PullRequestGitHub {
  /** Short-lived token for cloning the repository. */
  cloneToken(): Promise<string | null>;
  createCheckRun(headSha: string, status: 'queued' | 'in_progress'): Promise<number>;
  startCheckRun(checkRunId: number): Promise<void>;
  completeCheckRun(
    checkRunId: number,
    conclusion: CheckConclusion,
    output: CheckOutput,
  ): Promise<void>;
  /** Create our comment, or update it in place on later pushes (spec section 8). */
  upsertComment(body: string): Promise<'created' | 'updated'>;
}

/** The slice of Octokit used here, so tests can pass a fake. */
export interface GitHubRequest {
  request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 40)}\n\n…(truncated)` : text;

interface IssueComment {
  id: number;
  body?: string;
  user?: { type?: string } | null;
  performed_via_github_app?: { id?: number } | null;
}

export interface PullRequestTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

export function pullRequestGitHub(
  rest: GitHubRequest,
  target: PullRequestTarget,
  options: { appId: number | null; token?: () => Promise<string | null> },
): PullRequestGitHub {
  const { owner, repo, prNumber } = target;

  /** Ours = carries the marker and was written by this app (or, failing that, a bot). */
  const isOurs = (c: IssueComment) =>
    !!c.body?.includes(COMMENT_MARKER) &&
    (options.appId !== null
      ? c.performed_via_github_app?.id === options.appId
      : c.user?.type === 'Bot');

  async function findComment(): Promise<IssueComment | null> {
    for (let page = 1; ; page++) {
      const { data } = await rest.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          owner,
          repo,
          issue_number: prNumber,
          per_page: COMMENTS_PER_PAGE,
          page,
        },
      );
      const comments = data as IssueComment[];
      const ours = comments.find(isOurs);
      if (ours) return ours;
      if (comments.length < COMMENTS_PER_PAGE) return null;
    }
  }

  return {
    cloneToken: () => (options.token ? options.token() : Promise.resolve(null)),

    async createCheckRun(headSha, status) {
      const { data } = await rest.request('POST /repos/{owner}/{repo}/check-runs', {
        owner,
        repo,
        name: CHECK_NAME,
        head_sha: headSha,
        status,
        ...(status === 'in_progress' ? { started_at: new Date().toISOString() } : {}),
      });
      return (data as { id: number }).id;
    },

    async startCheckRun(checkRunId) {
      await rest.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
        owner,
        repo,
        check_run_id: checkRunId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });
    },

    async completeCheckRun(checkRunId, conclusion, output) {
      await rest.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
        owner,
        repo,
        check_run_id: checkRunId,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: clip(output.title, MAX_TITLE_CHARS),
          summary: clip(output.summary, MAX_OUTPUT_CHARS),
          ...(output.text ? { text: clip(output.text, MAX_OUTPUT_CHARS) } : {}),
        },
      });
    },

    async upsertComment(body) {
      const existing = await findComment();
      if (existing) {
        await rest.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner,
          repo,
          comment_id: existing.id,
          body,
        });
        return 'updated';
      }
      await rest.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      return 'created';
    },
  };
}

/** Real GitHub, authenticated as the app's installation. */
export class GitHubApp {
  readonly app: App;

  constructor(private readonly settings: GitHubSettings) {
    this.app = new App({
      appId: settings.appId,
      privateKey: settings.privateKey,
      Octokit: ResilientOctokit.defaults({
        baseUrl: settings.apiUrl,
        throttle: { onRateLimit: retryRateLimit, onSecondaryRateLimit: retryRateLimit },
      }),
    });
  }

  async forPullRequest(
    installationId: number,
    target: PullRequestTarget,
  ): Promise<PullRequestGitHub> {
    const octokit = await this.app.getInstallationOctokit(installationId);
    return pullRequestGitHub(octokit as unknown as GitHubRequest, target, {
      appId: Number(this.settings.appId),
      token: async () => {
        const auth = (await octokit.auth({ type: 'installation' })) as { token: string };
        return auth.token;
      },
    });
  }
}
