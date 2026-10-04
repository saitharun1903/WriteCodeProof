import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type JsTestRunner = 'vitest' | 'jest';

export interface NodeProject {
  /** Lockfile npm can install from exactly, if any. */
  lockfile: 'package-lock.json' | 'npm-shrinkwrap.json' | null;
  /** Non-npm lockfile present (installed with npm install instead, best effort). */
  foreignLockfile: 'yarn.lock' | 'pnpm-lock.yaml' | 'bun.lockb' | null;
  testRunner: JsTestRunner | null;
  /** True when package.json has `"type": "module"`. */
  esm: boolean;
  /** Files whose contents decide the installed dependencies. */
  manifests: string[];
}

export interface PythonProject {
  manifests: string[];
  /** `src/` layout: packages live under src/. */
  srcLayout: boolean;
}

export interface Projects {
  node: NodeProject | null;
  python: PythonProject | null;
}

const PYTHON_MANIFESTS = [
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
  'requirements.txt',
  'requirements-dev.txt',
  'requirements-test.txt',
  'dev-requirements.txt',
  'test-requirements.txt',
];

const first = <T extends string>(dir: string, names: readonly T[]): T | null =>
  names.find((name) => existsSync(join(dir, name))) ?? null;

async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectRunner(pkg: Record<string, unknown>): JsTestRunner | null {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  if ('vitest' in deps) return 'vitest';
  if ('jest' in deps) return 'jest';
  const script = String((pkg.scripts as Record<string, string> | undefined)?.test ?? '');
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  return null;
}

/**
 * What kind of project lives in `dir`. `wantPython` forces Python detection
 * for repos with .py files but no manifest.
 */
export async function detectProjects(dir: string, wantPython = false): Promise<Projects> {
  const pkg = await readPackageJson(dir);
  const lockfile = first(dir, ['package-lock.json', 'npm-shrinkwrap.json'] as const);
  const node: NodeProject | null = pkg
    ? {
        lockfile,
        foreignLockfile: lockfile
          ? null
          : first(dir, ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'] as const),
        testRunner: detectRunner(pkg),
        esm: pkg.type === 'module',
        manifests: ['package.json', ...(lockfile ? [lockfile] : [])],
      }
    : null;

  const pyManifests = PYTHON_MANIFESTS.filter((name) => existsSync(join(dir, name)));
  const python: PythonProject | null =
    pyManifests.length || wantPython
      ? { manifests: pyManifests, srcLayout: existsSync(join(dir, 'src')) }
      : null;

  return { node, python };
}
