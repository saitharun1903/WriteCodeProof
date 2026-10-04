import { posix } from 'node:path';
import type { ContainerCreateOptions, MountSettings } from 'dockerode';
import { SandboxError } from './errors.js';
import type { SandboxSettings } from './settings.js';

export const WORK_DIR = '/work';
export const TMP_DIR = '/tmp';
export const SANDBOX_LABEL = 'writecode-proof.sandbox';
export const RUN_LABEL = 'writecode-proof.run';
/** Only Docker volumes with this prefix can be mounted (e.g. the dependency cache). */
export const VOLUME_PREFIX = 'writecode-proof-';

export interface VolumeMount {
  name: string;
  target: string;
  readOnly?: boolean;
}

export interface StepSpec {
  image: string;
  command: string[];
  /** Host folder mounted at /work. Must already be validated as inside the workdir root. */
  workdir: string;
  /** Working directory inside the container; must be under /work or /tmp. Default /work. */
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Network access. Only the dependency-install step should ever set this;
   * everything that runs repository code stays offline.
   */
  allowNetwork?: boolean;
  volumes?: VolumeMount[];
  runId: string;
}

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

function validate(spec: StepSpec): void {
  if (spec.command.length === 0) throw new SandboxError('Sandbox command is empty');
  const cwd = spec.cwd ?? WORK_DIR;
  if (!posix.isAbsolute(cwd) || (!isUnder(cwd, WORK_DIR) && !isUnder(cwd, TMP_DIR))) {
    throw new SandboxError(`Sandbox cwd must be under ${WORK_DIR} or ${TMP_DIR}, got ${cwd}`);
  }
  for (const volume of spec.volumes ?? []) {
    if (!volume.name.startsWith(VOLUME_PREFIX) || !/^[\w.-]+$/.test(volume.name)) {
      throw new SandboxError(`Volume "${volume.name}" must be named ${VOLUME_PREFIX}*`);
    }
    const target = posix.normalize(volume.target);
    if (!posix.isAbsolute(target) || target === '/' || isUnder(WORK_DIR, target)) {
      throw new SandboxError(`Volume target ${volume.target} is not allowed`);
    }
    if (isUnder(target, '/var/run') || isUnder(target, '/run') || isUnder(target, '/proc')) {
      throw new SandboxError(`Volume target ${volume.target} is not allowed`);
    }
  }
  for (const key of Object.keys(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SandboxError(`Invalid environment variable name "${key}"`);
    }
  }
}

/**
 * Container options for one sandbox step. Every limit from spec section 6 is
 * applied here and nowhere else, so they cannot be skipped by a caller.
 */
export function buildContainerSpec(
  settings: SandboxSettings,
  spec: StepSpec,
): ContainerCreateOptions {
  validate(spec);
  const mounts: MountSettings[] = [
    { Type: 'bind', Source: spec.workdir, Target: WORK_DIR, ReadOnly: false },
    ...(spec.volumes ?? []).map((v): MountSettings => ({
      Type: 'volume',
      Source: v.name,
      Target: posix.normalize(v.target),
      ReadOnly: v.readOnly ?? false,
    })),
  ];

  return {
    Image: spec.image,
    Cmd: spec.command,
    WorkingDir: spec.cwd ?? WORK_DIR,
    User: settings.user,
    Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
    Labels: { [SANDBOX_LABEL]: 'true', [RUN_LABEL]: spec.runId },
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      // "none" leaves only the loopback interface. (NetworkDisabled is not used:
      // it also empties /etc/hosts, so even "localhost" stops resolving.)
      NetworkMode: spec.allowNetwork ? 'bridge' : 'none',
      NanoCpus: Math.round(settings.cpus * 1e9),
      Memory: settings.memoryBytes,
      MemorySwap: settings.memoryBytes,
      PidsLimit: settings.pidsLimit,
      ReadonlyRootfs: true,
      Tmpfs: { [TMP_DIR]: `rw,nosuid,nodev,size=${settings.tmpfsSize},mode=1777` },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Init: true,
      AutoRemove: false,
      Mounts: mounts,
    },
  };
}
