import { execFile } from 'node:child_process';
import { ANALYSIS_DEFAULTS } from '../config/defaults.js';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  maxBuffer?: number;
  /** Extra environment variables, e.g. GIT_INDEX_FILE. */
  env?: Record<string, string>;
}

function run(
  cwd: string,
  args: string[],
  encoding: 'utf8' | 'buffer',
  { maxBuffer = ANALYSIS_DEFAULTS.GIT_MAX_BUFFER_BYTES, env }: GitOptions,
): Promise<string | Buffer> {
  // Pin settings that change output format, whatever the user's git config says.
  const fullArgs = ['-c', 'core.quotePath=false', '-c', 'color.ui=never', ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      {
        cwd,
        encoding,
        maxBuffer,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim() || error.message;
          reject(new GitError(`git ${args.join(' ')}: ${detail}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  return (await run(cwd, args, 'utf8', options)) as string;
}

export async function gitBuffer(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<Buffer> {
  return (await run(cwd, args, 'buffer', options)) as Buffer;
}

export async function repoRoot(path: string): Promise<string> {
  try {
    return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new GitError(`${path} is not inside a git repository`);
  }
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
  try {
    return (
      await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    ).trim();
  } catch {
    throw new GitError(`Cannot find "${ref}" in ${root}. Pass a different base or head ref.`);
  }
}

export async function mergeBase(root: string, a: string, b: string): Promise<string> {
  try {
    return (await git(root, ['merge-base', a, b])).trim();
  } catch {
    throw new GitError(`"${a}" and "${b}" have no common history`);
  }
}

/** File contents at a commit, or `null` if the path does not exist there. */
export async function readBlob(
  root: string,
  commit: string,
  path: string,
  options?: GitOptions,
): Promise<Buffer | null> {
  try {
    return await gitBuffer(root, ['cat-file', 'blob', `${commit}:${path}`], options);
  } catch {
    return null;
  }
}

export async function untrackedFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

/** `git diff` between `base` and `head`, or the working tree when `head` is null. */
export function unifiedDiff(
  root: string,
  base: string,
  head: string | null,
  options?: GitOptions,
): Promise<string> {
  return git(
    root,
    [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
      ...(head ? [head] : []),
      '--',
    ],
    options,
  );
}
