import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Env } from '@writecode-proof/core';

export interface GitHubSettings {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  apiUrl: string;
  aiLabel: string;
  cloneDepth: number;
  cloneRoot: string;
}

export class GitHubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubConfigError';
  }
}

/** Folder name used under the OS temp dir when `CLONE_ROOT` is blank. */
const CLONE_FOLDER = 'writecode-proof-clones';

/** Read the GitHub App settings; throws a readable error naming what is missing. */
export async function githubSettingsFromEnv(
  env: Env,
  baseDir = process.cwd(),
): Promise<GitHubSettings> {
  const missing = (
    ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY_PATH', 'GITHUB_WEBHOOK_SECRET'] as const
  ).filter((key) => !env[key]);
  if (missing.length) {
    throw new GitHubConfigError(`GitHub App is not configured: set ${missing.join(', ')} in .env`);
  }
  const keyPath = resolve(baseDir, env.GITHUB_PRIVATE_KEY_PATH!);
  const privateKey = await readFile(keyPath, 'utf8').catch(() => {
    throw new GitHubConfigError(`GitHub App private key not found at ${keyPath}`);
  });
  if (!privateKey.includes('PRIVATE KEY')) {
    throw new GitHubConfigError(`${keyPath} does not look like a PEM private key`);
  }
  return {
    appId: env.GITHUB_APP_ID!,
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET!,
    apiUrl: env.GITHUB_API_URL,
    aiLabel: env.GITHUB_AI_LABEL,
    cloneDepth: env.CLONE_DEPTH,
    cloneRoot: resolve(env.CLONE_ROOT ?? join(tmpdir(), CLONE_FOLDER)),
  };
}
