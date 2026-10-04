export type SourceLanguage = 'javascript' | 'typescript' | 'tsx' | 'python';

/** 1-based, inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One file's entry from `git diff --unified=0`. */
export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  /** Git file mode on the new side (or old side for deletions), e.g. `100644`. */
  mode: string | null;
  additions: number;
  deletions: number;
  /** Lines removed, numbered on the old side. */
  removedRanges: LineRange[];
  /** Lines added, numbered on the new side. */
  addedRanges: LineRange[];
}

export type FunctionKind = 'function' | 'method';

export interface FunctionInfo {
  name: string;
  /** Dotted path including enclosing classes/functions, e.g. `Cart.add`. Unique per file. */
  qualifiedName: string;
  kind: FunctionKind;
  /** Importable from outside the module (ES/CommonJS export, or public top-level Python name). */
  exported: boolean;
  async: boolean;
  params: string[];
  /** Header text up to the body, whitespace collapsed. */
  signature: string;
  /** Full source text of the function, LF line endings. */
  source: string;
  range: LineRange;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface ChangedFunction {
  /** Path on the head side; the old path for deleted files. */
  file: string;
  /** Path on the base side when it differs from `file` (renames). */
  oldFile: string | null;
  language: SourceLanguage;
  name: string;
  qualifiedName: string;
  kind: FunctionKind;
  status: ChangeStatus;
  exported: boolean;
  async: boolean;
  params: string[];
  signature: string;
  oldSource: string | null;
  newSource: string | null;
  oldRange: LineRange | null;
  newRange: LineRange | null;
}

export type SkipReason =
  'ignored' | 'unsupported-language' | 'binary' | 'too-large' | 'submodule' | 'symlink';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface ParseWarning {
  path: string;
  side: 'base' | 'head';
  message: string;
}

export interface ChangeSet {
  repoRoot: string;
  baseRef: string;
  /** Merge-base of the base ref and head; what the diff is taken against. */
  baseSha: string;
  /** `null` when head is the working tree. */
  headRef: string | null;
  headSha: string | null;
  files: FileDiff[];
  changedFunctions: ChangedFunction[];
  skippedFiles: SkippedFile[];
  parseWarnings: ParseWarning[];
  /** Line counts leave out ignored files (lockfiles, docs, tests) so they don't skew diff size. */
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}
