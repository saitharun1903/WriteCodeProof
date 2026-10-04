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
}

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
  const app = Fastify({ logger: { level: options.logLevel } });
  const version = readPackageVersion(import.meta.url);
  const { database, webhook } = options;

  app.get('/health', async () => ({
    status: 'ok',
    version,
    uptimeSeconds: Math.round(process.uptime()),
    database: await probe(database ? () => database.ping() : null),
    queue: await probe(options.queuePing),
  }));

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

  app.get('/api/runs', async (req, reply) => {
    if (!database) return reply.code(503).send({ error: 'No database configured' });
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    return listRuns(database.db, parsed.data);
  });

  app.get('/api/runs/:id', async (req, reply) => {
    if (!database) return reply.code(503).send({ error: 'No database configured' });
    const parsed = runParams.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Run not found' });
    const run = await getRun(database.db, parsed.data.id);
    return run ?? reply.code(404).send({ error: 'Run not found' });
  });

  return app;
}
