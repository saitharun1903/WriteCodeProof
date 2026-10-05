import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunBudget } from '../sandbox/budget.js';
import type { Sandbox, StepResult } from '../sandbox/runner.js';
import { VOLUME_PREFIX, WORK_DIR, SANDBOX_LABEL, type VolumeMount } from '../sandbox/spec.js';
import { createWorkdir, removeWorkdir } from '../sandbox/workdir.js';
import type { ChangeSet } from '../types.js';
import { applyWorkingTree, exportCommit } from './checkout.js';
import { detectProjects, type Projects } from './project.js';

export type Side = 'base' | 'head';
export type Toolchain = 'node' | 'python' | 'tools';

/** Scratch folder for harness files and reports, next to base/ and head/. */
export const SCRATCH = '.wcp';
const DEPS_MOUNT = '/deps';
const READY_MARKER = `${DEPS_MOUNT}/.wcp-ready`;
const PY_SITE = `${DEPS_MOUNT}/site-packages`;

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'harness');

export interface DepsState {
  volume: string;
  ok: boolean;
  cached: boolean;
  /** Tail of the install log when it failed. */
  message?: string;
}

export interface StepExtra {
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Container path; defaults to the side's root. */
  cwd?: string;
}

const tail = (text: string, chars = 1500) => (text.length > chars ? text.slice(-chars) : text);

export class RunContext {
  readonly deps: Record<Side, Partial<Record<'node' | 'python', DepsState>>> = {
    base: {},
    head: {},
  };
  readonly notes: string[] = [];

  constructor(
    readonly runId: string,
    readonly changes: ChangeSet,
    readonly sandbox: Sandbox,
    readonly budget: RunBudget,
    readonly workdir: string,
    readonly projects: Record<Side, Projects>,
  ) {}

  hostPath(side: Side | typeof SCRATCH, ...parts: string[]): string {
    return join(this.workdir, side, ...parts);
  }

  containerPath(side: Side | typeof SCRATCH, ...parts: string[]): string {
    return [WORK_DIR, side, ...parts].join('/');
  }

  /** Environment so code under /work/<side> finds its dependencies and its own packages. */
  env(side: Side, toolchain: Toolchain): Record<string, string> {
    if (toolchain !== 'python') return {};
    const root = this.containerPath(side);
    const paths = [PY_SITE, root];
    if (this.projects[side].python?.srcLayout) paths.push(`${root}/src`);
    return { PYTHONPATH: paths.join(':') };
  }

  volumes(side: Side, toolchain: Toolchain): VolumeMount[] {
    if (toolchain === 'tools') return [];
    const state = this.deps[side][toolchain];
    return state ? [{ name: state.volume, target: DEPS_MOUNT }] : [];
  }

  image(toolchain: Toolchain): string {
    return this.sandbox.settings.images[toolchain];
  }

  step(
    side: Side,
    toolchain: Toolchain,
    command: string[],
    extra: StepExtra = {},
  ): Promise<StepResult> {
    return this.sandbox.run({
      image: this.image(toolchain),
      command,
      workdir: this.workdir,
      cwd: extra.cwd ?? this.containerPath(side),
      env: { ...this.env(side, toolchain), ...extra.env },
      volumes: this.volumes(side, toolchain),
      runId: this.runId,
      budget: this.budget,
      timeoutMs: extra.timeoutMs,
    });
  }

  async dispose(): Promise<void> {
    await this.sandbox.removeContainers(this.runId).catch(() => undefined);
    await removeWorkdir(this.sandbox.settings.workdirRoot, this.workdir);
  }
}

async function depsVolumeName(
  dir: string,
  toolchain: 'node' | 'python',
  manifests: string[],
  image: string,
): Promise<string> {
  const hash = createHash('sha256').update(`${toolchain}\0${image}\0`);
  for (const name of [...manifests].sort()) {
    hash.update(`${name}\0`);
    hash.update(await readFile(join(dir, name)));
  }
  return `${VOLUME_PREFIX}deps-${toolchain}-${hash.digest('hex').slice(0, 16)}`;
}

