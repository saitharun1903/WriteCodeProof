import { mkdir } from 'node:fs/promises';
import { git } from '@writecode-proof/core';

export interface FetchOptions {
  cloneUrl: string;
  /** Installation token; null for a public or local remote. */
  token: string | null;
  baseSha: string;
  headSha: string;
  prNumber: number;
  /** Spec: shallow, --depth=50. */
  depth: number;
}

/** Times the history is deepened looking for the merge-base before giving up. */
const DEEPEN_ATTEMPTS = 2;
/** Each attempt fetches this many times `depth` more commits. */
const DEEPEN_FACTOR = 4;

/**
 * The token goes in through GIT_CONFIG_* variables: never on the command line
 * (visible in the process list) and never written to .git/config.
 */
function authEnv(token: string | null): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

async function hasCommit(dir: string, sha: string): Promise<boolean> {
  return git(dir, ['cat-file', '-e', `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );
}

async function hasMergeBase(dir: string, a: string, b: string): Promise<boolean> {
  return git(dir, ['merge-base', a, b]).then(
    () => true,
    () => false,
  );
}

/**
 * Shallow-fetch a pull request's base and head into `dir` (spec step 1–2).
 * Returns `exactBase: true` when the merge-base could not be found, so the
 * diff falls back to the base commit itself.
 */
export async function fetchPullRequest(
  dir: string,
  options: FetchOptions,
): Promise<{ exactBase: boolean }> {
  const env = authEnv(options.token);
  await mkdir(dir, { recursive: true });
  await git(dir, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  await git(dir, ['remote', 'add', 'origin', options.cloneUrl]);

  const depth = `--depth=${options.depth}`;
  // refs/pull/N/head also covers pull requests from forks.
  await git(
    dir,
    [
      'fetch',
      '--quiet',
      '--no-tags',
      depth,
      'origin',
      options.baseSha,
      `refs/pull/${options.prNumber}/head`,
    ],
    {
      env,
    },
  );
  // The pull ref may already point at a newer push; fetch the exact head we were asked for.
  if (!(await hasCommit(dir, options.headSha))) {
    await git(dir, ['fetch', '--quiet', '--no-tags', depth, 'origin', options.headSha], { env });
  }

  for (let attempt = 0; attempt < DEEPEN_ATTEMPTS; attempt++) {
    if (await hasMergeBase(dir, options.baseSha, options.headSha)) return { exactBase: false };
    await git(
      dir,
      ['fetch', '--quiet', '--no-tags', `--deepen=${options.depth * DEEPEN_FACTOR}`, 'origin'],
      {
        env,
      },
    );
  }
  return { exactBase: !(await hasMergeBase(dir, options.baseSha, options.headSha)) };
}

/** A file's contents at a commit, or null if it does not exist there. */
export async function fileAtCommit(dir: string, sha: string, path: string): Promise<string | null> {
  return git(dir, ['show', `${sha}:${path}`]).catch(() => null);
}
