import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Docker from 'dockerode';
import type { RunBudget } from './budget.js';
import { SandboxError } from './errors.js';
import type { SandboxSettings } from './settings.js';
import { buildContainerSpec, RUN_LABEL, SANDBOX_LABEL, type StepSpec } from './spec.js';
import { assertInsideRoot } from './workdir.js';

export interface StepOptions extends Omit<StepSpec, 'runId'> {
  /** Groups containers of one run, for cleanup. Random if omitted. */
  runId?: string;
  /** Overrides the default step timeout (still capped by the run budget). */
  timeoutMs?: number;
  budget?: RunBudget;
}

export interface StepResult {
  /** `null` when the container was killed before it exited on its own. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
}

/** How long to wait for output to drain after the container stops. */
const STREAM_DRAIN_MS = 2000;
const SIGKILL_EXIT_CODE = 137;

/** Keeps the first `limit` bytes written to it and notes whether anything was dropped. */
class CappedBuffer extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    const room = this.limit - this.size;
    if (room > 0) {
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(part);
      this.size += part.length;
    }
    if (chunk.length > room) this.truncated = true;
    done();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function waitForEnd(stream: NodeJS.ReadableStream, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

const statusCode = (error: unknown) => (error as { statusCode?: number }).statusCode;

/** Longest we wait for any single Docker API call. */
const DOCKER_CALL_TIMEOUT_MS = 30_000;
/** How often the container state is checked while waiting for it to exit. */
const EXIT_POLL_MS = 2_000;
/** After the step timeout kills a container, how long it may take to report it stopped. */
const KILL_GRACE_MS = 30_000;

/** Error codes Node gives when the Docker socket or pipe is gone. */
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/** True when an error means Docker itself went away, not that a container failed. */
export function isDockerConnectionError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return (
    !!e &&
    (CONNECTION_CODES.has(e.code ?? '') ||
      /socket hang up|docker_engine|docker\.sock/i.test(e.message ?? ''))
  );
}

/** Turn a lost Docker connection into one message a person can act on. */
export function explainDockerError(error: unknown, what: string): unknown {
  if (error instanceof SandboxError || !isDockerConnectionError(error)) return error;
  return new SandboxError(`Lost connection to Docker while ${what}. Is Docker Desktop running?`, {
    cause: error,
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  what: string,
  ms = DOCKER_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SandboxError(`Docker did not answer (${what}) within ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout])
    .catch((error: unknown) => {
      throw explainDockerError(error, what);
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Resolve with the container's exit code. Docker's wait call is a long-lived
 * request that can be lost under load (seen with Docker Desktop on Windows),
 * so the container state is also polled, and the whole wait has a deadline.
 */
export function waitForExit(container: Docker.Container, deadlineMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let polling = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      fn();
    };
    container.wait().then(
      (r: { StatusCode: number }) => finish(() => resolve(r.StatusCode)),
      () => undefined,
    );
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      withTimeout(container.inspect(), 'checking a sandbox')
        .then(({ State }) => {
          if (!State.Running && !State.Restarting) finish(() => resolve(State.ExitCode));
        })
        .catch(() => undefined)
        .finally(() => (polling = false));
    }, EXIT_POLL_MS);
    const deadline = setTimeout(
      () => finish(() => reject(new SandboxError('Docker stopped responding while a step ran'))),
      deadlineMs,
    );
  });
}

export class Sandbox {
  readonly docker: Docker;

  constructor(
    readonly settings: SandboxSettings,
    docker?: Docker,
  ) {
    this.docker = docker ?? new Docker();
  }

  /** Throws a readable error when Docker is not running. */
  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (cause) {
      throw new SandboxError('Cannot reach Docker. Is Docker Desktop running?', { cause });
    }
  }

  async hasImage(image: string): Promise<boolean> {
    try {
      await withTimeout(this.docker.getImage(image).inspect(), 'looking up a sandbox image');
      return true;
    } catch (error) {
      if (statusCode(error) === 404) return false;
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(`Docker could not look up ${image}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  async run(options: StepOptions): Promise<StepResult> {
    const { budget, timeoutMs, runId = randomUUID(), ...rest } = options;
    const limitMs = timeoutMs ?? this.settings.stepTimeoutMs;
    const effectiveTimeout = budget ? budget.stepTimeoutMs(limitMs) : limitMs;

    const workdir = await assertInsideRoot(this.settings.workdirRoot, rest.workdir);
    const createOptions = buildContainerSpec(this.settings, { ...rest, workdir, runId });

    if (!(await this.hasImage(rest.image))) {
      throw new SandboxError(`Sandbox image ${rest.image} not found. Run: npm run build:images`);
    }

    const container = await withTimeout(
      this.docker.createContainer(createOptions),
      'creating a sandbox',
    );
    const stdout = new CappedBuffer(this.settings.maxOutputBytes);
    const stderr = new CappedBuffer(this.settings.maxOutputBytes);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    try {
      const stream = await withTimeout(
        container.attach({ stream: true, stdout: true, stderr: true }),
        'attaching to a sandbox',
      );
      container.modem.demuxStream(stream, stdout, stderr);

      const started = Date.now();
      await withTimeout(container.start(), 'starting a sandbox');
      timer = setTimeout(() => {
        timedOut = true;
        container.kill({ signal: 'SIGKILL' }).catch(() => undefined);
      }, effectiveTimeout);

      const StatusCode = await waitForExit(container, effectiveTimeout + KILL_GRACE_MS);
      const durationMs = Date.now() - started;
      clearTimeout(timer);
      await waitForEnd(stream, STREAM_DRAIN_MS);

      const state = (await withTimeout(container.inspect(), 'checking a sandbox')).State;
      return {
        exitCode: timedOut && StatusCode === SIGKILL_EXIT_CODE ? null : StatusCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        oomKilled: state.OOMKilled,
        durationMs,
      };
    } finally {
      clearTimeout(timer);
      // Bounded, so cleanup can never be what hangs a run.
      await withTimeout(container.remove({ force: true, v: true }), 'removing a sandbox').catch(
        () => undefined,
      );
    }
  }

  /** Create a named volume (no-op if it exists), e.g. a dependency cache. */
  async ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    await withTimeout(
      this.docker.createVolume({ Name: name, Labels: labels }),
      'creating a dependency cache',
    );
  }

  /**
   * Remove sandbox containers created longer than `olderThanMs` ago: left
   * behind by a crashed process. Younger ones may belong to a live run.
   */
  async removeStaleContainers(olderThanMs: number): Promise<number> {
    const cutoffS = (Date.now() - olderThanMs) / 1000;
    const containers = await withTimeout(
      this.docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=true`] } }),
      'listing sandboxes',
    );
    const stale = containers.filter((c) => c.Created < cutoffS);
    for (const c of stale) {
      await withTimeout(
        this.docker.getContainer(c.Id).remove({ force: true, v: true }),
        'removing a sandbox',
      ).catch(() => undefined);
    }
    return stale.length;
  }

  /** Remove sandbox containers left behind by a crash. Pass a run id to limit to one run. */
  async removeContainers(runId?: string): Promise<number> {
    const labels = [`${SANDBOX_LABEL}=true`, ...(runId ? [`${RUN_LABEL}=${runId}`] : [])];
    const containers = await this.docker.listContainers({ all: true, filters: { label: labels } });
    await Promise.all(
      containers.map((c) =>
        this.docker
          .getContainer(c.Id)
          .remove({ force: true, v: true })
          .catch(() => undefined),
      ),
    );
    return containers.length;
  }
}
