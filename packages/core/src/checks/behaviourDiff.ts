import { writeFile } from 'node:fs/promises';
import { CHECK_DEFAULTS } from '../config/defaults.js';
import { completeJson } from '../llm/json.js';
import { behaviourInputsPrompt, behaviourInputsSchema } from '../llm/prompts/behaviourInputs.js';
import type { LlmProvider } from '../llm/types.js';
import type { ChangedFunction, CheckResult, Finding } from '../types.js';
import { SCRATCH, type RunContext, type Side } from '../workspace/context.js';
import { plural, readOptional, runCheck, stepFailure } from './common.js';
import { compareOutcomes, describeChange, exampleRank, type Outcome } from './outcomes.js';

export interface BehaviourOptions {
  llm: LlmProvider | null;
  llmInputs?: number;
  maxInputs?: number;
  callTimeoutMs?: number;
}

interface Target {
  id: string;
  fn: ChangedFunction;
  exportName: string;
  inputs: unknown[][];
}

interface HarnessOutput {
  results: { id: string; loadError: string | null; calls: (Outcome | null)[] }[];
}

const UNDEFINED = { $undefined: true };
/** Generic edge cases tried for every function, alongside the LLM's inputs. */
// Ordered so the first failing example shown is the plainest one.
const EDGE_VALUES: unknown[] = [
  [],
  0,
  1,
  -1,
  0.5,
  1.005,
  1.999,
  100,
  1e9,
  null,
  UNDEFINED,
  '',
  'a',
  'Hello World',
  [1, 2, 3],
  [{}],
  {},
  true,
  false,
];
const NUMBER_GRID = [0, 1, 19.99, 100];
const SECOND_GRID = [0, 1, 50, 100, -1, 101];
const MAX_EXAMPLES = 5;

const isRest = (p: string) => p.startsWith('...') || /^\*[^*]/.test(p);
const isKwargs = (p: string) => p.startsWith('**');

/** Parameters a caller passes positionally (drops self/cls, *args, **kwargs, `this:`). */
export function positionalParams(fn: ChangedFunction): string[] {
  return fn.params.filter((p) => {
    const name = p.split(/[:=]/)[0]!.trim();
    if (fn.language === 'python')
      return (
        !isRest(p) && !isKwargs(p) && p !== '*' && p !== '/' && !['self', 'cls'].includes(name)
      );
    return !isRest(p) && name !== 'this';
  });
}

/** Edge-case argument lists that need no LLM. */
export function edgeCaseInputs(arity: number, python: boolean): unknown[][] {
  const values = python ? EDGE_VALUES.filter((v) => v !== UNDEFINED) : EDGE_VALUES;
  if (arity === 0) return [[]];
  const inputs = values.map((v) => Array.from({ length: arity }, () => v));
  if (arity >= 2) {
    for (const a of NUMBER_GRID) {
      for (const b of SECOND_GRID)
        inputs.push([a, b, ...Array.from({ length: arity - 2 }, () => 0)]);
    }
  }
  return inputs;
}

function eligible(fn: ChangedFunction): string | null {
  if (fn.status !== 'modified') return null;
  if (fn.kind === 'method' || fn.qualifiedName.includes('.')) return 'methods need an instance';
  if (fn.language === 'tsx') return 'TSX is not run directly';
  if (fn.language !== 'python' && !fn.exported) return 'not exported';
  if (fn.qualifiedName.includes('#')) return 'defined more than once';
  return '';
}

