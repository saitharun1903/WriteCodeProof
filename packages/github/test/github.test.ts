import { sign } from '@octokit/webhooks-methods';
import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER } from '@writecode-proof/core';
import {
  checkConclusion,
  forgivingStore,
  githubWebUrl,
  handleWebhook,
  isAiAuthored,
  pullRequestGitHub,
  pullRequestJob,
  verifySignature,
  type GitHubRequest,
  type PullRequestGitHub,
  type QueuedRun,
  type RunStore,
} from '../src/index.js';

const SECRET = 'test-secret';

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    installation: { id: 42, account: { login: 'acme' } },
    repository: {
      name: 'shop',
      full_name: 'acme/shop',
      clone_url: 'https://github.com/acme/shop.git',
      owner: { login: 'acme' },
    },
    pull_request: {
      number: 7,
      base: { ref: 'main', sha: 'b'.repeat(40) },
      head: { ref: 'feature', sha: 'h'.repeat(40) },
      user: { login: 'dev', type: 'User' },
      labels: [{ name: 'ai-generated' }],
    },
    ...overrides,
  };
}

describe('webhook parsing', () => {
  it('verifies the sha256 signature', async () => {
    const body = JSON.stringify({ a: 1 });
    expect(await verifySignature(SECRET, body, await sign(SECRET, body))).toBe(true);
    expect(await verifySignature(SECRET, body, await sign('other', body))).toBe(false);
    expect(await verifySignature(SECRET, `${body} `, await sign(SECRET, body))).toBe(false);
    expect(await verifySignature(SECRET, body, undefined)).toBe(false);
    expect(await verifySignature(SECRET, body, 'sha1=abc')).toBe(false);
  });

  it('turns opened/synchronize/reopened into a job', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      const job = pullRequestJob('pull_request', prPayload({ action }), 'd1');
      expect(job).toMatchObject({
        installationId: 42,
        accountLogin: 'acme',
        owner: 'acme',
        repo: 'shop',
        fullName: 'acme/shop',
        prNumber: 7,
        baseSha: 'b'.repeat(40),
        headSha: 'h'.repeat(40),
        labels: ['ai-generated'],
        deliveryId: 'd1',
      });
    }
  });

  it('ignores other actions and events', () => {
    expect(pullRequestJob('pull_request', prPayload({ action: 'closed' }), null)).toBeNull();
    expect(pullRequestJob('push', prPayload(), null)).toBeNull();
    expect(pullRequestJob('pull_request', { action: 'opened' }, null)).toBeNull();
  });

  it('detects AI-authored pull requests', () => {
    expect(isAiAuthored({ author: { login: 'x', type: 'Bot' }, labels: [] }, 'ai-generated')).toBe(
      true,
    );
    expect(
      isAiAuthored(
        { author: { login: 'x', type: 'User' }, labels: ['ai-generated'] },
        'ai-generated',
      ),
    ).toBe(true);
    expect(
      isAiAuthored({ author: { login: 'x', type: 'User' }, labels: ['bug'] }, 'ai-generated'),
    ).toBe(false);
  });
});

describe('check conclusion (spec section 8)', () => {
  it.each([
    ['low', 'advise', 'success'],
    ['medium', 'advise', 'success'],
    ['high', 'advise', 'neutral'],
    ['high', 'enforce', 'failure'],
    ['blocked', 'advise', 'failure'],
    ['medium', 'enforce', 'success'],
  ] as const)('%s in %s mode → %s', (band, mode, expected) => {
    expect(checkConclusion(band, mode)).toBe(expected);
  });
});

/** Records requests and answers comment listings from a fixed set. */
function fakeRest(
  comments: { id: number; body: string; user?: object; performed_via_github_app?: object }[] = [],
) {
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  const rest: GitHubRequest = {
    async request(route, params = {}) {
      calls.push({ route, params });
      if (route.startsWith('GET ')) {
        const page = Number(params.page);
        const size = Number(params.per_page);
        return { data: comments.slice((page - 1) * size, page * size) };
      }
      if (route.includes('check-runs') && route.startsWith('POST')) return { data: { id: 99 } };
      return { data: {} };
    },
  };
  return { rest, calls };
}

const target = { owner: 'acme', repo: 'shop', prNumber: 7 };

