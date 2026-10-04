#!/usr/bin/env node
// Local GitHub App setup: API + worker + smee.io relay, one terminal.
// Usage: npm run dev   (builds first)

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SmeeClient from 'smee-client';
import { loadEnvFromFile } from '../packages/core/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnvFromFile(root);
const children = [];

function start(name, script) {
  const child = spawn(process.execPath, [join(root, script)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}] `;
  const relay = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    stopAll(code ?? 1);
  });
  children.push(child);
}

let smee;
function stopAll(code) {
  smee?.stop().catch(() => undefined);
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exitCode = code;
}

start('api', 'packages/api/dist/index.js');
start('worker', 'packages/worker/dist/main.js');

if (env.WEBHOOK_PROXY_URL) {
  const target = `http://${env.HOST}:${env.PORT}/webhook`;
  smee = new SmeeClient({
    source: env.WEBHOOK_PROXY_URL,
    target,
    logger: {
      info: (...a) => console.log('[smee]', ...a),
      error: (...a) => console.error('[smee]', ...a),
    },
  });
  await smee.start();
} else {
  console.log('[smee] WEBHOOK_PROXY_URL not set: webhooks will not be forwarded');
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
