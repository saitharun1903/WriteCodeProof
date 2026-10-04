import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Env } from '../config/env.js';
import type { SourceLanguage } from '../types.js';

export interface SandboxSettings {
  cpus: number;
  memoryBytes: number;
  pidsLimit: number;
  tmpfsSize: string;
  user: string;
  stepTimeoutMs: number;
  runBudgetMs: number;
  maxOutputBytes: number;
  /** Every sandbox mount must live under this folder. */
  workdirRoot: string;
  images: { node: string; python: string; tools: string };
}

/** Folder name used under the OS temp dir when `SANDBOX_WORKDIR_ROOT` is blank. */
const WORKDIR_FOLDER = 'writecode-proof';

const SIZE_UNITS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** `512m` → bytes. Accepts the format validated by the env schema. */
export function parseDockerSize(size: string): number {
  const match = /^(\d+)([kmg])$/i.exec(size);
  if (!match) throw new Error(`Invalid size "${size}"`);
  return Number(match[1]) * SIZE_UNITS[match[2]!.toLowerCase()]!;
}

export function sandboxSettingsFromEnv(env: Env): SandboxSettings {
  return {
    cpus: env.SANDBOX_CPUS,
    memoryBytes: parseDockerSize(env.SANDBOX_MEMORY),
    pidsLimit: env.SANDBOX_PIDS_LIMIT,
    tmpfsSize: env.SANDBOX_TMPFS_SIZE,
    user: env.SANDBOX_USER,
    stepTimeoutMs: env.SANDBOX_STEP_TIMEOUT_S * 1000,
    runBudgetMs: env.RUN_BUDGET_S * 1000,
    maxOutputBytes: env.SANDBOX_MAX_OUTPUT_BYTES,
    workdirRoot: resolve(env.SANDBOX_WORKDIR_ROOT ?? join(tmpdir(), WORKDIR_FOLDER)),
    images: {
      node: env.SANDBOX_IMAGE_NODE,
      python: env.SANDBOX_IMAGE_PYTHON,
      tools: env.SANDBOX_IMAGE_TOOLS,
    },
  };
}

export function imageForLanguage(settings: SandboxSettings, language: SourceLanguage): string {
  return language === 'python' ? settings.images.python : settings.images.node;
}
