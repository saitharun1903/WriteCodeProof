import type { FileDiff, LineRange } from '../types.js';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/**
 * Undo git's C-style path quoting (`"dir/caf\303\251.js"`). Octal escapes are
 * raw UTF-8 bytes, so decode through a byte buffer.
 */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = inner[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      const octal = inner.slice(i + 1, i + 4);
      bytes.push(parseInt(octal, 8));
      i += octal.length;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string | null {
  if (path === '/dev/null') return null;
  const unquoted = unquoteGitPath(path.replace(/\t$/, ''));
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

/** `diff --git a/X b/X` — only reliable when both sides are the same path. */
function pathFromGitHeader(rest: string): string | null {
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") /.exec(rest);
    return match ? stripPrefix(match[1]!, 'a/') : null;
  }
  if ((rest.length - 5) % 2 !== 0) return null;
  const half = (rest.length - 5) / 2;
  const a = rest.slice(2, 2 + half);
  const b = rest.slice(5 + half);
  return rest.startsWith('a/') && rest.slice(2 + half, 5 + half) === ' b/' && a === b ? a : null;
}

function addRange(ranges: LineRange[], start: number, count: number): void {
  if (count > 0) ranges.push({ start, end: start + count - 1 });
}

function newEntry(): FileDiff {
  return {
    oldPath: null,
    newPath: null,
    status: 'modified',
    binary: false,
    mode: null,
    additions: 0,
    deletions: 0,
    removedRanges: [],
    addedRanges: [],
  };
}

/**
 * Parse `git diff --unified=0 --src-prefix=a/ --dst-prefix=b/` output.
 * Hunk bodies are skipped; only their line ranges matter.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let headerPath: string | null = null;
  let inHunk = false;

  const finish = () => {
    if (!current) return;
    current.oldPath ??= current.status === 'added' ? null : headerPath;
    current.newPath ??= current.status === 'deleted' ? null : headerPath;
    files.push(current);
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      current = newEntry();
      headerPath = pathFromGitHeader(line.slice('diff --git '.length).replace(/\r$/, ''));
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (inHunk) {
      const ch = line[0];
      if (ch === '+' || ch === '-' || ch === ' ' || ch === '\\') continue;
      inHunk = false;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      addRange(current.removedRanges, oldStart, oldCount);
      addRange(current.addedRanges, newStart, newCount);
      current.deletions += oldCount;
      current.additions += newCount;
      inHunk = true;
    } else if (line.startsWith('--- ')) {
      current.oldPath = stripPrefix(line.slice(4), 'a/');
    } else if (line.startsWith('+++ ')) {
      current.newPath = stripPrefix(line.slice(4), 'b/');
    } else if (line.startsWith('new file mode ')) {
      current.status = 'added';
      current.mode = line.slice('new file mode '.length).trim();
    } else if (line.startsWith('deleted file mode ')) {
      current.status = 'deleted';
      current.mode = line.slice('deleted file mode '.length).trim();
    } else if (line.startsWith('new mode ')) {
      current.mode = line.slice('new mode '.length).trim();
    } else if (line.startsWith('index ')) {
      const mode = line.split(' ')[2];
      if (mode) current.mode = mode.trim();
    } else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = unquoteGitPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      current.status = 'renamed';
      current.newPath = unquoteGitPath(line.slice('rename to '.length));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.binary = true;
    }
  }
  finish();
  return files;
}
