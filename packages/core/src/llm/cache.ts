import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompleteOptions, LlmProvider } from './types.js';

const APP_FOLDER = 'writecode-proof';

/** Per-user cache folder: %LOCALAPPDATA% on Windows, $XDG_CACHE_HOME or ~/.cache elsewhere. */
export function defaultCacheDir(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, APP_FOLDER, 'llm');
}

/**
 * Wraps a provider so identical requests are answered from disk. The key is
 * a hash of provider, model, both prompts and the JSON flag; prompts carry
 * their own version string, so editing a prompt invalidates old entries.
 */
export class CachedProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  hits = 0;
  misses = 0;

  constructor(
    private readonly inner: LlmProvider,
    private readonly dir: string,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  private key(opts: CompleteOptions): string {
    return createHash('sha256')
      .update(
        JSON.stringify([this.inner.name, this.inner.model, opts.system, opts.prompt, !!opts.json]),
      )
      .digest('hex');
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const file = join(this.dir, `${this.key(opts)}.txt`);
    try {
      const cached = await readFile(file, 'utf8');
      this.hits++;
      return cached;
    } catch {
      // Not cached yet.
    }
    this.misses++;
    const reply = await this.inner.complete(opts);
    await this.store(file, reply).catch(() => undefined);
    return reply;
  }

  /** Called by callers that found a cached reply unusable, so it is not served again. */
  async forget(opts: CompleteOptions): Promise<void> {
    await writeFile(join(this.dir, `${this.key(opts)}.txt`), '').catch(() => undefined);
  }

  private async store(file: string, reply: string): Promise<void> {
    if (!reply.trim()) return;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, reply, 'utf8');
    await rename(tmp, file);
  }
}
