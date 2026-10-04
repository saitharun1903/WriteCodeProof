// Phase 4 acceptance: the whole pipeline on real repos inside the sandbox.
// A scripted LLM keeps these deterministic; set WCP_TEST_LLM=1 to also run
// one pass with the configured real model.
// Needs Docker and the images: npm run build:images, then npm run test:sandbox.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createLlmProvider,
  loadEnvFromFile,
  runProof,
  Sandbox,
  sandboxSettingsFromEnv,
  type CheckName,
  type CompleteOptions,
  type LlmProvider,
  type ProofRun,
} from '@writecode-proof/core';
import { createExampleRepo } from '../../scripts/example-repo.mjs';

const root = mkdtempSync(join(tmpdir(), 'wcp-checks-'));
const workdirRoot = join(root, 'runs');
mkdirSync(workdirRoot);
const env = loadEnvFromFile();
const sandbox = new Sandbox({ ...sandboxSettingsFromEnv(env), workdirRoot });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const CANNED: Record<string, string> = {
  cheapestItem: `test('empty list gives null', () => assert.equal(cheapestItem([]), null));
test('finds the cheapest', () => assert.deepEqual(cheapestItem([{ price: 2 }, { price: 1 }]), { price: 1 }));`,
  roundMoney: `test('rounds to cents', () => assert.equal(roundMoney(1.999), 2));`,
  cheapest_item: `def test_empty_list_gives_none():
    assert cheapest_item([]) is None

def test_finds_cheapest():
    assert cheapest_item([{"price": 2}, {"price": 1}]) == {"price": 1}`,
  round_money: `def test_rounds_to_cents():
    assert round_money(1.999) == 2`,
};

