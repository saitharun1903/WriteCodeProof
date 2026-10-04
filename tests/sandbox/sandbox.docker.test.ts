// Proves the sandbox limits from spec section 6 hold inside real containers.
// Needs Docker and the images: npm run build:images, then npm run test:sandbox.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  createWorkdir,
  loadEnvFromFile,
  parseDockerSize,
  RUN_LABEL,
  RunBudget,
  Sandbox,
  SandboxError,
  sandboxSettingsFromEnv,
  type SandboxSettings,
  type StepOptions,
} from '@writecode-proof/core';

const root = mkdtempSync(join(tmpdir(), 'wcp-sandbox-'));
const base = sandboxSettingsFromEnv(loadEnvFromFile());
const settings: SandboxSettings = { ...base, workdirRoot: root };
const sandbox = new Sandbox(settings);
const runId = `test-${randomUUID()}`;

let workdir: string;

const node = (script: string, extra: Partial<StepOptions> = {}) =>
  sandbox.run({
    image: settings.images.node,
    command: ['node', '-e', script],
    workdir,
    runId,
    ...extra,
  });

const json = <T>(text: string): T => JSON.parse(text.trim()) as T;

beforeAll(async () => {
  await sandbox.ping();
  for (const image of Object.values(settings.images)) {
    if (!(await sandbox.hasImage(image))) {
      throw new Error(`Missing image ${image}. Run: npm run build:images`);
    }
  }
  workdir = await createWorkdir(root, 'docker-test');
});

afterAll(async () => {
  await sandbox.removeContainers(runId);
  rmSync(root, { recursive: true, force: true });
});

