import type {
  ChangedFunction,
  FileDiff,
  FunctionInfo,
  LineRange,
  SourceLanguage,
} from '../types.js';

export interface FileVersions {
  file: FileDiff;
  language: SourceLanguage;
  /** Functions in the base version; empty for added files. */
  oldFunctions: FunctionInfo[];
  /** Functions in the head version; empty for deleted files. */
  newFunctions: FunctionInfo[];
}

/**
 * For each changed line, the innermost function containing it. Innermost so a
 * one-line fix in a nested helper is not also reported against its parent.
 */
function touched(functions: FunctionInfo[], ranges: LineRange[]): Set<string> {
  const hit = new Set<string>();
  if (functions.length === 0) return hit;
  for (const range of ranges) {
    for (let line = range.start; line <= range.end; line++) {
      let best: FunctionInfo | undefined;
      for (const fn of functions) {
        if (line < fn.range.start || line > fn.range.end) continue;
        if (!best || fn.range.end - fn.range.start < best.range.end - best.range.start) best = fn;
      }
      if (best) hit.add(best.qualifiedName);
    }
  }
  return hit;
}

function build(
  versions: FileVersions,
  status: ChangedFunction['status'],
  oldFn: FunctionInfo | undefined,
  newFn: FunctionInfo | undefined,
): ChangedFunction {
  const { file, language } = versions;
  const current = (newFn ?? oldFn)!;
  const path = (file.newPath ?? file.oldPath)!;
  return {
    file: path,
    oldFile: file.oldPath && file.oldPath !== path ? file.oldPath : null,
    language,
    name: current.name,
    qualifiedName: current.qualifiedName,
    kind: current.kind,
    status,
    exported: current.exported,
    async: current.async,
    params: current.params,
    signature: current.signature,
    oldSource: oldFn?.source ?? null,
    newSource: newFn?.source ?? null,
    oldRange: oldFn?.range ?? null,
    newRange: newFn?.range ?? null,
  };
}

/** Work out which functions a file diff added, modified or deleted. */
export function changedFunctions(versions: FileVersions): ChangedFunction[] {
  const { file, oldFunctions, newFunctions } = versions;
  const oldByName = new Map(oldFunctions.map((fn) => [fn.qualifiedName, fn]));
  const newByName = new Map(newFunctions.map((fn) => [fn.qualifiedName, fn]));

  if (file.status === 'added')
    return newFunctions.map((fn) => build(versions, 'added', undefined, fn));
  if (file.status === 'deleted')
    return oldFunctions.map((fn) => build(versions, 'deleted', fn, undefined));

  const results = new Map<string, ChangedFunction>();
  for (const name of touched(newFunctions, file.addedRanges)) {
    const oldFn = oldByName.get(name);
    results.set(name, build(versions, oldFn ? 'modified' : 'added', oldFn, newByName.get(name)));
  }
  for (const name of touched(oldFunctions, file.removedRanges)) {
    if (results.has(name)) continue;
    const newFn = newByName.get(name);
    results.set(name, build(versions, newFn ? 'modified' : 'deleted', oldByName.get(name), newFn));
  }

  // A hunk can touch a function without changing it (e.g. only a blank line
  // between two functions moved). Drop those.
  return [...results.values()]
    .filter((fn) => fn.status !== 'modified' || fn.oldSource !== fn.newSource)
    .sort(
      (a, b) => (a.newRange?.start ?? a.oldRange!.start) - (b.newRange?.start ?? b.oldRange!.start),
    );
}
