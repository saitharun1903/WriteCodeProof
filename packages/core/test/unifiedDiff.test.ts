import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, unquoteGitPath } from '../src/index.js';

describe('parseUnifiedDiff', () => {
  it('reads a modified file with several hunks', () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git a/src/cart.js b/src/cart.js',
        'index 1111111..2222222 100644',
        '--- a/src/cart.js',
        '+++ b/src/cart.js',
        '@@ -2 +2 @@ export function roundMoney(amount) {',
        '-  return Math.round(amount * 100) / 100;',
        '+  return Math.trunc(amount * 100) / 100;',
        '@@ -17,0 +18,3 @@',
        '+a',
        '+b',
        '+c',
        '@@ -30,2 +32,0 @@',
        '-x',
        '-y',
      ].join('\n'),
    );
    expect(file).toMatchObject({
      oldPath: 'src/cart.js',
      newPath: 'src/cart.js',
      status: 'modified',
      mode: '100644',
      additions: 4,
      deletions: 3,
      removedRanges: [
        { start: 2, end: 2 },
        { start: 30, end: 31 },
      ],
      addedRanges: [
        { start: 2, end: 2 },
        { start: 18, end: 20 },
      ],
    });
  });

  it('reads added and deleted files', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/new.py b/new.py',
        'new file mode 100644',
        'index 0000000..1234567',
        '--- /dev/null',
        '+++ b/new.py',
        '@@ -0,0 +1,2 @@',
        '+def f():',
        '+    pass',
        'diff --git a/old.py b/old.py',
        'deleted file mode 100644',
        'index 1234567..0000000',
        '--- a/old.py',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-x = 1',
      ].join('\n'),
    );
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ oldPath: null, newPath: 'new.py', status: 'added' });
    expect(files[1]).toMatchObject({ oldPath: 'old.py', newPath: null, status: 'deleted' });
  });

  it('reads renames with and without content changes', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/a.js b/b.js',
        'similarity index 100%',
        'rename from a.js',
        'rename to b.js',
        'diff --git a/c.js b/lib/c.ts',
        'similarity index 80%',
        'rename from c.js',
        'rename to lib/c.ts',
        'index 1..2 100644',
        '--- a/c.js',
        '+++ b/lib/c.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
    );
    expect(files[0]).toMatchObject({ oldPath: 'a.js', newPath: 'b.js', status: 'renamed' });
    expect(files[1]).toMatchObject({ oldPath: 'c.js', newPath: 'lib/c.ts', status: 'renamed' });
    expect(files[1]!.addedRanges).toEqual([{ start: 1, end: 1 }]);
  });

  it('flags binary files and mode-only changes', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/logo.png b/logo.png',
        'index 1..2 100644',
        'Binary files a/logo.png and b/logo.png differ',
        'diff --git a/run.py b/run.py',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
    );
    expect(files[0]).toMatchObject({ newPath: 'logo.png', binary: true });
    expect(files[1]).toMatchObject({ oldPath: 'run.py', newPath: 'run.py', mode: '100755' });
    expect(files[1]!.addedRanges).toEqual([]);
  });

  it('handles quoted paths and paths with spaces', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git "a/caf\\303\\251 \\"x\\".js" "b/caf\\303\\251 \\"x\\".js"',
        '--- "a/caf\\303\\251 \\"x\\".js"',
        '+++ "b/caf\\303\\251 \\"x\\".js"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/my file.js b/my file.js',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
    );
    expect(files[0]!.newPath).toBe('café "x".js');
    expect(files[1]!.newPath).toBe('my file.js');
  });

  it('does not mistake hunk lines for headers', () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git a/x.js b/x.js',
        '--- a/x.js',
        '+++ b/x.js',
        '@@ -1,2 +1,2 @@',
        '--- a/not-a-header',
        '+++ b/not-a-header',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(file!.oldPath).toBe('x.js');
    expect(file!.newPath).toBe('x.js');
  });
});

describe('unquoteGitPath', () => {
  it('leaves unquoted paths alone', () => {
    expect(unquoteGitPath('src/a.js')).toBe('src/a.js');
  });

  it('decodes escapes', () => {
    expect(unquoteGitPath('"tab\\there"')).toBe('tab\there');
  });
});
