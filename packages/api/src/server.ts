import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readPackageVersion, type LogLevel } from '@writecode-proof/core';
import { getRun, listRuns, type DbHandle } from '@writecode-proof/db';
import { handleWebhook, type WebhookDeps } from '@writecode-proof/github';

/** Runs per page for GET /api/runs. */
export const PAGE_SIZE = { default: 20, max: 100 } as const;

export interface ServerOptions {
  logLevel: LogLevel;
  /** Without a database the runs API answers 503. */
  database?: DbHandle | null;
  /** Without GitHub settings the webhook answers 503. */
  webhook?: WebhookDeps | null;
  /** Checked by /health; the queue's Redis connection. */
  queuePing?: (() => Promise<void>) | null;
  /** Built dashboard (packages/dashboard/dist), served at /. */
  dashboardDir?: string | null;
  /** Base for pull request links on the dashboard, e.g. https://github.com. */
  githubWebUrl?: string | null;
  /** Requests per minute per client; /health is exempt. Off when not set. */
  rateLimitPerMinute?: number | null;
  /** Behind nginx: take the client address from X-Forwarded-For. */
  trustProxy?: boolean;
}

/** Errors that mean Postgres or Redis is down, not that the request was wrong. */
function isUnavailable(error: unknown): boolean {
  const e = error as { code?: string; message?: string; name?: string } | null;
  if (!e) return false;
  return (
    ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P03'].includes(
      e.code ?? '',
    ) ||
    e.name === 'QueueUnavailableError' ||
    /connection (terminated|is closed)|timeout exceeded when trying to connect/i.test(
      e.message ?? '',
    )
  );
}

/** Paths that belong to the API; everything else may be a dashboard page. */
const API_PATHS = /^\/(api|webhook|health)(\/|$|\?)/;
/** Paths ending in a file extension are files, not pages. */
const FILE_PATH = /\/[^/]+\.[a-z0-9]+$/i;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE.max).default(PAGE_SIZE.default),
  source: z.enum(['cli', 'github']).optional(),
});
const runParams = z.object({ id: z.uuid() });

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function probe(check: (() => Promise<void>) | null | undefined) {
  if (!check) return 'off';
  return check().then(
    () => 'ok',
    () => 'down',
  );
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel },
    trustProxy: options.trustProxy ?? false,
  });

  if (options.rateLimitPerMinute) {
    app.register(rateLimit, {
      max: options.rateLimitPerMinute,
      timeWindow: '1 minute',
      // Monitoring polls /health; it must not lock itself out.
      allowList: (req) => req.url === '/health',
    });
  }

  // Never send internals (SQL, stack traces) to the client; log them instead.
  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    req.log.error({ err: error }, 'request failed');
    if (isUnavailable(error)) {
      return reply
        .code(503)
        .send({ error: 'The database or queue is not reachable. Try again shortly.' });
    }
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });
  const version = readPackageVersion(import.meta.url);
  const { database, webhook } = options;

  // Routes live in plugins registered after the rate limiter: it only applies
  // to routes added once it has loaded, and plugins load in order.
  app.register(async (api) => {
    api.get('/health', async () => ({
      status: 'ok',
      version,
      uptimeSeconds: Math.round(process.uptime()),
      database: await probe(database ? () => database.ping() : null),
      queue: await probe(options.queuePing),
    }));

    api.get('/api/meta', async () => ({ version, githubWebUrl: options.githubWebUrl ?? null }));

    api.get('/api/runs', async (req, reply) => {
      if (!database) return reply.code(503).send({ error: 'No database configured' });
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
      return listRuns(database.db, parsed.data);
    });

    api.get('/api/runs/:id', async (req, reply) => {
      if (!database) return reply.code(503).send({ error: 'No database configured' });
      const parsed = runParams.safeParse(req.params);
      if (!parsed.success) return reply.code(404).send({ error: 'Run not found' });
      const run = await getRun(database.db, parsed.data.id);
      return run ?? reply.code(404).send({ error: 'Run not found' });
    });
  });

  // The signature covers the exact bytes GitHub sent, so this route keeps the raw body.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/webhook', async (req, reply) => {
      if (!webhook) {
        return reply.code(503).send({ error: 'GitHub App is not configured on this server' });
      }
      const result = await handleWebhook(
        {
          event: header(req.headers['x-github-event']),
          deliveryId: header(req.headers['x-github-delivery']),
          signature: header(req.headers['x-hub-signature-256']),
          rawBody: typeof req.body === 'string' ? req.body : '',
        },
        { ...webhook, log: (message, extra) => req.log.info(extra ?? {}, message) },
      );
      return reply.code(result.status).send(result.body);
    });
  });

  if (options.dashboardDir) {
    // Files are looked up per request, so a rebuild while running is picked up.
    app.register(fastifyStatic, { root: options.dashboardDir });
    // Pages like /runs/<id> are routed in the browser: serve the app for them.
    // A missing file (/assets/x.js) stays a 404, never the page in its place.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      if (req.method === 'GET' && !API_PATHS.test(path) && !FILE_PATH.test(path)) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
