import Fastify, { type FastifyInstance } from 'fastify';
import { readPackageVersion, type LogLevel } from '@writecode-proof/core';

export interface ServerOptions {
  logLevel: LogLevel;
}

export function buildServer({ logLevel }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel } });
  const version = readPackageVersion(import.meta.url);

  app.get('/health', async () => ({
    status: 'ok',
    version,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  return app;
}
