import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertInsideRoot,
  BudgetExceededError,
  buildContainerSpec,
  createWorkdir,
  loadEnv,
  parseDockerSize,
  removeWorkdir,
  RunBudget,
  SandboxError,
  waitForExit,
  sandboxSettingsFromEnv,
  type StepSpec,
} from '../src/index.js';

const settings = sandboxSettingsFromEnv(loadEnv({}));
const step = (overrides: Partial<StepSpec> = {}): StepSpec => ({
  image: 'img',
  command: ['node', '-v'],
  workdir: '/host/run-1',
  runId: 'r1',
  ...overrides,
});

describe('parseDockerSize', () => {
  it.each([
    ['512k', 512 * 1024],
    ['64m', 64 * 1024 ** 2],
    ['2g', 2 * 1024 ** 3],
    ['2G', 2 * 1024 ** 3],
  ])('%s', (input, bytes) => expect(parseDockerSize(input)).toBe(bytes));

  it('rejects other formats', () => expect(() => parseDockerSize('2gb')).toThrow());
});

describe('buildContainerSpec', () => {
  it('applies every limit from spec section 6', () => {
    const spec = buildContainerSpec(settings, step());
    const host = spec.HostConfig!;
    expect(host.NetworkMode).toBe('none');
    expect(host.NanoCpus).toBe(settings.cpus * 1e9);
    expect(host.Memory).toBe(settings.memoryBytes);
    expect(host.MemorySwap).toBe(settings.memoryBytes);
    expect(host.PidsLimit).toBe(settings.pidsLimit);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(Object.keys(host.Tmpfs!)).toEqual(['/tmp']);
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.CapAdd).toBeUndefined();
    expect(host.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(host.Privileged).toBe(false);
    expect(spec.User).toBe(settings.user);
    expect(spec.User).not.toMatch(/^0(:|$)/);
  });

  it('mounts only the run workdir, never the Docker socket or host folders', () => {
    const host = buildContainerSpec(settings, step()).HostConfig!;
    expect(host.Binds).toBeUndefined();
    expect(host.Mounts).toEqual([
      { Type: 'bind', Source: '/host/run-1', Target: '/work', ReadOnly: false },
    ]);
    expect(JSON.stringify(host)).not.toContain('docker.sock');
  });

  it('enables the network only when asked', () => {
    const spec = buildContainerSpec(settings, step({ allowNetwork: true }));
    expect(spec.HostConfig!.NetworkMode).toBe('bridge');
    // Every other limit still applies.
    expect(spec.HostConfig!.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig!.CapDrop).toEqual(['ALL']);
  });

  it('accepts named cache volumes', () => {
    const spec = buildContainerSpec(
      settings,
      step({ volumes: [{ name: 'writecode-proof-deps-abc', target: '/work/node_modules' }] }),
    );
    expect(spec.HostConfig!.Mounts).toContainEqual({
      Type: 'volume',
      Source: 'writecode-proof-deps-abc',
      Target: '/work/node_modules',
      ReadOnly: false,
    });
  });

  it.each([
    ['empty command', { command: [] }],
    ['cwd outside /work and /tmp', { cwd: '/etc' }],
    ['relative cwd', { cwd: 'work' }],
    ['cwd that only looks like /work', { cwd: '/workspace' }],
    ['foreign volume', { volumes: [{ name: 'other', target: '/cache' }] }],
    ['host path as volume', { volumes: [{ name: 'C:\\Users', target: '/cache' }] }],
    ['volume over root', { volumes: [{ name: 'writecode-proof-x', target: '/' }] }],
    ['volume over /work', { volumes: [{ name: 'writecode-proof-x', target: '/work' }] }],
    ['volume on /var/run', { volumes: [{ name: 'writecode-proof-x', target: '/var/run' }] }],
    ['bad env name', { env: { 'A=B': '1' } }],
  ] satisfies [string, Partial<StepSpec>][])('rejects %s', (_label, overrides) => {
    expect(() => buildContainerSpec(settings, step(overrides))).toThrow(SandboxError);
  });
});

describe('sandbox settings', () => {
  it('rejects running as root', () => {
    expect(() => loadEnv({ SANDBOX_USER: '0:0' })).toThrow(/root/);
    expect(() => loadEnv({ SANDBOX_USER: '1000:0' })).toThrow(/root/);
    expect(() => loadEnv({ SANDBOX_USER: 'root' })).toThrow(/uid:gid/);
  });

  it('defaults the workdir root to the OS temp folder', () => {
    expect(settings.workdirRoot.startsWith(tmpdir())).toBe(true);
  });
});

describe('RunBudget', () => {
  it('caps each step by the time left', () => {
    let now = 0;
    const budget = new RunBudget(10_000, () => now);
    expect(budget.stepTimeoutMs(3_000)).toBe(3_000);
    now = 8_000;
    expect(budget.stepTimeoutMs(3_000)).toBe(2_000);
    now = 10_000;
    expect(budget.exhausted).toBe(true);
    expect(() => budget.stepTimeoutMs(3_000)).toThrow(BudgetExceededError);
  });
});

describe('workdirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'wcp-root-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('creates a unique folder inside the root', async () => {
    const a = await createWorkdir(root, 'pr#12 ../x');
    const b = await createWorkdir(root, 'pr#12 ../x');
    expect(a).not.toBe(b);
    expect(await assertInsideRoot(root, a)).toBe(a);
  });

  it('refuses the root itself and anything outside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wcp-outside-'));
    try {
      await expect(assertInsideRoot(root, root)).rejects.toThrow(SandboxError);
      await expect(assertInsideRoot(root, outside)).rejects.toThrow(SandboxError);
      await expect(assertInsideRoot(root, join(root, '..'))).rejects.toThrow(SandboxError);
      await expect(assertInsideRoot(root, join(root, 'missing'))).rejects.toThrow(/does not exist/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('only ever deletes folders inside the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wcp-keep-'));
    writeFileSync(join(outside, 'keep.txt'), 'x');
    await removeWorkdir(root, outside);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    rmSync(outside, { recursive: true, force: true });

    const inside = await createWorkdir(root, 'tmp');
    mkdirSync(join(inside, 'nested'));
    await removeWorkdir(root, inside);
    expect(existsSync(inside)).toBe(false);
  });
});

describe('waitForExit', () => {
  const never = () => new Promise<never>(() => undefined);

  it('notices the exit even when Docker never answers the wait call', async () => {
    let inspections = 0;
    const container = {
      wait: never,
      inspect: async () => {
        inspections++;
        return { State: { Running: inspections < 2, Restarting: false, ExitCode: 137 } };
      },
    };
    expect(await waitForExit(container as never, 30_000)).toBe(137);
  }, 15_000);

  it('gives up at the deadline when Docker stops responding entirely', async () => {
    const container = { wait: never, inspect: never };
    await expect(waitForExit(container as never, 500)).rejects.toThrow(/stopped responding/);
  });

  it('uses the wait result when it arrives', async () => {
    const container = { wait: async () => ({ StatusCode: 3 }), inspect: never };
    expect(await waitForExit(container as never, 30_000)).toBe(3);
  });
});
