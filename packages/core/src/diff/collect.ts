import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { ANALYSIS_DEFAULTS } from '../config/defaults.js';
import { extractFunctions } from '../parse/functions.js';
import { detectLanguage } from '../parse/languages.js';
import type {
  ChangeSet,
  ChangedFunction,
  FileDiff,
  FunctionInfo,
  ParseWarning,
  SkippedFile,
} from '../types.js';
import { changedFunctions } from './changedFunctions.js';
import {
  mergeBase,
  readBlob,
  repoRoot,
  resolveCommit,
  unifiedDiff,
  untrackedFiles,
  type GitOptions,
} from './git.js';
import { parseUnifiedDiff } from './unifiedDiff.js';

export interface CollectOptions {
  /** Any path inside the repository. */
  repoPath: string;
  /** Branch, tag or commit to compare against. */
  base?: string;
  /** Branch, tag or commit to check. Omit to use the working tree, including uncommitted changes. */
  head?: string;
  /** Extra globs to skip, on top of the defaults. */
  ignore?: readonly string[];
  /** Replace the default ignore globs instead of adding to them. */
  replaceDefaultIgnore?: boolean;
  maxFileBytes?: number;
  gitMaxBufferBytes?: number;
}

const SUBMODULE_MODE = '160000';
const SYMLINK_MODE = '120000';
// Same heuristic git uses: a NUL byte in the first 8000 bytes means binary.
const BINARY_SNIFF_BYTES = 8000;

const isBinary = (buf: Buffer) => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
const toText = (buf: Buffer) => buf.toString('utf8').replace(/\r\n/g, '\n');

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 0x0a) lines++;
  return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
}

async function readWorkingFile(root: string, path: string): Promise<Buffer | null> {
  try {
    return await readFile(join(root, path));
  } catch {
    return null;
  }
}

async function untrackedEntries(
  root: string,
  isIgnored: (path: string) => boolean,
): Promise<FileDiff[]> {
  const entries: FileDiff[] = [];
  for (const path of await untrackedFiles(root)) {
    const stat = await lstat(join(root, path)).catch(() => null);
    if (!stat?.isFile()) continue;
    // Listed so it shows up as skipped, but not worth reading.
    const content = isIgnored(path) ? null : await readWorkingFile(root, path);
    const lines = content && !isBinary(content) ? countLines(content) : 0;
    entries.push({
      oldPath: null,
      newPath: path,
      status: 'added',
      binary: content ? isBinary(content) : false,
      mode: null,
      additions: lines,
      deletions: 0,
      removedRanges: [],
      addedRanges: lines > 0 ? [{ start: 1, end: lines }] : [],
    });
  }
  return entries;
}

/**
 * Diff `head` (or the working tree) against the merge-base with `base`, and
 * list every function that was added, modified or deleted.
 */
export async function collectChanges(options: CollectOptions): Promise<ChangeSet> {
  const baseRef = options.base ?? ANALYSIS_DEFAULTS.BASE_REF;
  const headRef = options.head ?? null;
  const maxFileBytes = options.maxFileBytes ?? ANALYSIS_DEFAULTS.MAX_FILE_BYTES;
  const gitOptions: GitOptions = {
    maxBuffer: options.gitMaxBufferBytes ?? ANALYSIS_DEFAULTS.GIT_MAX_BUFFER_BYTES,
  };
  const ignoreGlobs = [
    ...(options.replaceDefaultIgnore ? [] : ANALYSIS_DEFAULTS.IGNORE),
    ...(options.ignore ?? []),
  ];
  const isIgnored = ignoreGlobs.length
    ? picomatch(ignoreGlobs, { dot: true, windows: false })
    : () => false;

  const root = await repoRoot(options.repoPath);
  const baseCommit = await resolveCommit(root, baseRef);
  const headSha = headRef ? await resolveCommit(root, headRef) : null;
  const baseSha = await mergeBase(root, baseCommit, headSha ?? (await resolveCommit(root, 'HEAD')));

  const files = parseUnifiedDiff(await unifiedDiff(root, baseSha, headSha, gitOptions));
  if (!headSha) files.push(...(await untrackedEntries(root, isIgnored)));

  const readOld = (path: string) => readBlob(root, baseSha, path, gitOptions);
  const readNew = (path: string) =>
    headSha ? readBlob(root, headSha, path, gitOptions) : readWorkingFile(root, path);

  const skippedFiles: SkippedFile[] = [];
  const parseWarnings: ParseWarning[] = [];
  const changed: ChangedFunction[] = [];
  const counted: FileDiff[] = [];

  const parseSide = async (
    path: string | null,
    side: 'base' | 'head',
  ): Promise<FunctionInfo[] | 'binary' | 'too-large'> => {
    const language = path ? detectLanguage(path) : null;
    if (!path || !language) return [];
    const content = side === 'base' ? await readOld(path) : await readNew(path);
    if (!content) return [];
    if (content.length > maxFileBytes) return 'too-large';
    if (isBinary(content)) return 'binary';
    const { functions, hasSyntaxErrors } = await extractFunctions(language, toText(content));
    if (hasSyntaxErrors) {
      parseWarnings.push({ path, side, message: 'syntax errors; results may be incomplete' });
    }
    return functions;
  };

  for (const file of files) {
    const path = (file.newPath ?? file.oldPath)!;
    const anyPath = [file.newPath, file.oldPath].filter((p): p is string => p !== null);

    if (anyPath.some((p) => isIgnored(p))) {
      skippedFiles.push({ path, reason: 'ignored' });
      continue;
    }
    counted.push(file);
    if (file.mode === SUBMODULE_MODE) {
      skippedFiles.push({ path, reason: 'submodule' });
      continue;
    }
    if (file.mode === SYMLINK_MODE) {
      skippedFiles.push({ path, reason: 'symlink' });
      continue;
    }
    if (file.binary) {
      skippedFiles.push({ path, reason: 'binary' });
      continue;
    }
    // Judge by the head side; for deletions, the base side.
    const language = detectLanguage(path);
    if (!language) {
      skippedFiles.push({ path, reason: 'unsupported-language' });
      continue;
    }

    const oldFunctions = await parseSide(file.oldPath, 'base');
    const newFunctions = await parseSide(file.newPath, 'head');
    if (typeof oldFunctions === 'string' || typeof newFunctions === 'string') {
      const reason =
        oldFunctions === 'binary' || newFunctions === 'binary' ? 'binary' : 'too-large';
      skippedFiles.push({ path, reason });
      continue;
    }
    changed.push(...changedFunctions({ file, language, oldFunctions, newFunctions }));
  }

  return {
    repoRoot: root,
    baseRef,
    baseSha,
    headRef,
    headSha,
    files,
    changedFunctions: changed,
    skippedFiles,
    parseWarnings,
    stats: {
      filesChanged: files.length,
      additions: counted.reduce((sum, f) => sum + f.additions, 0),
      deletions: counted.reduce((sum, f) => sum + f.deletions, 0),
    },
  };
}
