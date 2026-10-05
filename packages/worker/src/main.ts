import pino from 'pino';
import {
  CachedProvider,
  ConfigError,
  createLlmProvider,
  defaultCacheDir,
  loadEnvFromFile,
  Sandbox,
  sandboxSettingsFromEnv,
} from '@writecode-proof/core';
import { connectDb } from '@writecode-proof/db';
import {
  dbRunStore,
  GitHubApp,
  GitHubConfigError,
  githubSettingsFromEnv,
  RunQueue,
} from '@writecode-proof/github';
import { startMaintenance } from './maintenance.js';
import { startWorker } from './worker.js';

async function main(): Promise<void> {
  const env = loadEnvFromFile();
  const logger = pino({ level: env.LOG_LEVEL, base: { service: 'worker' } });
  if (!env.REDIS_URL) throw new ConfigError(['REDIS_URL: required for the worker']);

  const settings = await githubSettingsFromEnv(env);
  const sandbox = new Sandbox(sandboxSettingsFromEnv(env));
  await sandbox.ping();

  const database = env.DATABASE_URL ? connectDb(env.DATABASE_URL) : null;
  if (database) await database.migrate();
  else logger.warn('DATABASE_URL not set: runs will not be stored');

  const queue = new RunQueue(env.REDIS_URL, undefined, (error) =>
    logger.warn({ error: error.message }, 'queue connection problem'),
  );
  const app = new GitHubApp(settings);
  const llm = new CachedProvider(createLlmProvider(env), env.LLM_CACHE_DIR ?? defaultCacheDir());

  const worker = startWorker({
    redisUrl: env.REDIS_URL,
    concurrency: env.MAX_CONCURRENT_RUNS,
    queue,
    githubFor: (installationId, target) => app.forPullRequest(installationId, target),
    store: database ? dbRunStore(database.db) : null,
    sandbox,
    llm,
    cloneRoot: settings.cloneRoot,
    cloneDepth: settings.cloneDepth,
    aiLabel: settings.aiLabel,
    log: (message, extra) => logger.info(extra ?? {}, message),
  });
  worker.on('completed', (job, outcome) =>
    logger.info({ runId: job.data.runId, ...outcome }, 'run finished'),
  );
  worker.on('failed', (job, error) =>
    logger.error({ runId: job?.data.runId, error: error.message }, 'run failed'),
  );
  const stopMaintenance = startMaintenance({
    sandbox,
    database,
    cloneRoot: settings.cloneRoot,
    log: (message, extra) => logger.warn(extra ?? {}, message),
  });
  logger.info({ concurrency: env.MAX_CONCURRENT_RUNS }, 'worker ready');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1); // second signal: stop now
    stopping = true;
    logger.info({ signal }, 'finishing the current run, then stopping');
    stopMaintenance();
    await worker.close();
    await queue.close();
    await database?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const known = error instanceof ConfigError || error instanceof GitHubConfigError;
  console.error(known ? (error as Error).message : error);
  process.exit(1);
});
