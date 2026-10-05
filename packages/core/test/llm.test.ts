import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AnthropicProvider,
  CachedProvider,
  completeJson,
  createLlmProvider,
  extractCode,
  extractJson,
  LlmError,
  LlmOutputError,
  loadEnv,
  OllamaProvider,
  OpenAiCompatibleProvider,
  postJson,
  type CompleteOptions,
  type LlmProvider,
} from '../src/index.js';

class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'test';
  readonly calls: CompleteOptions[] = [];
  constructor(private readonly replies: string[]) {}
  async complete(opts: CompleteOptions) {
    this.calls.push(opts);
    return this.replies.shift() ?? '';
  }
}

const settings = { model: 'm', timeoutMs: 1000, temperature: 0.2, maxTokens: 100 };

function mockFetch(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const sent = (fetch: ReturnType<typeof mockFetch>) => {
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('extractJson', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['Sure! Here you go:\n{"a": [1, 2]}\nHope that helps.', { a: [1, 2] }],
    ['[[1], [2]]', [[1], [2]]],
  ])('%s', (input, expected) => expect(extractJson(input)).toEqual(expected));

  it('throws when there is no JSON', () => expect(() => extractJson('no idea')).toThrow());
});

describe('extractCode', () => {
  it('takes the first fenced block', () => {
    expect(extractCode('Here:\n```js\ntest(1)\n```\nand ```py\nx\n```')).toBe('test(1)');
  });
  it('falls back to the whole reply', () => expect(extractCode('  test(1)  ')).toBe('test(1)'));
});

describe('completeJson', () => {
  const schema = z.object({ inputs: z.array(z.array(z.unknown())) });

  it('validates the reply', async () => {
    const llm = new ScriptedProvider(['{"inputs": [[1]]}']);
    expect(await completeJson(llm, { system: 's', prompt: 'p' }, schema)).toEqual({
      inputs: [[1]],
    });
    expect(llm.calls[0]!.json).toBe(true);
  });

  it('retries once with the error, then gives up', async () => {
    const good = new ScriptedProvider(['{"wrong": 1}', '{"inputs": []}']);
    expect(await completeJson(good, { system: 's', prompt: 'p' }, schema)).toEqual({ inputs: [] });
    expect(good.calls[1]!.prompt).toContain('could not be used');

    const bad = new ScriptedProvider(['nope', 'still nope']);
    await expect(completeJson(bad, { system: 's', prompt: 'p' }, schema)).rejects.toBeInstanceOf(
      LlmOutputError,
    );
  });
});

describe('CachedProvider', () => {
  it('answers repeated requests from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcp-llm-'));
    try {
      const inner = new ScriptedProvider(['first', 'second']);
      const cached = new CachedProvider(inner, dir);
      const opts = { system: 's', prompt: 'p' };
      expect(await cached.complete(opts)).toBe('first');
      expect(await cached.complete(opts)).toBe('first');
      expect(await cached.complete({ ...opts, prompt: 'other' })).toBe('second');
      expect([cached.hits, cached.misses, inner.calls.length]).toEqual([1, 2, 2]);
      expect(readdirSync(dir)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('providers', () => {
  it('ollama: sends a chat request in JSON mode', async () => {
    const fetch = mockFetch(200, { message: { content: '{"ok":true}' } });
    const reply = await new OllamaProvider('http://ollama:11434/', settings).complete({
      system: 'S',
      prompt: 'P',
      json: true,
    });
    expect(reply).toBe('{"ok":true}');
    const { url, body } = sent(fetch);
    expect(url).toBe('http://ollama:11434/api/chat');
    expect(body).toMatchObject({
      model: 'm',
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'P' },
      ],
      options: { temperature: 0.2, num_predict: 100 },
    });
  });

  it('ollama: explains a missing model', async () => {
    mockFetch(404, { error: "model 'm' not found" });
    await expect(
      new OllamaProvider('http://ollama:11434', settings).complete({ system: '', prompt: '' }),
    ).rejects.toThrow('ollama pull m');
  });

  it('ollama: explains when it is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(
      new OllamaProvider('http://ollama:11434', settings).complete({ system: '', prompt: '' }),
    ).rejects.toThrow(/Is Ollama running/);
  });

  it('openai-compatible: bearer auth and json_object', async () => {
    const fetch = mockFetch(200, { choices: [{ message: { content: 'hi' } }] });
    const llm = new OpenAiCompatibleProvider('https://api.example.com/v1', 'key-1', settings);
    expect(await llm.complete({ system: 'S', prompt: 'P', json: true })).toBe('hi');
    const { url, headers, body } = sent(fetch);
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(headers.authorization).toBe('Bearer key-1');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('anthropic: messages API with version header', async () => {
    const fetch = mockFetch(200, { content: [{ type: 'text', text: 'hello' }] });
    const llm = new AnthropicProvider('https://api.anthropic.com', 'key-2', settings);
    expect(await llm.complete({ system: 'S', prompt: 'P' })).toBe('hello');
    const { url, headers, body } = sent(fetch);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('key-2');
    expect(headers['anthropic-version']).toBeTruthy();
    expect(body).toMatchObject({ system: 'S', messages: [{ role: 'user', content: 'P' }] });
  });

  it('surfaces API errors with their message', async () => {
    mockFetch(401, { error: { message: 'invalid x-api-key' } });
    const llm = new AnthropicProvider('https://api.anthropic.com', 'bad', settings);
    await expect(llm.complete({ system: '', prompt: '' })).rejects.toThrow(
      new LlmError('Anthropic API returned 401: invalid x-api-key'),
    );
  });

  it('createLlmProvider picks the configured provider', () => {
    expect(createLlmProvider(loadEnv({})).name).toBe('ollama');
    expect(createLlmProvider(loadEnv({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' })).name).toBe(
      'anthropic',
    );
    expect(createLlmProvider(loadEnv({}), 'ollama').model).toBe(loadEnv({}).LLM_MODEL);
  });
});

describe('rate limits', () => {
  it('retries once after a 429, waiting as long as the API asks', async () => {
    const replies = [
      new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '3' } }),
      new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => replies.shift()!),
    );
    const waits: number[] = [];
    const reply = await postJson<{ message: { content: string } }>(
      'Ollama',
      'http://x/api',
      {},
      {
        timeoutMs: 1000,
        sleep: async (ms) => void waits.push(ms),
      },
    );
    expect(reply.message.content).toBe('ok');
    expect(waits).toEqual([3000]);
  });

  it('gives up after the retry with the API message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"Overloaded"}}', { status: 529 })),
    );
    await expect(
      postJson('Anthropic API', 'http://x', {}, { timeoutMs: 1000, sleep: async () => undefined }),
    ).rejects.toThrow('Anthropic API returned 529: Overloaded');
  });

  it('caps a very long Retry-After', async () => {
    const replies = [
      new Response('', { status: 503, headers: { 'retry-after': '3600' } }),
      new Response('{}', { status: 200 }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => replies.shift()!),
    );
    const waits: number[] = [];
    await postJson(
      'API',
      'http://x',
      {},
      { timeoutMs: 1000, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits[0]).toBeLessThanOrEqual(30_000);
  });
});
