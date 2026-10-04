#!/usr/bin/env node
// Run every check on a repository and print the results.
// Stand-in until the `writecode-proof check` command lands in Phase 5.
//
// Usage: node scripts/proof.mjs <repo> [--base <ref>] [--head <ref>] [--no-llm] [--json]

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CachedProvider,
  createLlmProvider,
  defaultCacheDir,
  loadEnvFromFile,
  runProof,
  Sandbox,
  sandboxSettingsFromEnv,
} from '../packages/core/dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const repo = args.find(
  (a, i) => !a.startsWith('--') && !['--base', '--head'].includes(args[i - 1]),
);
if (!repo) {
  console.error(
    'Usage: node scripts/proof.mjs <repo> [--base <ref>] [--head <ref>] [--no-llm] [--json]',
  );
  process.exit(3);
}

const env = loadEnvFromFile(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const llm = args.includes('--no-llm')
  ? null
  : new CachedProvider(createLlmProvider(env), env.LLM_CACHE_DIR ?? defaultCacheDir());
const started = Date.now();
const run = await runProof({
  repoPath: resolve(repo),
  base: flag('--base'),
  head: flag('--head'),
  sandbox: new Sandbox(sandboxSettingsFromEnv(env)),
  llm,
  onProgress: (m) =>
    console.error(`  ${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s  ${m}`),
});

if (args.includes('--json')) {
  console.log(
    JSON.stringify(run, (k, v) => (k === 'oldSource' || k === 'newSource' ? undefined : v), 2),
  );
} else {
  const fns = run.changes.changedFunctions;
  console.log(
    `\nChanged ${fns.length} functions in ${new Set(fns.map((f) => f.file)).size} files.\n`,
  );
  for (const check of run.checks) {
    console.log(`${check.check.padEnd(16)} ${check.status.padEnd(8)} ${check.summary}`);
    for (const f of check.findings) console.log(`    [${f.severity}] ${f.title}`);
    for (const n of check.notes) console.log(`    note: ${n}`);
  }
  for (const n of run.notes) console.log(`note: ${n}`);
  if (llm)
    console.log(`\nLLM ${llm.name}/${llm.model}: ${llm.misses} calls, ${llm.hits} from cache`);
  console.log(`Done in ${(run.durationMs / 1000).toFixed(1)}s`);
}
