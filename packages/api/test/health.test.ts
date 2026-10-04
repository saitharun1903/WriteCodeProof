import { afterAll, describe, expect, it } from 'vitest';
import { readPackageVersion } from '@writecode-proof/core';
import { buildServer } from '../src/server.js';

describe('GET /health', () => {
  const app = buildServer({ logLevel: 'silent' });
  afterAll(() => app.close());

  it('reports ok with the package version', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe(
      readPackageVersion(new URL('../src/server.ts', import.meta.url).href),
    );
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});