async function chooseInputs(
  fn: ChangedFunction,
  options: BehaviourOptions,
  notes: string[],
): Promise<unknown[][]> {
  const params = positionalParams(fn);
  const hasRest = fn.params.some(isRest);
  const max = options.maxInputs ?? CHECK_DEFAULTS.BEHAVIOUR_MAX_INPUTS;
  const fromLlm: unknown[][] = [];

  if (options.llm) {
    try {
      const { system, prompt } = behaviourInputsPrompt({
        language: fn.language,
        signature: fn.signature,
        params: fn.params,
        hasRest,
        oldSource: fn.oldSource!,
        newSource: fn.newSource!,
        count: options.llmInputs ?? CHECK_DEFAULTS.BEHAVIOUR_LLM_INPUTS,
      });
      const reply = await completeJson(options.llm, { system, prompt }, behaviourInputsSchema);
      fromLlm.push(
        ...reply.inputs.filter((args) => (hasRest ? true : args.length <= params.length)),
      );
    } catch (error) {
      notes.push(
        `${fn.name}: LLM inputs unavailable (${(error as Error).message}); used edge cases only.`,
      );
    }
  }

  const seen = new Set<string>();
  const inputs: unknown[][] = [];
  for (const args of [...fromLlm, ...edgeCaseInputs(params.length, fn.language === 'python')]) {
    const key = JSON.stringify(args);
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push(args);
    if (inputs.length >= max) break;
  }
  return inputs;
}

async function runSide(
  ctx: RunContext,
  side: Side,
  toolchain: 'node' | 'python',
  targets: Target[],
  options: BehaviourOptions,
): Promise<[HarnessOutput | null, HarnessOutput | null, string | null]> {
  const planName = `behaviour-${toolchain}-${side}.json`;
  const plan = {
    root: ctx.containerPath(side),
    frozenTime: CHECK_DEFAULTS.FROZEN_TIME_ISO,
    seed: CHECK_DEFAULTS.RANDOM_SEED,
    callTimeoutMs: options.callTimeoutMs ?? CHECK_DEFAULTS.CALL_TIMEOUT_MS,
    maxMessageChars: CHECK_DEFAULTS.MAX_MESSAGE_CHARS,
    targets: targets.map((t) => ({
      id: t.id,
      file: side === 'base' ? (t.fn.oldFile ?? t.fn.file) : t.fn.file,
      exportName: t.exportName,
      inputs: t.inputs,
    })),
  };
  await writeFile(ctx.hostPath(SCRATCH, planName), JSON.stringify(plan));

  const harness =
    toolchain === 'python'
      ? `python ${ctx.containerPath(SCRATCH, 'harness', 'behaviour.py')}`
      : `node ${ctx.containerPath(SCRATCH, 'harness', 'behaviour.mjs')}`;
  const out = (n: number) => ctx.containerPath(SCRATCH, `behaviour-${toolchain}-${side}-${n}.json`);
  const planPath = ctx.containerPath(SCRATCH, planName);
  // Two fresh processes: anything that differs between them is nondeterministic.
  const result = await ctx.step(side, toolchain, [
    'sh',
    '-c',
    `${harness} ${planPath} ${out(1)}; ${harness} ${planPath} ${out(2)}`,
  ]);

  const read = async (n: number) => {
    const raw = await readOptional(
      ctx.hostPath(SCRATCH, `behaviour-${toolchain}-${side}-${n}.json`),
    );
    return raw ? (JSON.parse(raw) as HarnessOutput) : null;
  };
  const [first, second] = [await read(1), await read(2)];
  return [first, second, first ? null : stepFailure(result)];
}

export interface BehaviourPlan {
  targets: Target[];
  notes: string[];
}

/**
 * Pick the functions to compare and their inputs. Split out so the LLM part
 * can run while other checks use the sandbox.
 */
export async function planBehaviourDiff(
  ctx: RunContext,
  options: BehaviourOptions,
): Promise<BehaviourPlan> {
  const targets: Target[] = [];
  const notes: string[] = [];
  for (const fn of ctx.changes.changedFunctions) {
    const reason = eligible(fn);
    if (reason === null) continue;
    if (reason) {
      notes.push(`Skipped ${fn.qualifiedName}: ${reason}.`);
      continue;
    }
    if (fn.language !== 'python' && !ctx.projects.head.node) {
      notes.push(`Skipped ${fn.qualifiedName}: no package.json.`);
      continue;
    }
    targets.push({
      id: `${fn.file}#${fn.qualifiedName}`,
      fn,
      exportName: fn.name,
      inputs: await chooseInputs(fn, options, notes),
    });
  }
  return { targets, notes };
}