describe('sandbox limits', () => {
  it('runs as uid/gid 1000 with no capabilities and no-new-privileges', async () => {
    const result = await node(`
      const status = require('fs').readFileSync('/proc/self/status', 'utf8');
      const field = (name) => status.match(new RegExp('^' + name + ':\\\\s*(.+)$', 'm'))[1].trim();
      console.log(JSON.stringify({
        uid: process.getuid(), gid: process.getgid(),
        capEff: field('CapEff'), capBnd: field('CapBnd'), noNewPrivs: field('NoNewPrivs'),
      }));
    `);
    expect(result.exitCode).toBe(0);
    const [uid, gid] = settings.user.split(':').map(Number);
    expect(json(result.stdout)).toEqual({
      uid,
      gid,
      capEff: '0000000000000000',
      capBnd: '0000000000000000',
      noNewPrivs: '1',
    });
  });

  it('has no network', async () => {
    const result = await node(`
      const os = require('os');
      const dns = require('dns').promises;
      (async () => {
        const out = { interfaces: Object.keys(os.networkInterfaces()) };
        try { await dns.lookup('example.com'); out.dns = 'ok'; } catch (e) { out.dns = e.code; }
        try { out.localhost = (await dns.lookup('localhost')).address; } catch (e) { out.localhost = e.code; }
        try {
          await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(3000) });
          out.http = 'ok';
        } catch (e) { out.http = 'failed'; }
        console.log(JSON.stringify(out));
      })();
    `);
    expect(result.exitCode).toBe(0);
    const out = json<{ interfaces: string[]; dns: string; http: string; localhost: string }>(
      result.stdout,
    );
    // Loopback still works: test runners often bind to localhost.
    expect(out.localhost).toMatch(/^(127.0.0.1|::1)$/);
    expect(out.interfaces).toEqual(['lo']);
    expect(out.dns).not.toBe('ok');
    expect(out.http).toBe('failed');
  });

  it('can only write to /work and /tmp', async () => {
    const result = await node(`
      const fs = require('fs');
      const targets = ['/work', '/tmp', '/', '/etc', '/usr/local/bin', '/home', '/var', '/opt'];
      const out = {};
      for (const dir of targets) {
        try { fs.writeFileSync(dir.replace(/\\/$/, '') + '/probe.txt', 'x'); out[dir] = 'ok'; }
        catch (e) { out[dir] = e.code; }
      }
      console.log(JSON.stringify(out));
    `);
    expect(result.exitCode).toBe(0);
    const out = json<Record<string, string>>(result.stdout);
    expect(out['/work']).toBe('ok');
    expect(out['/tmp']).toBe('ok');
    for (const dir of ['/', '/etc', '/usr/local/bin', '/home', '/var', '/opt']) {
      expect(out[dir], dir).toMatch(/^(EROFS|EACCES)$/);
    }
    // /work is the run's folder on the host.
    expect(readFileSync(join(workdir, 'probe.txt'), 'utf8')).toBe('x');
  });

  it('sees no Docker socket and no host folders besides /work', async () => {
    const result = await node(`
      const fs = require('fs');
      const mounts = fs.readFileSync('/proc/self/mounts', 'utf8').trim().split('\\n')
        .map((l) => l.split(' ')[1]);
      console.log(JSON.stringify({
        socket: ['/var/run/docker.sock', '/run/docker.sock'].some((p) => fs.existsSync(p)),
        mounts,
      }));
    `);
    const out = json<{ socket: boolean; mounts: string[] }>(result.stdout);
    expect(out.socket).toBe(false);
    // Docker's own mounts are expected; anything else would be a leak.
    const expected =
      /^(\/|\/work|\/tmp|\/proc(\/.*)?|\/sys(\/.*)?|\/dev(\/.*)?|\/etc\/(hosts|hostname|resolv\.conf)|(\/usr)?\/sbin\/docker-init)$/;
    expect(out.mounts.filter((m) => !expected.test(m))).toEqual([]);
    expect(out.mounts).toContain('/work');
    expect(result.stdout).not.toContain(homedir().replace(/\\/g, '/'));
  });

  it('kills a step that runs past its timeout and removes the container', async () => {
    const result = await node('setInterval(() => {}, 1000)', { timeoutMs: 2000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(2000);
    expect(result.durationMs).toBeLessThan(10_000);

    const left = await sandbox.docker.listContainers({
      all: true,
      filters: { label: [`${RUN_LABEL}=${runId}`] },
    });
    expect(left).toEqual([]);
  });

  it('caps the step timeout by the remaining run budget', async () => {
    const budget = new RunBudget(1500);
    const result = await node('setInterval(() => {}, 1000)', { timeoutMs: 60_000, budget });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
    await expect(node('1', { budget: new RunBudget(0) })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('enforces the memory limit', async () => {
    const small = new Sandbox({ ...settings, memoryBytes: parseDockerSize('128m') });
    const result = await small.run({
      image: settings.images.node,
      command: ['node', '-e', 'const a = []; for (;;) a.push(Buffer.alloc(16 * 1024 * 1024, 1));'],
      workdir,
      runId,
    });
    expect(result.oomKilled).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('enforces the process limit', async () => {
    const small = new Sandbox({ ...settings, pidsLimit: 32 });
    const result = await small.run({
      image: settings.images.node,
      command: ['sh', '-c', 'for i in $(seq 1 100); do sleep 2 & done; wait; echo done'],
      workdir,
      runId,
    });
    expect(result.stderr).toMatch(/can(no|')t fork|Resource temporarily unavailable/i);
  });

  it('cuts off output beyond the limit', async () => {
    const small = new Sandbox({ ...settings, maxOutputBytes: 1000 });
    const result = await small.run({
      image: settings.images.node,
      command: ['node', '-e', 'process.stdout.write("x".repeat(50000))'],
      workdir,
      runId,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(1000);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('refuses to mount a folder outside the workdir root', async () => {
    await expect(
      sandbox.run({ image: settings.images.node, command: ['true'], workdir: homedir(), runId }),
    ).rejects.toBeInstanceOf(SandboxError);
  });
});

describe('sandbox images', () => {
  it('python image runs Python and pytest offline as uid 1000', async () => {
    writeFileSync(join(workdir, 'test_probe.py'), 'def test_ok():\n    assert 1 + 1 == 2\n');
    const result = await sandbox.run({
      image: settings.images.python,
      command: ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'test_probe.py'],
      workdir,
      runId,
    });
    expect(result.stdout).toContain('1 passed');
    expect(result.exitCode).toBe(0);
  });

  it('tools image runs Semgrep and Gitleaks offline', async () => {
    const scanDir = join(workdir, 'scan');
    mkdirSync(scanDir);
    writeFileSync(join(scanDir, 'app.js'), 'const run = (input) => eval(input);\n');
    // Built at runtime so no secret-shaped string is ever committed.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const token = 'ghp_' + [...randomBytes(36)].map((b) => alphabet[b % 62]).join('');
    writeFileSync(join(scanDir, 'config.js'), `export const token = "${token}";\n`);

    const semgrep = await sandbox.run({
      image: settings.images.tools,
      command: [
        'semgrep',
        'scan',
        '--metrics=off',
        '--disable-version-check',
        '--config',
        '/opt/semgrep-rules/default.yml',
        '--json',
        '--quiet',
        '/work/scan',
      ],
      workdir,
      runId,
    });
    expect(semgrep.exitCode, semgrep.stderr).toBe(0);
    const findings = json<{ results: { check_id: string }[] }>(semgrep.stdout).results;
    expect(findings.some((r) => /eval/i.test(r.check_id))).toBe(true);

    const report = await sandbox.run({
      image: settings.images.tools,
      command: [
        'gitleaks',
        'dir',
        '/work/scan',
        '--no-banner',
        '--exit-code',
        '0',
        '--report-format',
        'json',
        '--report-path',
        '-',
        '--log-level',
        'error',
      ],
      workdir,
      runId,
    });
    expect(report.exitCode, report.stderr).toBe(0);
    const leaks = json<{ RuleID: string; File: string }[]>(report.stdout);
    expect(leaks.some((l) => l.File.endsWith('config.js'))).toBe(true);
  });
});