function installScript(side: string, toolchain: 'node' | 'python', projects: Projects): string {
  const root = `${WORK_DIR}/${side}`;
  if (toolchain === 'python') {
    return `set -e
if [ -f ${READY_MARKER} ]; then echo cached; exit 0; fi
rm -rf ${PY_SITE}
python ${WORK_DIR}/${SCRATCH}/harness/install_python_deps.py ${root} ${PY_SITE}
touch ${READY_MARKER}`;
  }
  const node = projects.node!;
  // --ignore-scripts: install hooks would run repository code with network access.
  const install = node.lockfile
    ? 'npm ci --ignore-scripts --no-audit --no-fund'
    : 'npm install --ignore-scripts --no-audit --no-fund --no-package-lock';
  const copy = node.manifests.map((m) => `cp '${root}/${m}' ${DEPS_MOUNT}/`).join('\n');
  return `set -e
if [ -f ${READY_MARKER} ]; then echo cached; exit 0; fi
cd ${DEPS_MOUNT}
rm -rf node_modules package.json package-lock.json npm-shrinkwrap.json
${copy}
${install}
touch ${READY_MARKER}`;
}

async function installDeps(ctx: RunContext, side: Side, toolchain: 'node' | 'python') {
  const projects = ctx.projects[side];
  const manifests =
    toolchain === 'node' ? (projects.node?.manifests ?? []) : (projects.python?.manifests ?? []);
  const image = ctx.image(toolchain);
  const volume = await depsVolumeName(ctx.hostPath(side), toolchain, manifests, image);

  // The other side may already have installed the identical set.
  const other = ctx.deps[side === 'base' ? 'head' : 'base'][toolchain];
  if (other?.volume === volume) {
    ctx.deps[side][toolchain] = other;
    return;
  }

  await ctx.sandbox.ensureVolume(volume, { [SANDBOX_LABEL]: 'deps' });
  const result = await ctx.sandbox.run({
    image,
    command: ['sh', '-c', installScript(side, toolchain, projects)],
    workdir: ctx.workdir,
    volumes: [{ name: volume, target: DEPS_MOUNT }],
    allowNetwork: true,
    runId: ctx.runId,
    budget: ctx.budget,
  });
  const ok = result.exitCode === 0;
  ctx.deps[side][toolchain] = {
    volume,
    ok,
    cached: ok && result.stdout.trim() === 'cached',
    message: ok
      ? undefined
      : result.timedOut
        ? 'dependency install timed out'
        : tail(result.stderr || result.stdout),
  };
  if (!ok) ctx.notes.push(`Installing ${toolchain} dependencies for ${side} failed.`);
}

export interface PrepareOptions {
  sandbox: Sandbox;
  budget: RunBudget;
  runId?: string;
  /** Called with short progress messages. */
  onProgress?: (message: string) => void;
  /**
   * Called once base and head are on disk, before dependencies install.
   * Lets slow work that only reads files (the LLM) start early.
   */
  onCheckedOut?: (ctx: RunContext) => void;
}

/** Export base and head into a fresh run folder and install their dependencies. */
export async function prepareWorkspace(
  changes: ChangeSet,
  options: PrepareOptions,
): Promise<RunContext> {
  const { sandbox, budget, onProgress = () => undefined } = options;
  const runId = options.runId ?? randomUUID();
  const workdir = await createWorkdir(sandbox.settings.workdirRoot, runId);
  const scratch = join(workdir, SCRATCH);

  try {
    onProgress('Checking out base and head');
    await exportCommit(changes.repoRoot, changes.baseSha, join(workdir, 'base'), scratch);
    if (changes.headSha) {
      await exportCommit(changes.repoRoot, changes.headSha, join(workdir, 'head'), scratch);
    } else {
      await exportCommit(changes.repoRoot, changes.baseSha, join(workdir, 'head'), scratch);
      await applyWorkingTree(changes, join(workdir, 'head'));
    }
    await mkdir(join(scratch, 'harness'), { recursive: true });
    await cp(HARNESS_DIR, join(scratch, 'harness'), { recursive: true });

    const wantPython = changes.changedFunctions.some((f) => f.language === 'python');
    const projects = {
      base: await detectProjects(join(workdir, 'base'), wantPython),
      head: await detectProjects(join(workdir, 'head'), wantPython),
    };
    const ctx = new RunContext(runId, changes, sandbox, budget, workdir, projects);
    options.onCheckedOut?.(ctx);

    for (const side of ['head', 'base'] as const) {
      if (!existsSync(ctx.hostPath(side))) continue;
      if (projects[side].node) {
        onProgress(`Installing Node dependencies (${side})`);
        await installDeps(ctx, side, 'node');
      }
      if (projects[side].python) {
        onProgress(`Installing Python dependencies (${side})`);
        await installDeps(ctx, side, 'python');
      }
    }
    return ctx;
  } catch (error) {
    await sandbox.removeContainers(runId).catch(() => undefined);
    await removeWorkdir(sandbox.settings.workdirRoot, workdir);
    throw error;
  }
}
