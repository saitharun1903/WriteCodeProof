import type { Node } from 'web-tree-sitter';
import type { FunctionInfo, FunctionKind, SourceLanguage } from '../types.js';
import { parseSource } from './parser.js';

export interface ExtractResult {
  functions: FunctionInfo[];
  hasSyntaxErrors: boolean;
}

interface Scope {
  path: string[];
  inClass: boolean;
  classExported: boolean;
  topLevel: boolean;
}

const ROOT_SCOPE: Scope = { path: [], inClass: false, classExported: false, topLevel: true };

const JS_FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);
const JS_CLASSES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const JS_DECLARATIONS = new Set(['lexical_declaration', 'variable_declaration']);

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function hasToken(node: Node, type: string): boolean {
  return node.children.some((child) => child?.type === type);
}

function stripQuotes(text: string): string {
  return /^(['"`]).*\1$/s.test(text) ? text.slice(1, -1) : text;
}

const isPublicPython = (name: string) => !name.startsWith('_') || /^__\w+__$/.test(name);

class Extractor {
  readonly functions: FunctionInfo[] = [];
  /** Names listed in `export { a, b as c }` at module level. */
  private readonly exportedNames = new Set<string>();

  constructor(
    private readonly language: SourceLanguage,
    private readonly source: string,
  ) {}

  run(root: Node): void {
    if (this.language === 'python') {
      this.walkPython(root, ROOT_SCOPE);
    } else {
      this.collectExportClauses(root);
      this.walkJs(root, ROOT_SCOPE);
    }
  }

  private record(
    rangeNode: Node,
    fnNode: Node,
    name: string,
    scope: Scope,
    kind: FunctionKind,
    exported: boolean,
  ): void {
    const body = fnNode.childForFieldName('body');
    const paramsNode = fnNode.childForFieldName('parameters');
    const single = fnNode.childForFieldName('parameter');
    const params = paramsNode
      ? namedChildren(paramsNode)
          .filter((p) => p.type !== 'comment')
          .map((p) => p.text)
      : single
        ? [single.text]
        : [];

    const headerEnd = body ? body.startIndex : fnNode.endIndex;
    const signature = this.source
      .slice(rangeNode.startIndex, headerEnd)
      .replace(/\s+/g, ' ')
      .trim();

    this.functions.push({
      name,
      qualifiedName: [...scope.path, name].join('.'),
      kind: scope.inClass ? 'method' : kind,
      exported,
      async: hasToken(fnNode, 'async'),
      params,
      signature,
      source: this.source.slice(rangeNode.startIndex, rangeNode.endIndex),
      range: { start: rangeNode.startPosition.row + 1, end: rangeNode.endPosition.row + 1 },
    });

    if (body) {
      const inner: Scope = {
        path: [...scope.path, name],
        inClass: false,
        classExported: false,
        topLevel: false,
      };
      if (this.language === 'python') this.walkPythonChildren(body, inner);
      else this.walkJsChildren(body, inner);
    }
  }

  // ---------- JavaScript / TypeScript ----------

  private collectExportClauses(root: Node): void {
    for (const stmt of namedChildren(root)) {
      if (stmt.type !== 'export_statement' || stmt.childForFieldName('source')) continue;
      for (const clause of namedChildren(stmt)) {
        if (clause.type !== 'export_clause') continue;
        for (const spec of namedChildren(clause)) {
          const local = spec.childForFieldName('name');
          if (local) this.exportedNames.add(local.text);
        }
      }
    }
  }

  private isJsExported(node: Node, name: string, scope: Scope): boolean {
    if (scope.inClass) return scope.classExported;
    if (!scope.topLevel) return false;
    let parent = node.parent;
    if (parent && JS_DECLARATIONS.has(parent.type)) parent = parent.parent;
    return parent?.type === 'export_statement' || this.exportedNames.has(name);
  }

  private walkJsChildren(node: Node, scope: Scope): void {
    for (const child of namedChildren(node)) this.walkJs(child, scope);
  }

  /** `assignedTo`: the variable a class expression is assigned to, which names it. */
  private walkJs(node: Node, scope: Scope, assignedTo?: { name: string; node: Node }): void {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text ?? 'default';
        this.record(node, node, name, scope, 'function', this.isJsExported(node, name, scope));
        return;
      }

      case 'method_definition': {
        const key = node.childForFieldName('name');
        if (!key) break;
        const accessor = hasToken(node, 'get') ? 'get ' : hasToken(node, 'set') ? 'set ' : '';
        const name = accessor + stripQuotes(key.text);
        const exported = scope.inClass ? scope.classExported : false;
        this.record(node, node, name, scope, 'method', exported);
        return;
      }

      case 'variable_declarator': {
        const nameNode = node.childForFieldName('name');
        const value = node.childForFieldName('value');
        if (nameNode?.type === 'identifier' && value) {
          if (JS_FUNCTION_VALUES.has(value.type)) {
            const name = nameNode.text;
            this.record(node, value, name, scope, 'function', this.isJsExported(node, name, scope));
            return;
          }
          if (value.type === 'class') {
            this.walkJs(value, scope, { name: nameNode.text, node });
            return;
          }
        }
        break;
      }

      case 'field_definition':
      case 'public_field_definition': {
        const key = node.childForFieldName('property') ?? node.childForFieldName('name');
        const value = node.childForFieldName('value');
        if (key && value && JS_FUNCTION_VALUES.has(value.type)) {
          this.record(node, value, stripQuotes(key.text), scope, 'method', scope.classExported);
          return;
        }
        break;
      }

      case 'pair': {
        const key = node.childForFieldName('key');
        const value = node.childForFieldName('value');
        if (key && value && JS_FUNCTION_VALUES.has(value.type)) {
          this.record(node, value, stripQuotes(key.text), scope, 'function', false);
          return;
        }
        break;
      }

      case 'assignment_expression': {
        // module.exports.foo = function () {} / exports.foo = () => {}
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left?.type === 'member_expression' && right && JS_FUNCTION_VALUES.has(right.type)) {
          const property = left.childForFieldName('property');
          if (property) {
            const exported = /^(module\.)?exports\./.test(left.text);
            this.record(node, right, property.text, scope, 'function', exported);
            return;
          }
        }
        break;
      }

      case 'export_statement': {
        // export default function () {} / export default () => {}
        const value = node.childForFieldName('value');
        if (value && JS_FUNCTION_VALUES.has(value.type)) {
          this.record(node, value, 'default', scope, 'function', true);
          return;
        }
        break;
      }

      default:
        if (JS_CLASSES.has(node.type)) {
          const name = node.childForFieldName('name')?.text ?? assignedTo?.name ?? 'default';
          const body = node.childForFieldName('body');
          if (body) {
            this.walkJsChildren(body, {
              path: [...scope.path, name],
              inClass: true,
              classExported: this.isJsExported(assignedTo?.node ?? node, name, scope),
              topLevel: false,
            });
          }
          return;
        }
    }
    this.walkJsChildren(node, scope);
  }

  // ---------- Python ----------

  private walkPythonChildren(node: Node, scope: Scope): void {
    for (const child of namedChildren(node)) this.walkPython(child, scope);
  }

  private walkPython(node: Node, scope: Scope, rangeNode: Node = node): void {
    switch (node.type) {
      case 'decorated_definition': {
        const definition = node.childForFieldName('definition');
        if (definition) this.walkPython(definition, scope, node);
        return;
      }

      case 'function_definition': {
        const name = node.childForFieldName('name')?.text;
        if (!name) break;
        const exported = scope.inClass
          ? scope.classExported && isPublicPython(name)
          : scope.topLevel && isPublicPython(name);
        this.record(rangeNode, node, name, scope, 'function', exported);
        return;
      }

      case 'class_definition': {
        const name = node.childForFieldName('name')?.text;
        const body = node.childForFieldName('body');
        if (!name || !body) break;
        this.walkPythonChildren(body, {
          path: [...scope.path, name],
          inClass: true,
          classExported: scope.topLevel && !name.startsWith('_'),
          topLevel: false,
        });
        return;
      }
    }
    this.walkPythonChildren(node, scope);
  }
}

/** Give repeated names (overloads, redefinitions) a `#n` suffix so keys stay unique. */
function disambiguate(functions: FunctionInfo[]): FunctionInfo[] {
  const seen = new Map<string, number>();
  return functions.map((fn) => {
    const count = (seen.get(fn.qualifiedName) ?? 0) + 1;
    seen.set(fn.qualifiedName, count);
    return count === 1 ? fn : { ...fn, qualifiedName: `${fn.qualifiedName}#${count}` };
  });
}

/** List every named function and method in `source`, in source order. */
export async function extractFunctions(
  language: SourceLanguage,
  source: string,
): Promise<ExtractResult> {
  const tree = await parseSource(language, source);
  try {
    const extractor = new Extractor(language, source);
    extractor.run(tree.rootNode);
    const functions = disambiguate(extractor.functions).sort(
      (a, b) => a.range.start - b.range.start,
    );
    return { functions, hasSyntaxErrors: tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}
