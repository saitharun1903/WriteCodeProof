// Shared by the Docker-backed GitHub tests.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { COMMENT_MARKER } from '@writecode-proof/core';
import { connectDb, type DbHandle } from '@writecode-proof/db';
import {
  prKey,
  type CheckConclusion,
  type CheckOutput,
  type PullRequestGitHub,
  type QueuedRun,
} from '@writecode-proof/github';
import { createExampleRepo, PR_BRANCH } from '../../scripts/example-repo.mjs';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();
}

/** Records everything the worker does on "GitHub"; comments keep their ids. */
export class FakeGitHub implements PullRequestGitHub {
  events: string[] = [];
  comments = new Map<number, string>();
  checks = new Map<number, { conclusion: CheckConclusion | null; output: CheckOutput | null }>();
  private nextId = 1;

  async cloneToken() {
    return null;
  }
  async createCheckRun(_sha: string, status: 'queued' | 'in_progress') {
    const id = this.nextId++;
    this.checks.set(id, { conclusion: null, output: null });
    this.events.push(`check ${id} ${status}`);
    return id;
  }
  async startCheckRun(id: number) {
    this.events.push(`check ${id} in_progress`);
  }
  async completeCheckRun(id: number, conclusion: CheckConclusion, output: CheckOutput) {
    this.checks.set(id, { conclusion, output });
    this.events.push(`check ${id} ${conclusion}`);
  }
  async upsertComment(body: string): Promise<'created' | 'updated'> {
    for (const [id, existing] of this.comments) {
      if (existing.includes(COMMENT_MARKER)) {
        this.comments.set(id, body);
        this.events.push(`comment ${id} updated`);
        return 'updated';
      }
    }
    const id = 1000 + this.comments.size;
    this.comments.set(id, body);
    this.events.push(`comment ${id} created`);
    return 'created';
  }
}

export const PR = 1;

/**
 * A "GitHub" remote built from an example: main = base, refs/pull/1/head =
 * the change, and fetching by commit allowed, as GitHub does.
 */
export function pullRequestRemote(example: string, dir: string) {
  const work = createExampleRepo(example, join(dir, 'work'), { mode: 'branch' });
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(remote, 'update-ref', `refs/pull/${PR}/head`, git(work, 'rev-parse', 'HEAD'));
  return { work, remote };
}

/** A queued run for the remote's pull request, as the webhook would make it. */
export function queuedRun(work: string, remote: string, checkRunId: number | null): QueuedRun {
  const fullName = 'acme/shop';
  return {
    installationId: 4242,
    accountLogin: 'acme',
    owner: 'acme',
    repo: 'shop',
    fullName,
    cloneUrl: pathToFileURL(remote).href,
    prNumber: PR,
    baseRef: 'main',
    baseSha: git(work, 'rev-parse', 'main'),
    headRef: PR_BRANCH,
    headSha: git(work, 'rev-parse', 'HEAD'),
    author: { login: 'dev', type: 'User' },
    labels: [],
    deliveryId: null,
    runId: crypto.randomUUID(),
    checkRunId,
    key: prKey(fullName, PR),
  };
}

/** A throwaway database on the compose Postgres; drop() removes it. */
export async function testDatabase(adminUrl: string) {
  const name = `wcp_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle: DbHandle = connectDb(url.toString());
  await handle.migrate();
  return {
    handle,
    url: url.toString(),
    async drop() {
      await handle.close();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
