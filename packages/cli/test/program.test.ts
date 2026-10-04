import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';

describe('writecode-proof CLI', () => {
  it('uses the version from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(buildProgram().version()).toBe(pkg.version);
  });

  it('is named after its bin entry', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(Object.keys(pkg.bin)).toContain(buildProgram().name());
  });
});
