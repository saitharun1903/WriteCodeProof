// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run, RunPage, RunSummary } from '../src/api.js';
import { App } from '../src/App.js';
import { changeLabel, pullRequestUrl, timeAgo } from '../src/format.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    source: 'github',
    repo: 'acme/shop',
    prNumber: 12,
    baseSha: 'b'.repeat(40),
    headSha: 'a1b2c3d4e5'.padEnd(40, '0'),
    status: 'done',
    riskScore: 6,
    riskBand: 'medium',
    why: 'Why 6: 2 unexplained behaviour changes (+6)',
    durationMs: 154_000,
    createdAt: minutesAgo(3),
    finishedAt: minutesAgo(1),
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    ...summary(),
    error: null,
    checks: [
      {
        check: 'security',
        status: 'passed',
        summary: 'No new findings',
        stats: {},
        notes: [],
        durationMs: 19_000,
        findingCount: 0,
      },
      {
        check: 'existing_tests',
        status: 'passed',
        summary: '4 run, 4 pass',
        stats: {},
        notes: [],
        durationMs: 6_000,
        findingCount: 0,
      },
      {
        check: 'generated_tests',
        status: 'warning',
        summary: '17 written, 9 pass',
        stats: {},
        notes: ['Dropped 6 generated tests that also failed on the old code.'],
        durationMs: 10_000,
        findingCount: 1,
      },
      {
        check: 'behaviour_diff',
        status: 'warning',
        summary: '1 change',
        stats: {},
        notes: [],
        durationMs: 5_000,
        findingCount: 1,
      },
    ],
    findings: [
      {
        check: 'generated_tests',
        severity: 'info',
        title: 'totalWithTax: "handles null" fails (new function, unconfirmed)',
        detail: { message: 'Cannot read properties of null' },
        file: 'src/cart.js',
        line: 20,
      },
      {
        check: 'behaviour_diff',
        severity: 'high',
        title: 'cheapestItem([]) throws TypeError (was null)',
        detail: {
          examples: [
            { summary: 'first' },
            { summary: 'cheapestItem("") throws TypeError (was null)' },
          ],
        },
        file: 'src/cart.js',
        line: 16,
      },
    ],
    ...overrides,
  } as Run;
}

/** Fake API: answers by path, records what was asked. */
function serve(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(input);
      const path = input.split('?')[0]!;
      const body = routes[input] ?? routes[path];
      if (body === undefined)
        return new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 });
      if (body instanceof Error) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

const page = (items: RunSummary[]): RunPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});
const meta = { version: '0.1.0', githubWebUrl: 'https://github.com' };

