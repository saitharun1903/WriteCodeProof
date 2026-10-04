#!/usr/bin/env node
// Remove cached dependency volumes and cached LLM replies.
//
// Usage: node scripts/clear-cache.mjs [--deps] [--llm]   (default: both)

import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultCacheDir,
  loadEnvFromFile,
  SANDBOX_LABEL,
  Sandbox,
  sandboxSettingsFromEnv,
} from '../packages/core/dist/index.js';

const USAGE = 'Usage: node scripts/clear-cache.mjs [--deps] [--llm]   (default: both)';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== '--deps' && a !== '--llm');
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(' ')}\n${USAGE}`);
  process.exit(1);
}
const all = args.length === 0;
const env = loadEnvFromFile(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

if (all || args.includes('--deps')) {
  const { docker } = new Sandbox(sandboxSettingsFromEnv(env));
  const { Volumes = [] } = await docker.listVolumes({
    filters: { label: [`${SANDBOX_LABEL}=deps`] },
  });
  for (const volume of Volumes) {
    await docker.getVolume(volume.Name).remove();
    console.log(`removed volume ${volume.Name}`);
  }
  if (Volumes.length === 0) console.log('no dependency volumes');
}

if (all || args.includes('--llm')) {
  const dir = env.LLM_CACHE_DIR ?? defaultCacheDir();
  await rm(dir, { recursive: true, force: true });
  console.log(`cleared ${dir}`);
}