/** Spec 5c: call modified functions on base and head with the same inputs; report differences. */
export function behaviourDiffCheck(
  ctx: RunContext,
  options: BehaviourOptions & { plan?: Promise<BehaviourPlan> },
): Promise<CheckResult> {
  return runCheck('behaviour_diff', async (result) => {
    const { targets, notes } = await (options.plan ?? planBehaviourDiff(ctx, options));
    result.notes.push(...notes);
    if (targets.length === 0) {
      result.status = 'skipped';
      result.summary = 'No modified functions to compare';
      return;
    }

    const findings: Finding[] = [];
    let compared = 0;
    let changedInputs = 0;
    let skipped = 0;

    for (const toolchain of ['node', 'python'] as const) {
      const group = targets.filter(
        (t) => (t.fn.language === 'python') === (toolchain === 'python'),
      );
      if (group.length === 0) continue;
      const [b1, b2, baseError] = await runSide(ctx, 'base', toolchain, group, options);
      const [h1, h2, headError] = await runSide(ctx, 'head', toolchain, group, options);
      if (baseError || headError) {
        result.notes.push(`Behaviour harness failed (${toolchain}): ${baseError ?? headError}`);
        skipped += group.length;
        continue;
      }

      group.forEach((target, ti) => {
        const loadError = b1!.results[ti]?.loadError ?? h1!.results[ti]?.loadError;
        if (loadError) {
          result.notes.push(
            `Skipped ${target.fn.qualifiedName}: could not load it (${loadError}).`,
          );
          skipped++;
          return;
        }
        compared++;
        const examples: { args: unknown[]; before: Outcome; after: Outcome; paths: string[] }[] =
          [];
        target.inputs.forEach((args, ii) => {
          const paths = compareOutcomes(
            [b1!.results[ti]!.calls[ii] ?? null, b2?.results[ti]?.calls[ii] ?? null],
            [h1!.results[ti]!.calls[ii] ?? null, h2?.results[ti]?.calls[ii] ?? null],
          );
          if (paths && paths.length) {
            examples.push({
              args,
              before: b1!.results[ti]!.calls[ii]!,
              after: h1!.results[ti]!.calls[ii]!,
              paths,
            });
          }
        });
        if (examples.length === 0) return;
        changedInputs += examples.length;
        // Most telling first: inputs the old code handled, new crashes before new values.
        examples.sort((a, b) => exampleRank(a.before, a.after) - exampleRank(b.before, b.after));
        const fn = target.fn;
        const style = fn.language === 'python' ? 'python' : 'js';
        const lines = examples
          .slice(0, MAX_EXAMPLES)
          .map((e) => describeChange(fn.name, e.args, e.before, e.after, e.paths, style));
        findings.push({
          check: 'behaviour_diff',
          severity: 'high',
          title: lines[0]!,
          file: fn.file,
          line: fn.newRange?.start ?? null,
          function: fn.qualifiedName,
          detail: {
            inputsTried: target.inputs.length,
            inputsChanged: examples.length,
            examples: examples.slice(0, MAX_EXAMPLES).map((e, i) => ({
              summary: lines[i],
              args: e.args,
              before: e.before,
              after: e.after,
              changed: e.paths,
            })),
          },
        });
      });
    }

    result.findings = findings;
    result.stats = {
      functions: targets.length,
      compared,
      changed: findings.length,
      changedInputs,
      skipped,
    };
    if (findings.length) {
      result.status = 'warning';
      result.summary = `${plural(findings.length, 'change')}: ${findings[0]!.title}`;
    } else if (compared === 0) {
      result.status = 'skipped';
      result.summary = 'Could not run the changed functions';
    } else {
      result.summary = `${plural(compared, 'function')} compared, no change`;
    }
  });
}