function open(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('format', () => {
  it('says how long ago', () => {
    expect(timeAgo(minutesAgo(0.2), NOW)).toBe('just now');
    expect(timeAgo(minutesAgo(3), NOW)).toBe('3 minutes ago');
    expect(timeAgo(minutesAgo(60 * 26), NOW)).toBe('yesterday');
  });

  it('labels the change and links pull requests', () => {
    expect(changeLabel(summary())).toBe('#12');
    expect(changeLabel(summary({ source: 'cli', prNumber: null }))).toBe('a1b2c3d');
    expect(changeLabel(summary({ source: 'cli', prNumber: null, headSha: null }))).toBe(
      'working tree',
    );
    expect(pullRequestUrl(summary(), 'https://github.com')).toBe(
      'https://github.com/acme/shop/pull/12',
    );
    expect(pullRequestUrl(summary({ source: 'cli' }), 'https://github.com')).toBeNull();
    expect(pullRequestUrl(summary(), null)).toBeNull();
  });
});

describe('runs list', () => {
  it('shows runs from GitHub and the CLI', async () => {
    serve({
      '/api/runs': page([
        summary(),
        summary({
          id: '22222222-2222-4222-8222-222222222222',
          source: 'cli',
          repo: 'js-sample',
          prNumber: null,
          headSha: null,
          riskScore: 10,
          riskBand: 'high',
        }),
      ]),
    });
    open('/');
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2
    expect(within(rows[1]!).getByText('acme/shop')).toBeTruthy();
    expect(within(rows[1]!).getByText('Pull request')).toBeTruthy();
    expect(within(rows[1]!).getByText('Medium')).toBeTruthy();
    expect(within(rows[1]!).getByText('2 unexplained behaviour changes (+6)')).toBeTruthy();
    expect(within(rows[1]!).getByText('2m 34s')).toBeTruthy();
    expect(within(rows[2]!).getByText('working tree')).toBeTruthy();
    expect(within(rows[2]!).getByText('High')).toBeTruthy();
  });

  it('filters by source and keeps the filter in the URL', async () => {
    const calls = serve({ '/api/runs': page([summary()]) });
    open('/');
    await screen.findByText('acme/shop');
    fireEvent.click(screen.getByRole('link', { name: 'Local checks' }));
    await waitFor(() => expect(calls.at(-1)).toBe('/api/runs?page=1&source=cli'));
    expect(window.location.search).toBe('?source=cli');
  });

  it('explains how to get the first run', async () => {
    serve({ '/api/runs': page([]) });
    open('/');
    expect(await screen.findByText('No runs yet.')).toBeTruthy();
    expect(screen.getByText('npx writecode-proof check')).toBeTruthy();
  });

  it('says when the API is down and can retry', async () => {
    serve({ '/api/runs': new Error('down') });
    open('/');
    expect(await screen.findByText('Could not load runs.')).toBeTruthy();
    expect(screen.getByText('The API is not reachable.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('run page', () => {
  const id = summary().id;

  it('shows risk, checks in report order and the worst findings first', async () => {
    serve({ [`/api/runs/${id}`]: run(), '/api/meta': meta });
    open(`/runs/${id}`);
    expect(await screen.findByText('acme/shop')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe(
      'https://github.com/acme/shop/pull/12',
    );
    expect(screen.getByText('one reviewer required')).toBeTruthy();
    expect(screen.getByText('Why 6: 2 unexplained behaviour changes (+6)')).toBeTruthy();

    const checks = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(checks).toEqual(['Existing tests', 'Generated tests', 'Behaviour diff', 'Security']);

    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(['Behaviour diff', 'Generated tests']);
    expect(screen.getByText('cheapestItem("") throws TypeError (was null)')).toBeTruthy();
    expect(screen.getByText('Cannot read properties of null')).toBeTruthy();
    expect(
      screen.getByText('Dropped 6 generated tests that also failed on the old code.'),
    ).toBeTruthy();
  });

  it('explains a run that could not finish', async () => {
    serve({
      [`/api/runs/${id}`]: run({
        status: 'error',
        riskScore: null,
        riskBand: null,
        why: null,
        error: 'Cannot reach Docker',
        checks: [],
        findings: [],
      }),
      '/api/meta': meta,
    });
    open(`/runs/${id}`);
    expect(await screen.findByText('The checks could not finish.')).toBeTruthy();
    expect(screen.getByText('Cannot reach Docker')).toBeTruthy();
  });

  it('says so when the run does not exist', async () => {
    serve({ '/api/meta': meta });
    open(`/runs/${id}`);
    expect(await screen.findByText('There is no run with this id.')).toBeTruthy();
  });

  it('shows a run still in progress', async () => {
    serve({
      [`/api/runs/${id}`]: run({
        status: 'running',
        riskScore: null,
        riskBand: null,
        checks: [],
        findings: [],
      }),
      '/api/meta': meta,
    });
    open(`/runs/${id}`);
    expect(await screen.findByText('Checking this change now.')).toBeTruthy();
    expect(screen.getByText('This page updates by itself.')).toBeTruthy();
  });
});

describe('navigation', () => {
  it('opens a run from the list and goes back', async () => {
    serve({
      '/api/runs': page([summary()]),
      [`/api/runs/${summary().id}`]: run(),
      '/api/meta': meta,
    });
    open('/');
    fireEvent.click(await screen.findByRole('link', { name: /acme\/shop/ }));
    expect(await screen.findByText('Checks')).toBeTruthy();
    expect(window.location.pathname).toBe(`/runs/${summary().id}`);
    fireEvent.click(screen.getByRole('link', { name: '← All runs' }));
    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeTruthy();
  });

  it('answers unknown pages', async () => {
    serve({});
    open('/nope');
    expect(await screen.findByText('This page does not exist.')).toBeTruthy();
  });
});
