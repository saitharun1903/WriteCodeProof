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
      await this.docker.getImage(image).inspect();
      return true;
    } catch (error) {
      if (statusCode(error) === 404) return false;
      throw new SandboxError('Cannot reach Docker. Is Docker Desktop running?', { cause: error });
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

    const container = await this.docker.createContainer(createOptions);
    const stdout = new CappedBuffer(this.settings.maxOutputBytes);
    const stderr = new CappedBuffer(this.settings.maxOutputBytes);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      container.modem.demuxStream(stream, stdout, stderr);

      const started = Date.now();
      await container.start();
      timer = setTimeout(() => {
        timedOut = true;
        container.kill({ signal: 'SIGKILL' }).catch(() => undefined);
      }, effectiveTimeout);

      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      const durationMs = Date.now() - started;
      clearTimeout(timer);
      await waitForEnd(stream, STREAM_DRAIN_MS);

      const state = (await container.inspect()).State;
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
      await container.remove({ force: true, v: true }).catch(() => undefined);
    }
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
