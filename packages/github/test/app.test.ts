import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubApp, type GitHubSettings } from '../src/index.js';

// A throwaway key, generated per run: no real credentials are involved.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const settings: GitHubSettings = {
  appId: '123',
  privateKey,
  webhookSecret: 's',
  apiUrl: 'https://api.github.test',
  aiLabel: 'ai-generated',
  cloneDepth: 50,
  cloneRoot: '/tmp/x',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

afterEach(() => vi.unstubAllGlobals());

describe('GitHubApp (HTTP mocked)', () => {
  // Waits out a real one-second Retry-After.
  it(
    'authenticates as the installation and retries after a rate limit',
    { timeout: 15_000 },
    async () => {
      const seen: { url: string; auth: string | null }[] = [];
      let checkRunAttempts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);
          const headers = new Headers(init?.headers);
          seen.push({ url, auth: headers.get('authorization') });
          if (url.endsWith('/app/installations/9/access_tokens')) {
            return json(
              {
                token: 'ghs_installation',
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
              201,
            );
          }
          if (url.endsWith('/repos/acme/shop/check-runs')) {
            checkRunAttempts++;
            if (checkRunAttempts === 1) {
              return json({ message: 'You have exceeded a secondary rate limit' }, 403, {
                'retry-after': '1',
              });
            }
            return json({ id: 77 }, 201);
          }
          return json({ message: 'Not Found' }, 404);
        }),
      );

      const gh = await new GitHubApp(settings).forPullRequest(9, {
        owner: 'acme',
        repo: 'shop',
        prNumber: 1,
      });
      expect(await gh.createCheckRun('a'.repeat(40), 'queued')).toBe(77);
      expect(checkRunAttempts).toBe(2);
      expect(await gh.cloneToken()).toBe('ghs_installation');

      const tokenCall = seen.find((s) => s.url.endsWith('/access_tokens'))!;
      expect(tokenCall.auth).toMatch(/^bearer /i); // signed app JWT
      const apiCall = seen.filter((s) => s.url.endsWith('/check-runs')).at(-1)!;
      expect(apiCall.auth).toBe('token ghs_installation');
    },
  );
});
