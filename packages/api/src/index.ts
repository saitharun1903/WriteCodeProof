import { ConfigError, loadEnvFromFile } from '@writecode-proof/core';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = loadEnvFromFile();
  const app = buildServer({ logLevel: env.LOG_LEVEL });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
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
