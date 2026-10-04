// Phase 5: the built `writecode-proof` command end to end.
// Runs without an LLM (--no-llm) so results and exit codes are exact.
// Needs Docker and the images; `npm run test:sandbox` builds first.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { COMMENT_MARKER } from '@writecode-proof/core';
import { createExampleRepo } from '../../scripts/example-repo.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(projectRoot, 'packages', 'cli', 'dist', 'index.js');
const root = mkdtempSync(join(tmpdir(), 'wcp-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A single CLI run; keep below Vitest's own test timeout. */
const CLI_TIMEOUT_MS = 170_000;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd: projectRoot,
        env: { ...process.env, NO_COLOR: '1' },
        maxBuffer: 16 * 1024 * 1024,
        // Fail with whatever was printed instead of hanging the suite.
        timeout: CLI_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('writecode-proof check', () => {
  const repo = createExampleRepo('py-sample', join(root, 'py'));

  it('prints JSON and writes Markdown; Medium exits 0', async () => {
    const out = join(root, 'out', 'report.md');
    const result = await run('check', repo, '--no-llm', '--json', '--quiet', '--out', out);
    expect(result.code, result.stderr).toBe(0);

    const report = JSON.parse(result.stdout);
    expect(report.risk).toMatchObject({ score: 6, band: 'medium', blocked: false });
    expect(report.risk.why).toBe('Why 6: 2 unexplained behaviour changes (+6)');
    expect(report.changedFunctions).toHaveLength(5);

    const md = readFileSync(out, 'utf8');
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain('Risk 6/10 · Medium');
  });

  it('prints the Proof Pack to the terminal', async () => {
    const result = await run('check', repo, '--no-llm');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('WriteCode Proof · Risk 6/10 · Medium — one reviewer required');
    expect(result.stdout).toContain('cheapest_item([]) throws ValueError (was None)');
    expect(result.stdout).toContain('Why 6:');
    // Progress goes to stderr so stdout stays clean for piping.
    expect(result.stderr).toContain('Reading the diff');
  });

  it('AI-authored changes score higher: High exits 1', async () => {
    const result = await run('check', repo, '--no-llm', '--json', '--quiet', '--ai-authored');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).risk).toMatchObject({ score: 7, band: 'high' });
  });

  it('follows the repo config policy', async () => {
    const configured = createExampleRepo('py-sample', join(root, 'py-config'));
    mkdirSync(join(configured, '.writecode'));
    writeFileSync(
      join(configured, '.writecode', 'proof.yml'),
      'version: 1\npolicies:\n  code_owner_above: 5\n',
    );
    const result = await run('check', configured, '--no-llm', '--json', '--quiet');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).risk.band).toBe('high');
  });

  it('warns about an invalid config and uses the defaults', async () => {
    const broken = createExampleRepo('py-sample', join(root, 'py-broken'));
    mkdirSync(join(broken, '.writecode'));
    writeFileSync(join(broken, '.writecode', 'proof.yml'), 'version: 1\nmode: yolo\n');
    const result = await run('check', broken, '--no-llm', '--json', '--quiet');
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/warning: .*invalid, using defaults/);
    expect(JSON.parse(result.stdout).notes.join(' ')).toMatch(/mode/);
  });

  it('a secret in the diff blocks: exits 2', async () => {
    const leaky = createExampleRepo('py-sample', join(root, 'py-leak'));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const token = 'ghp_' + [...randomBytes(36)].map((b) => alphabet[b % 62]).join('');
    writeFileSync(join(leaky, 'shop', 'settings.py'), `GITHUB_TOKEN = "${token}"\n`);
    const result = await run('check', leaky, '--no-llm', '--json');
    expect(
      result.code,
      `stderr:
${result.stderr}
stdout:
${result.stdout.slice(0, 500)}`,
    ).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.risk).toMatchObject({ band: 'blocked', blockReasons: ['secret_leak'] });
    expect(result.stdout).not.toContain(token);
  });

  it('a folder that is not a git repo is a tool error: exits 3', async () => {
    const plain = mkdtempSync(join(root, 'plain-'));
    const result = await run('check', plain, '--no-llm');
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/not inside a git repository/);
  });
});

describe('writecode-proof doctor', () => {
  it('reports everything ready', async () => {
    const result = await run('doctor');
    expect(result.stdout).toMatch(/Docker/);
    expect(result.stdout).toMatch(/Image \(tools\)/);
    expect(result.code, result.stdout).toBe(0);
  });
});
