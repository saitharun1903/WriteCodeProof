import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectChanges, GitError, type ChangeSet } from '@writecode-proof/core';
import { createExampleRepo, PR_BRANCH } from '../scripts/example-repo.mjs';

const workdir = mkdtempSync(join(tmpdir(), 'wcp-changes-'));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const list = (changes: ChangeSet) =>
  changes.changedFunctions.map((f) => `${f.status} ${f.file}:${f.qualifiedName}`);

const EXPECTED = {
  'js-sample': [
    'modified src/cart.js:roundMoney',
    'modified src/cart.js:cheapestItem',
    'added src/cart.js:totalWithTax',
    'deleted src/cart.js:legacyTotal',
    'modified src/cart.js:Cart.add',
  ],
  'py-sample': [
    'modified shop/cart.py:round_money',
    'modified shop/cart.py:cheapest_item',
    'deleted shop/cart.py:_legacy_total',
    'added shop/cart.py:total_with_tax',
    'modified shop/cart.py:Cart.add',
  ],
} as const;

describe.each(Object.entries(EXPECTED))('examples/%s', (name, expected) => {
  it('lists changed functions in the working tree against main', async () => {
    const repo = createExampleRepo(name, join(workdir, `${name}-wt`));
    const changes = await collectChanges({ repoPath: repo });
    expect(list(changes)).toEqual(expected);
    expect(changes.headSha).toBeNull();
    expect(changes.parseWarnings).toEqual([]);
  });

  it('lists the same functions for a committed branch', async () => {
    const repo = createExampleRepo(name, join(workdir, `${name}-br`), { mode: 'branch' });
    const changes = await collectChanges({ repoPath: repo, base: 'main', head: PR_BRANCH });
    expect(list(changes)).toEqual(expected);
    expect(changes.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('keeps old and new source for modified functions', async () => {
    const repo = createExampleRepo(name, join(workdir, `${name}-src`));
    const changes = await collectChanges({ repoPath: repo });
    const modified = changes.changedFunctions.find((f) => f.status === 'modified')!;
    expect(modified.oldSource).toBeTruthy();
    expect(modified.newSource).toBeTruthy();
    expect(modified.oldSource).not.toBe(modified.newSource);
    expect(modified.newSource).not.toContain('\r');
  });
});

describe('collectChanges on a scratch repo', () => {
  function git(cwd: string, ...args: string[]) {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
  }

  function scratchRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(workdir, 'scratch-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
  }

  it('includes untracked files and skips ignored and unsupported ones', async () => {
    const repo = scratchRepo({ 'src/a.js': 'export function a() { return 1; }\n' });
    writeFileSync(join(repo, 'src/new.ts'), 'export const n = (x: number) => x * 2;\n');
    writeFileSync(join(repo, 'src/a.test.js'), 'test("x", () => {});\n');
    writeFileSync(join(repo, 'notes.txt'), 'hello\n');
    writeFileSync(join(repo, 'README.md'), '# hi\n');

    const changes = await collectChanges({ repoPath: join(repo, 'src') });
    expect(list(changes)).toEqual(['added src/new.ts:n']);
    expect(changes.skippedFiles).toEqual(
      expect.arrayContaining([
        { path: 'src/a.test.js', reason: 'ignored' },
        { path: 'README.md', reason: 'ignored' },
        { path: 'notes.txt', reason: 'unsupported-language' },
      ]),
    );
    // new.ts + notes.txt; the ignored test file and README are not counted
    expect(changes.stats.additions).toBe(2);
  });

  it('honours extra ignore globs', async () => {
    const repo = scratchRepo({ 'gen/x.js': 'function x() { return 1; }\n' });
    writeFileSync(join(repo, 'gen/x.js'), 'function x() { return 2; }\n');
    const changes = await collectChanges({ repoPath: repo, ignore: ['gen/**'] });
    expect(changes.changedFunctions).toEqual([]);
    expect(changes.skippedFiles).toEqual([{ path: 'gen/x.js', reason: 'ignored' }]);
  });

  it('follows a rename from .js to .ts', async () => {
    const body =
      'export function keep(a) {\n  return a + 1;\n}\nexport function edit(a) {\n  return a;\n}\n';
    const repo = scratchRepo({ 'lib/util.js': body });
    git(repo, 'mv', 'lib/util.js', 'lib/util.ts');
    writeFileSync(join(repo, 'lib/util.ts'), body.replace('return a;', 'return a * 2;'));
    const changes = await collectChanges({ repoPath: repo });
    expect(list(changes)).toEqual(['modified lib/util.ts:edit']);
    expect(changes.changedFunctions[0]!.oldFile).toBe('lib/util.js');
  });

  it('compares against the merge-base, not the tip of main', async () => {
    const repo = scratchRepo({ 'a.py': 'def a():\n    return 1\n\n\ndef b():\n    return 1\n' });
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'a.py'), 'def a():\n    return 2\n\n\ndef b():\n    return 1\n');
    git(repo, 'commit', '-q', '-am', 'change a');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'a.py'), 'def a():\n    return 1\n\n\ndef b():\n    return 9\n');
    git(repo, 'commit', '-q', '-am', 'change b on main');

    const changes = await collectChanges({ repoPath: repo, base: 'main', head: 'feature' });
    expect(list(changes)).toEqual(['modified a.py:a']);
  });

  it('gives clear errors for bad input', async () => {
    const repo = scratchRepo({ 'a.js': 'function a() {}\n' });
    await expect(collectChanges({ repoPath: repo, base: 'nope' })).rejects.toThrow(
      /Cannot find "nope"/,
    );
    const notRepo = mkdtempSync(join(tmpdir(), 'wcp-norepo-'));
    try {
      await expect(collectChanges({ repoPath: notRepo })).rejects.toBeInstanceOf(GitError);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
