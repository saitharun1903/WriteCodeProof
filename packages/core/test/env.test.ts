import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, findEnvFile, loadEnv } from '../src/index.js';

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(DEFAULTS.PORT);
    expect(env.LLM_PROVIDER).toBe(DEFAULTS.LLM_PROVIDER);
    expect(env.SANDBOX_MEMORY).toBe(DEFAULTS.SANDBOX_MEMORY);
    expect(env.RUN_BUDGET_S).toBe(DEFAULTS.RUN_BUDGET_S);
  });

  it('treats blank values as unset', () => {
    const env = loadEnv({ PORT: '', DATABASE_URL: '  ', LLM_MODEL: '' });
    expect(env.PORT).toBe(DEFAULTS.PORT);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.LLM_MODEL).toBe(DEFAULTS.LLM_MODEL);
  });

  it('coerces numeric settings from strings', () => {
    const env = loadEnv({ PORT: '4000', SANDBOX_CPUS: '0.5', MAX_CONCURRENT_RUNS: '3' });
    expect(env.PORT).toBe(4000);
    expect(env.SANDBOX_CPUS).toBe(0.5);
    expect(env.MAX_CONCURRENT_RUNS).toBe(3);
  });

  it.each([
    [{ PORT: '70000' }, 'PORT'],
    [{ PORT: 'abc' }, 'PORT'],
    [{ SANDBOX_MEMORY: '2 gigs' }, 'SANDBOX_MEMORY'],
    [{ LLM_PROVIDER: 'gpt' }, 'LLM_PROVIDER'],
    [{ DATABASE_URL: 'not a url' }, 'DATABASE_URL'],
    [{ SANDBOX_STEP_TIMEOUT_S: '600', RUN_BUDGET_S: '300' }, 'SANDBOX_STEP_TIMEOUT_S'],
  ])('rejects %o', (input, key) => {
    expect(() => loadEnv(input)).toThrow(ConfigError);
    try {
      loadEnv(input);
    } catch (error) {
      expect((error as ConfigError).issues.some((i) => i.startsWith(`${key}:`))).toBe(true);
    }
  });

  it('requires an API key for hosted providers', () => {
    expect(() => loadEnv({ LLM_PROVIDER: 'anthropic' })).toThrow(/LLM_API_KEY/);
    expect(loadEnv({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' }).LLM_PROVIDER).toBe('anthropic');
  });

  it('requires a base URL for openai-compatible', () => {
    expect(() => loadEnv({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'k' })).toThrow(
      /LLM_BASE_URL/,
    );
  });
});

describe('findEnvFile', () => {
  let root: string;
  const savedEnvFile = process.env.ENV_FILE;

  beforeEach(() => {
    delete process.env.ENV_FILE;
    root = mkdtempSync(join(tmpdir(), 'wcp-env-'));
  });

  afterEach(() => {
    if (savedEnvFile === undefined) delete process.env.ENV_FILE;
    else process.env.ENV_FILE = savedEnvFile;
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the nearest .env walking upwards', () => {
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.env'), 'PORT=1\n');
    expect(findEnvFile(nested)).toBe(join(root, '.env'));
  });

  it('prefers ENV_FILE when set', () => {
    process.env.ENV_FILE = join(root, 'custom.env');
    expect(findEnvFile(root)).toBe(join(root, 'custom.env'));
  });
});
