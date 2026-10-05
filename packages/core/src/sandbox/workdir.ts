import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SandboxError } from './errors.js';

/** Create a fresh, empty folder for one run under `root`. */
export async function createWorkdir(root: string, label: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const safeLabel = label.replace(/[^\w-]/g, '_').slice(0, 40);
  return realpath(await mkdtemp(join(root, `run-${safeLabel}-`)));
}

/**
 * Throw unless `dir` is strictly inside `root`. Sandboxes may only ever see a
 * run's own temp folder — never the root itself, a home folder or a project.
 */
export async function assertInsideRoot(root: string, dir: string): Promise<string> {
  let realDir: string;
  let realRoot: string;
  try {
    [realDir, realRoot] = await Promise.all([realpath(resolve(dir)), realpath(resolve(root))]);
  } catch (cause) {
    throw new SandboxError(`Sandbox workdir ${dir} does not exist`, { cause });
  }
  const rel = relative(realRoot, realDir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new SandboxError(`Refusing to mount ${dir}: it is not inside ${root}`);
  }
  return realDir;
}

/**
 * Remove folders under `root` last changed more than `olderThanMs` ago:
 * run folders or clones left behind by a crashed process.
 */
export async function removeStaleFolders(root: string, olderThanMs: number): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    removed++;
  }
  return removed;
}

export async function removeWorkdir(root: string, dir: string): Promise<void> {
  const safe = await assertInsideRoot(root, dir).catch(() => null);
  if (safe) await rm(safe, { recursive: true, force: true, maxRetries: 3 });
}
