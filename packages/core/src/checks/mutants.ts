import type { Node } from 'web-tree-sitter';
import { parseSource } from '../parse/parser.js';
import type { LineRange, SourceLanguage } from '../types.js';

export interface Mutant {
  description: string;
  /** Whole file with the mutation applied. */
  source: string;
}

const FLIP: Record<string, string> = {
  '<': '>=',
  '>': '<=',
  '<=': '>',
  '>=': '<',
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
};

const NUMBER_TYPES = new Set(['number', 'integer', 'float']);
const COMPARISON_TYPES = new Set(['binary_expression', 'comparison_operator']);
const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'function_definition',
]);

function descendants(node: Node): Node[] {
  const out: Node[] = [];
  const visit = (n: Node) => {
    out.push(n);
    for (const child of n.children) if (child) visit(child);
  };
  visit(node);
  return out;
}

const splice = (source: string, start: number, end: number, text: string) =>
  source.slice(0, start) + text + source.slice(end);

/** The function node whose lines match `range` exactly (outermost such node). */
function findFunction(root: Node, range: LineRange): Node | null {
  return (
    descendants(root).find(
      (n) =>
        FUNCTION_TYPES.has(n.type) &&
        n.endPosition.row + 1 === range.end &&
        n.startPosition.row + 1 >= range.start,
    ) ?? null
  );
}

function flipComparison(fn: Node, source: string): Mutant | null {
  for (const node of descendants(fn)) {
    if (!COMPARISON_TYPES.has(node.type)) continue;
    const op = node.children.find((c) => c && !c.isNamed && FLIP[c.type]);
    if (op) {
      return {
        description: `\`${op.type}\` changed to \`${FLIP[op.type]}\` on line ${op.startPosition.row + 1}`,
        source: splice(source, op.startIndex, op.endIndex, FLIP[op.type]!),
      };
    }
  }
  return null;
}

function changeConstant(fn: Node, source: string): Mutant | null {
  for (const node of descendants(fn)) {
    if (!NUMBER_TYPES.has(node.type)) continue;
    const value = Number(node.text.replace(/_/g, ''));
    if (!Number.isFinite(value)) continue;
    const replacement = String(value + 1);
    return {
      description: `${node.text} changed to ${replacement} on line ${node.startPosition.row + 1}`,
      source: splice(source, node.startIndex, node.endIndex, replacement),
    };
  }
  return null;
}

function returnEarly(fn: Node, source: string, language: SourceLanguage): Mutant | null {
  const body = fn.childForFieldName('body');
  if (!body) return null;
  if (language === 'python') {
    if (body.type !== 'block') return null;
    const statements = body.namedChildren.filter((c): c is Node => c !== null);
    let first = statements[0];
    // Keep a docstring in place.
    if (first?.type === 'expression_statement' && first.firstNamedChild?.type === 'string') {
      first = statements[1];
    }
    if (!first) return null;
    const indent = ' '.repeat(first.startPosition.column);
    return {
      description: 'returns None immediately',
      source: splice(source, first.startIndex, first.startIndex, `return None\n${indent}`),
    };
  }
  if (body.type !== 'statement_block') return null;
  return {
    description: 'returns immediately',
    source: splice(source, body.startIndex + 1, body.startIndex + 1, ' return undefined;'),
  };
}

/**
 * Up to `max` simple mutants of the function at `range` (spec 5b): flip a
 * comparison, change a constant, return early — in that order of preference.
 */
export async function makeMutants(
  language: SourceLanguage,
  source: string,
  range: LineRange,
  max: number,
): Promise<Mutant[]> {
  const tree = await parseSource(language, source);
  try {
    const fn = findFunction(tree.rootNode, range);
    if (!fn) return [];
    const mutants = [
      flipComparison(fn, source),
      changeConstant(fn, source),
      returnEarly(fn, source, language),
    ].filter((m): m is Mutant => m !== null);
    return mutants.slice(0, max);
  } finally {
    tree.delete();
  }
}
