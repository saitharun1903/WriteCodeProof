import { LlmError } from './types.js';

/** Rate limited (429) or overloaded (503, Anthropic's 529): worth one more try. */
const RETRY_STATUSES = new Set([429, 503, 529]);
/** Wait before the retry when the API does not say how long. */
const DEFAULT_RETRY_WAIT_MS = 2_000;
/** Never wait longer than this for a retry, whatever Retry-After says. */
const MAX_RETRY_WAIT_MS = 30_000;

export interface PostOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  /** For tests: how to wait between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryWait(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_RETRY_WAIT_MS;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

/**
 * POST JSON and return the parsed reply, with readable errors for the usual
 * failures. A rate-limited or overloaded reply is retried once.
 */
export async function postJson<T>(
  provider: string,
  url: string,
  body: unknown,
  options: PostOptions,
): Promise<T> {
  const first = await send(provider, url, body, options);
  if (!RETRY_STATUSES.has(first.status)) return read<T>(provider, first);
  await (options.sleep ?? wait)(retryWait(first));
  return read<T>(provider, await send(provider, url, body, options));
}

async function send(
  provider: string,
  url: string,
  body: unknown,
  { headers = {}, timeoutMs }: PostOptions,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const name = (cause as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LlmError(`${provider} did not answer within ${Math.round(timeoutMs / 1000)}s`, {
        cause,
      });
    }
    throw new LlmError(`Cannot reach ${provider} at ${new URL(url).origin}`, { cause });
  }
  return res;
}

async function read<T>(provider: string, res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string | { message?: string } };
      const error = parsed.error;
      detail = typeof error === 'string' ? error : (error?.message ?? detail);
    } catch {
      // Not JSON; keep the raw text.
    }
    throw new LlmError(`${provider} returned ${res.status}: ${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new LlmError(`${provider} returned a reply that is not JSON`, { cause });
  }
}
