import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

describe('docker-compose.yml', () => {
  it('binds every published port to localhost only', () => {
    const published = [...compose.matchAll(/^\s*-\s*'([^']*):\d+'\s*$/gm)].map((m) => m[1]);
    expect(published.length).toBeGreaterThan(0);
    for (const binding of published) expect(binding).toMatch(/^127\.0\.0\.1:/);
  });

  it('never mounts the Docker socket', () => {
    expect(compose).not.toContain('docker.sock');
  });

  it('takes credentials from the environment, not the file', () => {
    expect(compose).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
  });
});
