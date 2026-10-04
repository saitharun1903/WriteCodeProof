import { LlmError } from './types.js';

/** POST JSON and return the parsed reply, with readable errors for the usual failures. */
export async function postJson<T>(
  provider: string,
  url: string,
  body: unknown,
  { headers = {}, timeoutMs }: { headers?: Record<string, string>; timeoutMs: number },
): Promise<T> {
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
