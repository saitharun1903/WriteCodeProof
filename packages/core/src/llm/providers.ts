import type { Env } from '../config/env.js';
import { DEFAULTS } from '../config/defaults.js';
import { postJson } from './http.js';
import { LlmError, type CompleteOptions, type LlmProvider } from './types.js';

export interface ProviderSettings {
  model: string;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly model: string;

  constructor(
    private readonly baseUrl: string,
    private readonly settings: ProviderSettings,
  ) {
    this.model = settings.model;
  }

  async complete({ system, prompt, maxTokens, json }: CompleteOptions): Promise<string> {
    try {
      const reply = await postJson<{ message?: { content?: string } }>(
        'Ollama',
        `${trimSlash(this.baseUrl)}/api/chat`,
        {
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          ...(json ? { format: 'json' } : {}),
          options: {
            temperature: this.settings.temperature,
            num_predict: maxTokens ?? this.settings.maxTokens,
          },
        },
        { timeoutMs: this.settings.timeoutMs },
      );
      return reply.message?.content ?? '';
    } catch (error) {
      if (error instanceof LlmError && /not found/i.test(error.message)) {
        throw new LlmError(`Ollama has no model "${this.model}". Run: ollama pull ${this.model}`, {
          cause: error,
        });
      }
      if (error instanceof LlmError && /Cannot reach/.test(error.message)) {
        throw new LlmError(`${error.message}. Is Ollama running?`, { cause: error });
      }
      throw error;
    }
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  readonly model: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly settings: ProviderSettings,
  ) {
    this.model = settings.model;
  }

  async complete({ system, prompt, maxTokens, json }: CompleteOptions): Promise<string> {
    const reply = await postJson<{ choices?: { message?: { content?: string } }[] }>(
      'LLM API',
      `${trimSlash(this.baseUrl)}/chat/completions`,
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: this.settings.temperature,
        max_tokens: maxTokens ?? this.settings.maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      },
      {
        headers: { authorization: `Bearer ${this.apiKey}` },
        timeoutMs: this.settings.timeoutMs,
      },
    );
    return reply.choices?.[0]?.message?.content ?? '';
  }
}

const ANTHROPIC_API_VERSION = '2023-06-01';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly settings: ProviderSettings,
  ) {
    this.model = settings.model;
  }

  async complete({ system, prompt, maxTokens }: CompleteOptions): Promise<string> {
    const reply = await postJson<{ content?: { type: string; text?: string }[] }>(
      'Anthropic API',
      `${trimSlash(this.baseUrl)}/v1/messages`,
      {
        model: this.model,
        system,
        max_tokens: maxTokens ?? this.settings.maxTokens,
        temperature: this.settings.temperature,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
        timeoutMs: this.settings.timeoutMs,
      },
    );
    return (reply.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }
}

/** Build the provider selected by `LLM_PROVIDER`. `override` comes from the CLI `--provider` flag. */
export function createLlmProvider(env: Env, override?: Env['LLM_PROVIDER']): LlmProvider {
  const provider = override ?? env.LLM_PROVIDER;
  const settings: ProviderSettings = {
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_S * 1000,
    temperature: env.LLM_TEMPERATURE,
    maxTokens: env.LLM_MAX_TOKENS,
  };
  switch (provider) {
    case 'ollama':
      return new OllamaProvider(env.OLLAMA_URL, settings);
    case 'openai-compatible':
      if (!env.LLM_BASE_URL || !env.LLM_API_KEY) {
        throw new LlmError('openai-compatible needs LLM_BASE_URL and LLM_API_KEY');
      }
      return new OpenAiCompatibleProvider(env.LLM_BASE_URL, env.LLM_API_KEY, settings);
    case 'anthropic':
      if (!env.LLM_API_KEY) throw new LlmError('anthropic needs LLM_API_KEY');
      return new AnthropicProvider(
        env.LLM_BASE_URL ?? DEFAULTS.ANTHROPIC_URL,
        env.LLM_API_KEY,
        settings,
      );
  }
}
