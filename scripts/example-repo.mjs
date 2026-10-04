#!/usr/bin/env node
// Turn examples/<name>/{base,pr} into a real git repository:
//   main = base/, then pr/ applied either as uncommitted changes (default)
//   or as a commit on a branch called "pr" (--branch).
//
// Usage: node scripts/example-repo.mjs <name> [dest] [--branch]
// Default dest: .examples/<name>  (gitignored)

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PR_BRANCH = 'pr';

// Fixed identity so sample commits never pick up (or need) the user's git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Example',
  GIT_AUTHOR_EMAIL: 'example@example.invalid',
  GIT_COMMITTER_NAME: 'Example',
  GIT_COMMITTER_EMAIL: 'example@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function replaceContents(source, dest) {
  for (const entry of readdirSync(dest)) {
    if (entry !== '.git') rmSync(join(dest, entry), { recursive: true, force: true });
  }
  cpSync(source, dest, { recursive: true });
}

/**
 * @param {string} name   folder under examples/
 * @param {string} dest   where to create the repository (wiped first)
 * @param {{ mode?: 'worktree' | 'branch' }} [options]
 * @returns {string} absolute path of the created repository
 */
export function createExampleRepo(name, dest, { mode = 'worktree' } = {}) {
  const exampleDir = join(repoRoot, 'examples', name);
  if (!existsSync(join(exampleDir, 'base')) || !existsSync(join(exampleDir, 'pr'))) {
    throw new Error(`examples/${name} needs base/ and pr/ folders`);
  }
  const target = resolve(dest);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  cpSync(join(exampleDir, 'base'), target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'add', '-A');
  git(target, 'commit', '-q', '-m', 'Base version');

  if (mode === 'branch') git(target, 'checkout', '-q', '-b', PR_BRANCH);
  replaceContents(join(exampleDir, 'pr'), target);
  if (mode === 'branch') {
    git(target, 'add', '-A');
    git(target, 'commit', '-q', '-m', 'Proposed change');
  }
  return target;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('Usage: node scripts/example-repo.mjs <name> [dest] [--branch]');
    process.exit(1);
  }
  const dest = args.filter((a) => !a.startsWith('--'))[1] ?? join(repoRoot, '.examples', name);
  const mode = args.includes('--branch') ? 'branch' : 'worktree';
  console.log(createExampleRepo(name, dest, { mode }));
}
