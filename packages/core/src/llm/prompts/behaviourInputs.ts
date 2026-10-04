import { z } from 'zod';

/** Bump when the prompt text changes, so cached replies are not reused. */
export const BEHAVIOUR_INPUTS_PROMPT_VERSION = 'behaviour-inputs/1';

export const behaviourInputsSchema = z.object({
  inputs: z.array(z.array(z.unknown())),
});

export interface BehaviourInputsPromptArgs {
  language: string;
  signature: string;
  params: string[];
  hasRest: boolean;
  oldSource: string;
  newSource: string;
  count: number;
}

export function behaviourInputsPrompt(args: BehaviourInputsPromptArgs) {
  const fence = args.language === 'python' ? 'python' : 'js';
  const arity = args.hasRest
    ? `at least ${args.params.length - 1} values; extra values go to the last (rest) parameter`
    : `exactly ${args.params.length} value${args.params.length === 1 ? '' : 's'}, one per parameter`;

  const system = `You choose test inputs for ${args.language} functions. Reply with JSON only. [${BEHAVIOUR_INPUTS_PROMPT_VERSION}]`;
  const prompt = `Below are two versions of one function: BEFORE and AFTER a code change.

List ${args.count} different argument lists to call it with. Pick inputs most likely to make the two versions behave differently: boundaries, empty values, zero, negative numbers, rounding edges (like 1.005 or 2.999), very large values, and a few ordinary values. Use realistic shapes for objects the code reads (look at which properties it uses).

Function: ${args.signature}
Parameters, in order: ${args.params.join(', ') || '(none)'}

BEFORE:
\`\`\`${fence}
${args.oldSource}
\`\`\`

AFTER:
\`\`\`${fence}
${args.newSource}
\`\`\`

Reply with exactly this JSON shape:
{"inputs": [[arg1, arg2], [arg1, arg2]]}
Each inner list holds ${arity}. Use plain JSON values only: numbers, strings, booleans, null, arrays and objects.`;

  return { system, prompt };
}
