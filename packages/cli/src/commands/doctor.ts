import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import pc from 'picocolors';
import {
  ConfigError,
  loadEnvFromFile,
  Sandbox,
  sandboxSettingsFromEnv,
  type Env,
} from '@writecode-proof/core';
import { EXIT } from '../exitCodes.js';

const exec = promisify(execFile);

type Level = 'ok' | 'warn' | 'fail';
interface Result {
  level: Level;
  name: string;
  detail: string;
  hint?: string;
}

const ICON: Record<Level, string> = { ok: pc.green('✔'), warn: pc.yellow('!'), fail: pc.red('✖') };

/** Minimum Node version, read from this package's `engines` field. */
function requiredNode(): string | null {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    engines?: { node?: string };
  };
  return /(\d+(?:\.\d+){0,2})/.exec(pkg.engines?.node ?? '')?.[1] ?? null;
}

function atLeast(actual: string, wanted: string): boolean {
  const a = actual.split('.').map(Number);
  const w = wanted.split('.').map(Number);
  for (let i = 0; i < w.length; i++) {
    if ((a[i] ?? 0) !== w[i]) return (a[i] ?? 0) > (w[i] ?? 0);
  }
  return true;
}

async function checkNode(): Promise<Result> {
  const wanted = requiredNode();
  const actual = process.versions.node;
  if (wanted && !atLeast(actual, wanted)) {
    return {
      level: 'fail',
      name: 'Node.js',
      detail: actual,
      hint: `Install Node.js ${wanted} or newer.`,
    };
  }
  return { level: 'ok', name: 'Node.js', detail: actual };
}

async function checkGit(): Promise<Result> {
  try {
    const { stdout } = await exec('git', ['--version'], { windowsHide: true });
    return { level: 'ok', name: 'git', detail: stdout.trim().replace(/^git version /, '') };
  } catch {
    return {
      level: 'fail',
      name: 'git',
      detail: 'not found',
      hint: 'Install Git and make sure it is on PATH.',
    };
  }
}

async function checkDocker(env: Env): Promise<Result[]> {
  const sandbox = new Sandbox(sandboxSettingsFromEnv(env));
  try {
    await sandbox.ping();
    const version = (await sandbox.docker.version()).Version;
    const results: Result[] = [{ level: 'ok', name: 'Docker', detail: version }];
    for (const [name, image] of Object.entries(sandbox.settings.images)) {
      const present = await sandbox.hasImage(image);
      results.push(
        present
          ? { level: 'ok', name: `Image (${name})`, detail: image }
          : {
              level: 'fail',
              name: `Image (${name})`,
              detail: `${image} missing`,
              hint: 'Run: npm run build:images',
            },
      );
    }
    return results;
  } catch {
    return [
      { level: 'fail', name: 'Docker', detail: 'not reachable', hint: 'Start Docker Desktop.' },
    ];
  }
}

async function checkLlm(env: Env): Promise<Result> {
  const name = `LLM (${env.LLM_PROVIDER})`;
  if (env.LLM_PROVIDER !== 'ollama') {
    // A test request would cost money; only check it is configured.
    return { level: 'ok', name, detail: `${env.LLM_MODEL}, API key set` };
  }
  try {
    const res = await fetch(`${env.OLLAMA_URL.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    const { models = [] } = (await res.json()) as { models?: { name: string }[] };
    const wanted = env.LLM_MODEL.includes(':') ? env.LLM_MODEL : `${env.LLM_MODEL}:latest`;
    if (!models.some((m) => m.name === wanted)) {
      return {
        level: 'warn',
        name,
        detail: `model ${env.LLM_MODEL} not pulled`,
        hint: `Run: ollama pull ${env.LLM_MODEL}  (or use --no-llm)`,
      };
    }
    return { level: 'ok', name, detail: `${env.LLM_MODEL} at ${env.OLLAMA_URL}` };
  } catch {
    return {
      level: 'warn',
      name,
      detail: `not reachable at ${env.OLLAMA_URL}`,
      hint: 'Start Ollama, or run checks with --no-llm.',
    };
  }
}

/** `writecode-proof doctor`: checks Docker, git and LLM reachability. Returns the exit code. */
export async function doctorCommand(): Promise<number> {
  const results: Result[] = [await checkNode(), await checkGit()];
  let env: Env | null = null;
  try {
    env = loadEnvFromFile();
    results.push({ level: 'ok', name: 'Settings', detail: 'valid' });
  } catch (error) {
    const detail = error instanceof ConfigError ? error.issues.join('; ') : String(error);
    results.push({ level: 'fail', name: 'Settings', detail, hint: 'Fix the values in .env' });
  }
  if (env) results.push(...(await checkDocker(env)), await checkLlm(env));

  const width = Math.max(...results.map((r) => r.name.length)) + 2;
  for (const r of results) {
    process.stdout.write(`${ICON[r.level]} ${r.name.padEnd(width)}${r.detail}\n`);
    if (r.hint && r.level !== 'ok')
      process.stdout.write(pc.dim(`  ${' '.repeat(width)}${r.hint}\n`));
  }
  const failed = results.some((r) => r.level === 'fail');
  process.stdout.write(failed ? pc.red('\nNot ready.\n') : pc.green('\nReady.\n'));
  return failed ? EXIT.toolError : EXIT.ok;
}
