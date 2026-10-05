import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { exitCodeFor, EXIT } from '../src/exitCodes.js';
import { buildProgram } from '../src/program.js';
import { oneLine } from '../src/render.js';
import { repoLabel } from '../src/store.js';

vi.mock('../src/commands/check.js', () => ({ checkCommand: vi.fn(async () => 0) }));
vi.mock('../src/commands/doctor.js', () => ({ doctorCommand: vi.fn(async () => 0) }));
const { checkCommand } = await import('../src/commands/check.js');

describe('exit codes (spec section 14)', () => {
  it.each([
    ['low', EXIT.ok],
    ['medium', EXIT.ok],
    ['high', EXIT.high],
    ['blocked', EXIT.blocked],
  ] as const)('%s → %i', (band, code) => expect(exitCodeFor(band)).toBe(code));

  it('uses the numbers from the spec', () => {
    expect(EXIT).toEqual({ ok: 0, high: 1, blocked: 2, toolError: 3 });
  });
});

describe('check options', () => {
  const parse = async (...args: string[]) => {
    vi.mocked(checkCommand).mockClear();
    await buildProgram().parseAsync(['node', 'writecode-proof', 'check', ...args]);
    return vi.mocked(checkCommand).mock.calls[0]!;
  };

  it('defaults to the current folder with generation and LLM on', async () => {
    const [path, options] = await parse();
    expect(path).toBe('.');
    expect(options).toMatchObject({ generate: true, llm: true });
  });

  it('maps every flag', async () => {
    const [path, options] = await parse(
      'repo',
      '--base',
      'develop',
      '--head',
      'feature',
      '--json',
      '--out',
      'r.md',
      '--no-generate',
      '--provider',
      'anthropic',
      '--ai-authored',
    );
    expect(path).toBe('repo');
    expect(options).toMatchObject({
      base: 'develop',
      head: 'feature',
      json: true,
      out: 'r.md',
      generate: false,
      provider: 'anthropic',
      aiAuthored: true,
    });
  });

  it('rejects unknown providers', async () => {
    const program = buildProgram().exitOverride();
    program.commands.forEach((c) =>
      c.exitOverride().configureOutput({ writeErr: () => undefined }),
    );
    await expect(
      program.parseAsync(['node', 'writecode-proof', 'check', '--provider', 'gpt']),
    ).rejects.toThrow(/Allowed choices/);
  });
});

describe('oneLine', () => {
  it('keeps the useful part of an assertion message', () => {
    expect(oneLine('Expected values to be strictly equal:\n\n123.45 !== 123.46\n')).toBe(
      'Expected values to be strictly equal: 123.45 !== 123.46',
    );
    expect(oneLine('Expected:\n+ actual - expected\n\n+ -1\n- -2\n    ^')).toBe(
      'Expected: + -1 - -2',
    );
    expect(oneLine('x'.repeat(500))).toHaveLength(140);
  });
});

describe('repoLabel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wcp-label-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });

  it('uses the folder name without a remote', async () => {
    git('init', '-q');
    expect(await repoLabel(dir)).toBe(basename(dir));
  });

  it.each([
    ['https://github.com/acme/shop.git', 'acme/shop'],
    ['git@github.com:acme/shop.git', 'acme/shop'],
    ['https://gitlab.example.com/team/api', 'team/api'],
  ])('reads owner/repo from %s', async (url, label) => {
    // Creates or replaces the origin remote's URL.
    git('config', 'remote.origin.url', url);
    expect(await repoLabel(dir)).toBe(label);
  });
});
