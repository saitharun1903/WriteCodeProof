#!/usr/bin/env node
// Build the sandbox images from sandbox-images/<name>/Dockerfile.
// Image names come from SANDBOX_IMAGE_* in .env (or the defaults).
//
// Usage: node scripts/build-images.mjs [node] [python] [tools]   (default: all)

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFromFile, sandboxSettingsFromEnv } from '../packages/core/dist/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { images } = sandboxSettingsFromEnv(loadEnvFromFile(repoRoot));

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(images);

for (const name of names) {
  const tag = images[name];
  if (!tag) {
    console.error(`Unknown image "${name}". Choose from: ${Object.keys(images).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n==> Building ${tag} from sandbox-images/${name}`);
  const result = spawnSync(
    'docker',
    ['build', '--pull', '--tag', tag, join(repoRoot, 'sandbox-images', name)],
    { stdio: 'inherit' },
  );
  if (result.error) {
    console.error(`Could not run docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('\nSandbox images ready.');
