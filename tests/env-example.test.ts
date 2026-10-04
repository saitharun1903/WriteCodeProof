import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, loadEnv } from '@writecode-proof/core';

const example = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));

describe('.env.example', () => {
  it('documents every setting the app reads', () => {
    const missing = ENV_KEYS.filter((key) => !(key in example));
    expect(missing).toEqual([]);
  });

  it('is valid as-is', () => {
    expect(() => loadEnv(example)).not.toThrow();
  });

  it('does not ship any secrets', () => {
    for (const key of ['GITHUB_WEBHOOK_SECRET', 'LLM_API_KEY', 'POSTGRES_PASSWORD']) {
      expect(example[key], key).toBe('');
    }
  });
});
