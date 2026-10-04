import { describe, expect, it } from 'vitest';
import { changedFunctions, extractFunctions, type FileDiff, type LineRange } from '../src/index.js';

function fileDiff(partial: Partial<FileDiff>): FileDiff {
  return {
    oldPath: 'm.js',
    newPath: 'm.js',
    status: 'modified',
    binary: false,
    mode: '100644',
    additions: 0,
    deletions: 0,
    removedRanges: [],
    addedRanges: [],
    ...partial,
  };
}

async function run(oldSrc: string, newSrc: string, removed: LineRange[], added: LineRange[]) {
  const oldFunctions = (await extractFunctions('javascript', oldSrc)).functions;
  const newFunctions = (await extractFunctions('javascript', newSrc)).functions;
  return changedFunctions({
    file: fileDiff({ removedRanges: removed, addedRanges: added }),
    language: 'javascript',
    oldFunctions,
    newFunctions,
  }).map((f) => `${f.status} ${f.qualifiedName}`);
}

describe('changedFunctions', () => {
  it('maps an edited line to its function', async () => {
    const oldSrc = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n';
    const newSrc = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 3;\n}\n';
    expect(await run(oldSrc, newSrc, [{ start: 5, end: 5 }], [{ start: 5, end: 5 }])).toEqual([
      'modified b',
    ]);
  });

  it('reports only the innermost function', async () => {
    const oldSrc =
      'function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner;\n}\n';
    const newSrc =
      'function outer() {\n  function inner() {\n    return 2;\n  }\n  return inner;\n}\n';
    expect(await run(oldSrc, newSrc, [{ start: 3, end: 3 }], [{ start: 3, end: 3 }])).toEqual([
      'modified outer.inner',
    ]);
  });

  it('treats a pure deletion inside a function as a modification', async () => {
    const oldSrc = 'function a() {\n  log();\n  return 1;\n}\n';
    const newSrc = 'function a() {\n  return 1;\n}\n';
    expect(await run(oldSrc, newSrc, [{ start: 2, end: 2 }], [])).toEqual(['modified a']);
  });

  it('detects added and deleted functions', async () => {
    const oldSrc = 'function keep() {}\nfunction gone() {}\n';
    const newSrc = 'function keep() {}\nfunction fresh() {}\n';
    expect(await run(oldSrc, newSrc, [{ start: 2, end: 2 }], [{ start: 2, end: 2 }])).toEqual([
      'added fresh',
      'deleted gone',
    ]);
  });

  it('ignores changes outside any function', async () => {
    const oldSrc = 'const x = 1;\nfunction a() {}\n';
    const newSrc = 'const x = 2;\nfunction a() {}\n';
    expect(await run(oldSrc, newSrc, [{ start: 1, end: 1 }], [{ start: 1, end: 1 }])).toEqual([]);
  });

  it('marks everything added or deleted for whole-file changes', async () => {
    const { functions } = await extractFunctions('javascript', 'function a() {}\nfunction b() {}');
    const added = changedFunctions({
      file: fileDiff({ oldPath: null, status: 'added' }),
      language: 'javascript',
      oldFunctions: [],
      newFunctions: functions,
    });
    expect(added.map((f) => `${f.status} ${f.name}`)).toEqual(['added a', 'added b']);

    const deleted = changedFunctions({
      file: fileDiff({ newPath: null, status: 'deleted' }),
      language: 'javascript',
      oldFunctions: functions,
      newFunctions: [],
    });
    expect(deleted.map((f) => `${f.status} ${f.name}`)).toEqual(['deleted a', 'deleted b']);
    expect(deleted[0]!.file).toBe('m.js');
  });
});
