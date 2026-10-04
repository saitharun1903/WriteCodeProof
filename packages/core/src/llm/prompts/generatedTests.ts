/** Bump when the prompt text changes, so cached replies are not reused. */
export const GENERATED_TESTS_PROMPT_VERSION = 'generated-tests/2';

export interface GeneratedTestsPromptArgs {
  language: 'javascript' | 'typescript' | 'python';
  /** e.g. "function `cheapestItem`" or "method `add` of class `Cart`". */
  subject: string;
  /** Lines the harness puts at the top of the test file. */
  preamble: string[];
  /** Name(s) the tests must use; never redefined. */
  importedName: string;
  /** Import statements of the module under test, for context. */
  moduleImports: string[];
  source: string;
}

export function generatedTestsPrompt(args: GeneratedTestsPromptArgs) {
  const python = args.language === 'python';
  const fence = python ? 'python' : args.language === 'typescript' ? 'ts' : 'js';
  const framework = python
    ? 'pytest. Write plain `def test_...():` functions and use `assert` and `pytest.raises`'
    : "Node's built-in test runner. Write `test('...', () => { ... })` cases and use `assert` (node:assert/strict)";
  const caseWord = python ? '`def test_...` functions' : '`test(...)` cases';

  const system = `You are a careful engineer writing unit tests. Reply with one code block of test code and nothing else. [${GENERATED_TESTS_PROMPT_VERSION}]`;
  const prompt = `Write unit tests for the ${args.subject} below, using ${framework}.

The test file already starts with these lines. Do not repeat them and do not add other imports of the module under test:
${args.preamble.map((line) => `    ${line}`).join('\n')}

Rules:
- Write 4 to 6 short ${caseWord}, each named after the behaviour it checks.
- Cover a normal case, empty or missing input (empty list, empty string, ${python ? 'None' : 'null, undefined'}), boundary values, and invalid input.
- Assert what a correct implementation should do, judging from the name, parameters and code. If the code looks wrong for an input, still assert the correct result.
- No other libraries, no network, no files, no sleeping, no randomness.
- Do not redefine, patch or mock \`${args.importedName}\`.

Imports used by the module, for context:
${args.moduleImports.length ? args.moduleImports.join('\n') : '(none)'}

Code under test:
\`\`\`${fence}
${args.source}
\`\`\`

Reply with a single \`\`\`${fence} code block.`;

  return { system, prompt };
}