/** Stands in for the model: fixed inputs, and hand-written tests per function. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted';
  async complete({ prompt, json }: CompleteOptions): Promise<string> {
    if (json) return JSON.stringify({ inputs: [[1.999], [[]]] });
    const name = /mock `([^`]+)`/.exec(prompt)?.[1] ?? '';
    const python = prompt.includes('pytest');
    const fallback = python
      ? `def test_loads():\n    assert callable(${name})`
      : `test('loads', () => assert.equal(typeof ${name}, 'function'));`;
    return `\`\`\`\n${CANNED[name] ?? fallback}\n\`\`\``;
  }
}

const check = (run: ProofRun, name: CheckName) => run.checks.find((c) => c.check === name)!;
const titles = (run: ProofRun, name: CheckName) => check(run, name).findings.map((f) => f.title);

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
}

function scratchRepo(base: Record<string, string>, head: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'repo-'));
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  write(base);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  write(head);
  return dir;
}

describe.each([
  {
    sample: 'js-sample',
    rounding: 'roundMoney(1.999) returns 1.99 (was 2)',
    crash: 'cheapestItem([]) throws TypeError (was null)',
    confirmed: ['cheapestItem: "empty list gives null"', 'roundMoney: "rounds to cents"'],
  },
  {
    sample: 'py-sample',
    // JSON carries 2.0 as 2.
    rounding: 'round_money(1.999) returns 1.99 (was 2)',
    crash: 'cheapest_item([]) throws ValueError (was None)',
    confirmed: [
      'cheapest_item: "test_empty_list_gives_none"',
      'round_money: "test_rounds_to_cents"',
    ],
  },
])('examples/$sample with planted bugs', ({ sample, rounding, crash, confirmed }) => {
  let run: ProofRun;

  it('runs every check', async () => {
    const repo = createExampleRepo(sample, join(root, sample));
    run = await runProof({ repoPath: repo, sandbox, llm: new ScriptedLlm() });
    expect(run.checks.map((c) => [c.check, c.status])).toEqual([
      ['existing_tests', 'passed'],
      ['generated_tests', 'warning'],
      ['behaviour_diff', 'warning'],
      ['security', 'passed'],
    ]);
    expect(run.notes).toEqual([]);
  });

  it('existing tests pass on both sides', () => {
    expect(check(run, 'existing_tests').stats).toMatchObject({
      run: 4,
      passed: 4,
      newlyFailing: 0,
    });
  });

  it('behaviour diff reports the empty-list crash and the rounding change', () => {
    const found = titles(run, 'behaviour_diff');
    expect(found).toContain(crash);
    expect(found).toContain(rounding);
  });

  it('generated tests confirm both bugs against the old code', () => {
    const generated = check(run, 'generated_tests');
    const confirmedTitles = generated.findings
      .filter((f) => f.severity === 'medium')
      .map((f) => f.title);
    for (const prefix of confirmed) {
      expect(confirmedTitles.some((t) => t.startsWith(prefix))).toBe(true);
    }
    // The two placeholder tests (`typeof X === 'function'`, for Cart and the new
    // tax function) pass whatever the code does, so mutation-lite marks them
    // weak. "finds the cheapest" is killed by the flipped comparison: not weak.
    expect(generated.stats.passing).toBe(3);
    expect(generated.stats.weak).toBe(2);
  });

  it('cleans up the run folder and containers', async () => {
    expect(readdirSync(workdirRoot)).toEqual([]);
    expect(
      await sandbox.docker.listContainers({
        all: true,
        filters: { label: [`writecode-proof.run=${run.runId}`] },
      }),
    ).toEqual([]);
  });
});

describe('existing tests', () => {
  it('flags a test that passed on base and fails on head', async () => {
    const repo = scratchRepo(
      {
        'calc.py': 'def add(a, b):\n    return a + b\n',
        'tests/test_calc.py':
          'from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n',
        'requirements.txt': '',
      },
      { 'calc.py': 'def add(a, b):\n    return a - b\n' },
    );
    const run = await runProof({ repoPath: repo, sandbox, llm: null });
    const existing = check(run, 'existing_tests');
    expect(existing.status).toBe('failed');
    expect(existing.findings.map((f) => [f.severity, f.title])).toEqual([
      ['high', 'Test now fails: test_add'],
    ]);
    const behaviour = check(run, 'behaviour_diff').findings;
    expect(behaviour).toHaveLength(1);
    // Inputs the old code handled come first: [] + [] worked, [] - [] crashes.
    expect(behaviour[0]!.title).toBe('add([], []) throws TypeError (was [])');
    // Every numeric input changed too; the report keeps the 5 clearest examples.
    expect(behaviour[0]!.detail.inputsChanged).toBeGreaterThan(10);
    expect(behaviour[0]!.detail.examples).toHaveLength(5);
  });
});

describe('security', () => {
  it('reports new findings and secrets only, never the secret itself', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const token = 'ghp_' + [...randomBytes(36)].map((b) => alphabet[b % 62]).join('');
    const repo = scratchRepo(
      {
        'package.json': '{"name":"s","private":true}',
        'old.js': 'export const run = (input) => eval(input);\n',
      },
      {
        'old.js': 'export const run = (input) => eval(input);\nexport const two = 2;\n',
        'new.js': 'export const exec = (code) => eval(code);\n',
        'config.js': `export const token = "${token}";\n`,
      },
    );
    const run = await runProof({ repoPath: repo, sandbox, llm: null });
    const security = check(run, 'security');
    expect(security.status).toBe('failed');

    const leaks = security.findings.filter((f) => f.severity === 'critical');
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.file).toBe('config.js');

    const code = security.findings.filter((f) => f.detail.tool === 'semgrep');
    expect(code.map((f) => f.file)).toContain('new.js');
    expect(code.map((f) => f.file)).not.toContain('old.js');
    expect(JSON.stringify(run)).not.toContain(token);
  });
});

describe.runIf(process.env.WCP_TEST_LLM === '1')('with the real LLM', () => {
  // No cache: this measures a cold run, which is slow on a small local GPU.
  it('finds the planted bugs in js-sample', { timeout: 600_000 }, async () => {
    const repo = createExampleRepo('js-sample', join(root, 'js-real'));
    const run = await runProof({ repoPath: repo, sandbox, llm: createLlmProvider(env) });
    const found = titles(run, 'behaviour_diff');
    expect(found.some((t) => t.startsWith('cheapestItem([]) throws TypeError'))).toBe(true);
    expect(found.some((t) => t.startsWith('roundMoney('))).toBe(true);
  });
});