describe('pull request comment and check run', () => {
  it('creates the comment the first time', async () => {
    const { rest, calls } = fakeRest([{ id: 1, body: 'LGTM', user: { type: 'User' } }]);
    const gh = pullRequestGitHub(rest, target, { appId: 5 });
    expect(await gh.upsertComment(`${COMMENT_MARKER}\nreport`)).toBe('created');
    expect(calls.at(-1)).toMatchObject({
      route: 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      params: { issue_number: 7, body: `${COMMENT_MARKER}\nreport` },
    });
  });

  it('updates our own comment, found across pages', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: 'chat',
      user: { type: 'User' },
    }));
    const ours = { id: 500, body: `${COMMENT_MARKER}\nold`, performed_via_github_app: { id: 5 } };
    const { rest, calls } = fakeRest([...others, ours]);
    const gh = pullRequestGitHub(rest, target, { appId: 5 });
    expect(await gh.upsertComment(`${COMMENT_MARKER}\nnew`)).toBe('updated');
    expect(calls.filter((c) => c.route.startsWith('GET'))).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({
      route: 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
      params: { comment_id: 500 },
    });
  });

  it('never edits someone who quoted the marker, or another app', async () => {
    const { rest } = fakeRest([
      { id: 1, body: `quoting ${COMMENT_MARKER}`, user: { type: 'User' } },
      { id: 2, body: COMMENT_MARKER, performed_via_github_app: { id: 6 } },
    ]);
    expect(await pullRequestGitHub(rest, target, { appId: 5 }).upsertComment(COMMENT_MARKER)).toBe(
      'created',
    );
  });

  it('creates and completes check runs, keeping output within limits', async () => {
    const { rest, calls } = fakeRest();
    const gh = pullRequestGitHub(rest, target, { appId: 5 });
    expect(await gh.createCheckRun('h'.repeat(40), 'queued')).toBe(99);
    expect(calls[0]).toMatchObject({
      route: 'POST /repos/{owner}/{repo}/check-runs',
      params: { name: 'WriteCode Proof', head_sha: 'h'.repeat(40), status: 'queued' },
    });
    await gh.completeCheckRun(99, 'neutral', {
      title: 't'.repeat(400),
      summary: 's'.repeat(100_000),
    });
    const output = calls.at(-1)!.params.output as { title: string; summary: string };
    expect(calls.at(-1)!.params).toMatchObject({
      status: 'completed',
      conclusion: 'neutral',
      check_run_id: 99,
    });
    expect(output.title.length).toBeLessThanOrEqual(255);
    expect(output.summary.length).toBeLessThan(65_536);
  });
});

/** Fake GitHub for one pull request, recording what the webhook handler does. */
function recordingGitHub(failCheckRun = false) {
  const events: string[] = [];
  const github: PullRequestGitHub = {
    cloneToken: async () => null,
    createCheckRun: async (sha, status) => {
      if (failCheckRun) throw new Error('403');
      events.push(`create ${status}`);
      return 1;
    },
    startCheckRun: async () => void events.push('start'),
    completeCheckRun: async (id, conclusion, output) =>
      void events.push(`complete ${id} ${conclusion} ${output.title}`),
    upsertComment: async () => {
      events.push('comment');
      return 'created';
    },
  };
  return { github, events };
}

function recordingStore() {
  const events: string[] = [];
  const store: RunStore = {
    queued: async (_job, runId) => void events.push(`queued ${runId}`),
    running: async () => undefined,
    saveConfig: async () => undefined,
    finish: async (runId, outcome) => void events.push(`${outcome.status} ${runId}`),
  };
  return { store, events };
}

