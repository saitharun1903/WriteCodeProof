import type { z } from 'zod';
import { LlmOutputError, type LlmProvider } from './types.js';

/** Pull a JSON value out of a reply that may be wrapped in prose or a ``` fence. */
export function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(reply);
  const text = (fenced ? fenced[1]! : reply).trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to bracket matching.
  }
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in reply');
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error('no complete JSON value in reply');
  return JSON.parse(text.slice(start, end + 1));
}

/** Pull the first fenced code block out of a reply, or the whole reply if there is none. */
export function extractCode(reply: string): string {
  const fenced = /```[\w+-]*[^\S\n]*\n([\s\S]*?)```/.exec(reply);
  return (fenced ? fenced[1]! : reply).trim();
}

const describeIssue = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 500) : String(error);

/**
 * Ask for JSON matching `schema`. If the reply does not parse or validate,
 * ask once more with the error; spec section 10 allows one retry.
 */
export async function completeJson<S extends z.ZodType>(
  llm: LlmProvider,
  opts: { system: string; prompt: string; maxTokens?: number },
  schema: S,
): Promise<z.infer<S>> {
  let reply = await llm.complete({ ...opts, json: true });
  try {
    return schema.parse(extractJson(reply));
  } catch (firstError) {
    const retryPrompt = `${opts.prompt}\n\nYour previous reply could not be used (${describeIssue(firstError)}). Reply with valid JSON only, in exactly the format described.`;
    reply = await llm.complete({ ...opts, prompt: retryPrompt, json: true });
    try {
      return schema.parse(extractJson(reply));
    } catch (secondError) {
      throw new LlmOutputError(`LLM reply was not usable: ${describeIssue(secondError)}`, reply);
    }
  }
}
