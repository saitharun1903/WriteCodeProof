import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadEnvFromFile } from '@writecode-proof/core';
import { connectDb } from '@writecode-proof/db';
import {
  dbRunStore,
  GitHubApp,
  GitHubConfigError,
  githubSettingsFromEnv,
  githubWebUrl,
  RunQueue,
  type WebhookDeps,
} from '@writecode-proof/github';
import { buildServer } from './server.js';

/** Built by `npm run build` (packages/dashboard). */
const DASHBOARD_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dashboard',
  'dist',
);

async function main(): Promise<void> {
  const env = loadEnvFromFile();
  const database = env.DATABASE_URL ? connectDb(env.DATABASE_URL) : null;
  if (database) await database.migrate();
  // Created before the logger exists; problems are logged once the server is up.
  let logQueueError: (error: Error) => void = () => undefined;
  const queue = env.REDIS_URL
    ? new RunQueue(env.REDIS_URL, undefined, (error) => logQueueError(error))
    : null;

  // The runs API works without GitHub; the webhook needs the app settings and a queue.
  let webhook: WebhookDeps | null = null;
  let webhookProblem: string | null = null;
  try {
    const settings = await githubSettingsFromEnv(env);
    if (!queue) throw new GitHubConfigError('REDIS_URL is required to queue pull request runs');
    const github = new GitHubApp(settings);
    webhook = {
      secret: settings.webhookSecret,
      enqueue: (run) => queue.enqueue(run),
      githubFor: (installationId, target) => github.forPullRequest(installationId, target),
      store: database ? dbRunStore(database.db) : null,
    };
  } catch (error) {
    if (!(error instanceof GitHubConfigError)) throw error;
    webhookProblem = error.message;
  }

  const dashboardBuilt = existsSync(join(DASHBOARD_DIR, 'index.html'));
  const app = buildServer({
    logLevel: env.LOG_LEVEL,
    database,
    webhook,
    queuePing: queue ? () => queue.ping() : null,
    dashboardDir: dashboardBuilt ? DASHBOARD_DIR : null,
    githubWebUrl: githubWebUrl(env.GITHUB_API_URL),
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    trustProxy: env.TRUST_PROXY,
  });
  logQueueError = (error) => app.log.warn({ error: error.message }, 'queue connection problem');
  if (!dashboardBuilt) app.log.warn('Dashboard not built: run npm run build');
  if (webhookProblem) app.log.warn(`Webhook disabled: ${webhookProblem}`);
  if (!database) app.log.warn('DATABASE_URL not set: the runs API is disabled');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await queue?.close();
    await database?.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