describe('handleWebhook', () => {
  const signed = async (payload: unknown) => {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: await sign(SECRET, rawBody) };
  };

  it('rejects a bad signature', async () => {
    const res = await handleWebhook(
      { event: 'pull_request', deliveryId: 'd', signature: 'sha256=00', rawBody: '{}' },
      {
        secret: SECRET,
        enqueue: async () => [],
        githubFor: async () => recordingGitHub().github,
        store: null,
      },
    );
    expect(res.status).toBe(401);
  });

  it('answers ping and ignores other events', async () => {
    const deps = {
      secret: SECRET,
      enqueue: async () => [],
      githubFor: async () => recordingGitHub().github,
      store: null,
    };
    expect(
      (
        await handleWebhook(
          { event: 'ping', deliveryId: 'd', ...(await signed({ zen: 'x' })) },
          deps,
        )
      ).status,
    ).toBe(200);
    const ignored = await handleWebhook(
      { event: 'issues', deliveryId: 'd', ...(await signed({})) },
      deps,
    );
    expect(ignored).toEqual({ status: 202, body: { ignored: 'issues' } });
  });

  it('sets a pending check, records the run and enqueues it', async () => {
    const { github, events } = recordingGitHub();
    const { store, events: stored } = recordingStore();
    const enqueued: Omit<QueuedRun, 'key'>[] = [];
    const res = await handleWebhook(
      { event: 'pull_request', deliveryId: 'd1', ...(await signed(prPayload())) },
      {
        secret: SECRET,
        enqueue: async (run) => {
          enqueued.push(run);
          return [];
        },
        githubFor: async () => github,
        store,
      },
    );
    expect(res.status).toBe(202);
    expect(events).toEqual(['create queued']);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ prNumber: 7, checkRunId: 1, runId: res.body.queued });
    expect(stored).toEqual([`queued ${res.body.queued}`]);
  });

  it('closes out the runs a new push replaced', async () => {
    const { github, events } = recordingGitHub();
    const { store, events: stored } = recordingStore();
    const old = { runId: 'old-run', checkRunId: 77 } as QueuedRun;
    await handleWebhook(
      {
        event: 'pull_request',
        deliveryId: 'd2',
        ...(await signed(prPayload({ action: 'synchronize' }))),
      },
      { secret: SECRET, enqueue: async () => [old], githubFor: async () => github, store },
    );
    expect(events).toContain('complete 77 neutral Superseded by a newer push');
    expect(stored).toContain('cancelled old-run');
  });

  it('still enqueues when the pending check cannot be created', async () => {
    const { github } = recordingGitHub(true);
    const enqueued: unknown[] = [];
    const res = await handleWebhook(
      { event: 'pull_request', deliveryId: 'd3', ...(await signed(prPayload())) },
      {
        secret: SECRET,
        enqueue: async (run) => {
          enqueued.push(run);
          return [];
        },
        githubFor: async () => github,
        store: null,
      },
    );
    expect(res.status).toBe(202);
    expect(enqueued[0]).toMatchObject({ checkRunId: null });
  });
});

describe('githubWebUrl', () => {
  it('maps API addresses to web addresses', () => {
    expect(githubWebUrl('https://api.github.com')).toBe('https://github.com');
    expect(githubWebUrl('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com');
  });
});

describe('check conclusion for incomplete runs', () => {
  it('is neutral, never success, when checks did not run', () => {
    expect(checkConclusion('low', 'advise', true)).toBe('neutral');
    expect(checkConclusion('medium', 'enforce', true)).toBe('neutral');
  });
  it('still fails a blocked run', () => {
    expect(checkConclusion('blocked', 'advise', true)).toBe('failure');
  });
});

describe('forgivingStore', () => {
  it('logs store failures instead of throwing them', async () => {
    const logged: string[] = [];
    const broken: RunStore = {
      queued: async () => {
        throw new Error('db down');
      },
      running: async () => {
        throw new Error('db down');
      },
      saveConfig: async () => undefined,
      finish: async () => {
        throw new Error('db down');
      },
    };
    const store = forgivingStore(broken, (message) => logged.push(message));
    await expect(store.running('r')).resolves.toBeUndefined();
    await expect(
      store.finish('r', { status: 'error', error: 'x', durationMs: 1 }),
    ).resolves.toBeUndefined();
    expect(logged).toEqual([
      'could not record the run (running)',
      'could not record the run (finish)',
    ]);
  });

  it('lets the webhook queue the run even when recording it fails', async () => {
    const enqueued: unknown[] = [];
    const rawBody = JSON.stringify(prPayload());
    const res = await handleWebhook(
      { event: 'pull_request', deliveryId: 'd', rawBody, signature: await sign(SECRET, rawBody) },
      {
        secret: SECRET,
        enqueue: async (run) => {
          enqueued.push(run);
          return [];
        },
        githubFor: async () => recordingGitHub().github,
        store: {
          queued: async () => {
            throw new Error('db down');
          },
          running: async () => undefined,
          saveConfig: async () => undefined,
          finish: async () => undefined,
        },
      },
    );
    expect(res.status).toBe(202);
    expect(enqueued).toHaveLength(1);
  });
});
