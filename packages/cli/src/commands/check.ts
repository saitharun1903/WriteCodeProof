import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import pc from 'picocolors';
import {
  CachedProvider,
  createLlmProvider,
  defaultCacheDir,
  loadEnvFromFile,
  loadRepoConfig,
  renderMarkdown,
  repoRoot,
  riskInputFromRun,
  runProof,
  Sandbox,
  sandboxSettingsFromEnv,
  scoreRisk,
  toJsonReport,
  type Env,
} from '@writecode-proof/core';
import { exitCodeFor } from '../exitCodes.js';
import { renderTerminal } from '../render.js';

export interface CheckOptions {
  base?: string;
  head?: string;
  json?: boolean;
  out?: string;
  generate: boolean;
  llm: boolean;
  provider?: Env['LLM_PROVIDER'];
  aiAuthored?: boolean;
  quiet?: boolean;
}

/** `writecode-proof check [path]`: returns the process exit code. */
export async function checkCommand(
  path: string | undefined,
  options: CheckOptions,
): Promise<number> {
  const started = Date.now();
  const progress = (message: string) => {
    if (options.quiet) return;
    const elapsed = `${Math.round((Date.now() - started) / 1000)}s`.padStart(5);
    process.stderr.write(pc.dim(`${elapsed}  ${message}\n`));
  };

  const env = loadEnvFromFile();
  const target = resolve(path ?? '.');
  const root = await repoRoot(target).catch((error: unknown) => {
    // examples/<name> holds base/ and pr/ snapshots, not a repository.
    if (existsSync(join(target, 'base')) && existsSync(join(target, 'pr'))) {
      const name = basename(target);
      throw new Error(
        `${path} is a sample with base/ and pr/ folders, not a git repository. ` +
          `Run "npm run examples", then check .examples/${name}`,
      );
    }
    throw error;
  });
  const loaded = await loadRepoConfig(root);
  if (loaded.error) process.stderr.write(pc.yellow(`warning: ${loaded.error}\n`));

  const llm = options.llm
    ? new CachedProvider(
        createLlmProvider(env, options.provider),
        env.LLM_CACHE_DIR ?? defaultCacheDir(),
      )
    : null;

  const run = await runProof({
    repoPath: root,
    base: options.base,
    head: options.head,
    sandbox: new Sandbox(sandboxSettingsFromEnv(env)),
    llm,
    generateTests: options.generate,
    config: loaded.config,
    onProgress: progress,
  });
  if (loaded.error) run.notes.push(loaded.error);

  const risk = scoreRisk(riskInputFromRun(run, options.aiAuthored ?? false), loaded.config.policy);
  const report = { run, risk };

  if (options.out) {
    const file = resolve(options.out);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, renderMarkdown(report));
    progress(`Report written to ${file}`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(toJsonReport(report), null, 2)}\n`);
  } else {
    const model = llm
      ? ` · ${llm.name}/${llm.model} (${llm.misses} calls, ${llm.hits} cached)`
      : '';
    process.stdout.write(renderTerminal(report, model));
  }
  return exitCodeFor(risk.band);
}
