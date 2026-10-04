import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from '../diff/git.js';
import type { ChangeSet } from '../types.js';

/**
 * Write the files of `commit` into `dest`, exactly as stored in the repo.
 * Uses a throwaway index file, so the repository's own index, worktree list
 * and working tree are never touched.
 */
export async function exportCommit(
  repoRoot: string,
  commit: string,
  dest: string,
  scratchDir: string,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  const indexFile = join(scratchDir, `index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  // No line-ending conversion: tests should see the bytes CI would see.
  const noConvert = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
  try {
    await git(repoRoot, [...noConvert, 'read-tree', commit], { env });
    const prefix = `${dest.replace(/\\/g, '/').replace(/\/?$/, '/')}`;
    await git(
      repoRoot,
      [...noConvert, 'checkout-index', '--all', '--force', `--prefix=${prefix}`],
      {
        env,
      },
    );
  } finally {
    await rm(indexFile, { force: true });
  }
}

/**
 * Head = working tree: start from the base export and apply every changed
 * file from the working tree (uncommitted and untracked included).
 */
export async function applyWorkingTree(changes: ChangeSet, dest: string): Promise<void> {
  for (const file of changes.files) {
    if (file.oldPath && file.oldPath !== file.newPath) {
      await rm(join(dest, file.oldPath), { force: true });
    }
    if (!file.newPath) continue;
    const source = join(changes.repoRoot, file.newPath);
    const stat = await lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    await mkdir(dirname(join(dest, file.newPath)), { recursive: true });
    await copyFile(source, join(dest, file.newPath));
  }
}
