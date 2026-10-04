import { readdir, readFile } from 'node:fs/promises';
import { posix } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.wcp',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.pytest_cache',
  'wcp_generated',
]);

const JS_TEST = /(^|\/)__tests__\/.*\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;

export const isJsTestFile = (path: string) => JS_TEST.test(path);
export const isPyTestFile = (path: string) => PY_TEST.test(path);

/** Every file under `root`, as posix paths relative to it, skipping deps and build output. */
export async function listFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(posix.join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await listFiles(root, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

const JS_SPECIFIERS =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const JS_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
// TypeScript ESM code imports "./x.js" for a file named x.ts.
const TS_FOR_JS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};

/** Repo-relative files a JS/TS file could be importing, for relative specifiers only. */
export function jsImportCandidates(fromFile: string, source: string): string[] {
  const candidates: string[] = [];
  for (const match of source.matchAll(JS_SPECIFIERS)) {
    const spec = match[1]!;
    if (!spec.startsWith('.')) continue;
    const target = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    const ext = posix.extname(target);
    for (const e of JS_EXTENSIONS) candidates.push(target + e);
    for (const e of JS_EXTENSIONS.slice(1)) candidates.push(`${target}/index${e}`);
    for (const swap of TS_FOR_JS[ext] ?? []) candidates.push(target.slice(0, -ext.length) + swap);
  }
  return candidates;
}

const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([^)#\n]+)/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

function pyModulePaths(module: string): string[] {
  const base = module.replace(/\./g, '/');
  return ['', 'src/'].flatMap((prefix) => [`${prefix}${base}.py`, `${prefix}${base}/__init__.py`]);
}

/** Repo-relative files a Python file could be importing. */
export function pyImportCandidates(fromFile: string, source: string): string[] {
  const modules: string[] = [];
  const pkg = posix.dirname(fromFile);
  for (const match of source.matchAll(PY_FROM)) {
    let module = match[1]!;
    const names = match[2]!
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0]!)
      .filter(Boolean);
    const dots = /^\.*/.exec(module)![0].length;
    if (dots > 0) {
      let dir = pkg;
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      const rest = module.slice(dots);
      module = [dir === '.' ? '' : dir.replace(/\//g, '.'), rest].filter(Boolean).join('.');
    }
    modules.push(module, ...names.map((n) => (module ? `${module}.${n}` : n)));
  }
  for (const match of source.matchAll(PY_IMPORT)) {
    modules.push(...match[1]!.split(',').map((m) => m.trim()));
  }
  return modules.filter(Boolean).flatMap(pyModulePaths);
}

/** Test files (repo-relative) in `root` that import any of `targets`. */
export async function testsImporting(
  root: string,
  testFiles: string[],
  targets: Set<string>,
): Promise<string[]> {
  const hits: string[] = [];
  for (const file of testFiles) {
    const source = await readFile(posix.join(root, file), 'utf8').catch(() => '');
    const candidates = file.endsWith('.py')
      ? pyImportCandidates(file, source)
      : jsImportCandidates(file, source);
    if (candidates.some((c) => targets.has(c))) hits.push(file);
  }
  return hits;
}
