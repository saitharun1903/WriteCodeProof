import { describe, expect, it } from 'vitest';
import { extractFunctions, type FunctionInfo } from '../src/index.js';

const summary = (fns: FunctionInfo[]) =>
  fns.map((f) => `${f.qualifiedName}${f.exported ? ' [export]' : ''}${f.async ? ' [async]' : ''}`);

describe('extractFunctions: JavaScript', () => {
  it('finds every kind of named function', async () => {
    const { functions, hasSyntaxErrors } = await extractFunctions(
      'javascript',
      [
        'export function a(x, y = 1, ...rest) { return x; }',
        'const b = async (z) => z;',
        'function* gen() {}',
        'export class Cart {',
        '  add(item) { return this; }',
        '  get size() { return 0; }',
        '  static async load() {}',
        '  #secret() {}',
        '  onClick = () => {};',
        '}',
        'const helpers = { fmt(v) {}, parse: function (s) {} };',
        'module.exports.legacy = function () {};',
        'export default function () {}',
        'function outer() { function inner() {} return inner; }',
        'export { b };',
        '[1, 2].map((n) => n * 2);',
      ].join('\n'),
    );
    expect(hasSyntaxErrors).toBe(false);
    expect(summary(functions)).toEqual([
      'a [export]',
      'b [export] [async]',
      'gen',
      'Cart.add [export]',
      'Cart.get size [export]',
      'Cart.load [export] [async]',
      'Cart.#secret [export]',
      'Cart.onClick [export]',
      'fmt',
      'parse',
      'legacy [export]',
      'default [export]',
      'outer',
      'outer.inner',
    ]);
    expect(functions[0]).toMatchObject({
      params: ['x', 'y = 1', '...rest'],
      signature: 'function a(x, y = 1, ...rest)',
      range: { start: 1, end: 1 },
      kind: 'function',
    });
    expect(functions.find((f) => f.name === 'add')!.kind).toBe('method');
  });

  it('names class expressions after their variable', async () => {
    const { functions } = await extractFunctions(
      'javascript',
      'export const Store = class { get() {} };',
    );
    expect(summary(functions)).toEqual(['Store.get [export]']);
  });

  it('keeps names unique', async () => {
    const { functions } = await extractFunctions(
      'javascript',
      'function f() {}\nfunction f() {}\n',
    );
    expect(functions.map((f) => f.qualifiedName)).toEqual(['f', 'f#2']);
  });

  it('slices source correctly after non-ASCII text', async () => {
    const source = '// 价格 🛒 café\nexport function price(n) { return `€${n}`; }\n';
    const { functions } = await extractFunctions('javascript', source);
    expect(functions[0]!.source).toBe('function price(n) { return `€${n}`; }');
    expect(functions[0]!.range).toEqual({ start: 2, end: 2 });
  });

  it('reports syntax errors but still extracts what it can', async () => {
    const { functions, hasSyntaxErrors } = await extractFunctions(
      'javascript',
      'function ok() {}\nfunction broken( {\n',
    );
    expect(hasSyntaxErrors).toBe(true);
    expect(functions.map((f) => f.name)).toContain('ok');
  });
});

describe('extractFunctions: TypeScript', () => {
  it('handles types, modifiers and declarations without bodies', async () => {
    const { functions } = await extractFunctions(
      'typescript',
      [
        'export function a(x: number, y?: string): void {}',
        'declare function ambient(): void;',
        'export abstract class Repo<T> {',
        '  private cache = (key: string): T | undefined => undefined;',
        '  constructor(public readonly name: string) {}',
        '  abstract find(id: string): T;',
        '  async save(item: T): Promise<void> {}',
        '}',
        'export const handler = async <T,>(input: T): Promise<T> => input;',
      ].join('\n'),
    );
    expect(summary(functions)).toEqual([
      'a [export]',
      'Repo.cache [export]',
      'Repo.constructor [export]',
      'Repo.save [export] [async]',
      'handler [export] [async]',
    ]);
    expect(functions[0]!.params).toEqual(['x: number', 'y?: string']);
    expect(functions[0]!.signature).toBe('function a(x: number, y?: string): void');
  });

  it('parses TSX', async () => {
    const { functions, hasSyntaxErrors } = await extractFunctions(
      'tsx',
      'export function Button({ label }: { label: string }) { return <button>{label}</button>; }',
    );
    expect(hasSyntaxErrors).toBe(false);
    expect(summary(functions)).toEqual(['Button [export]']);
  });
});

describe('extractFunctions: Python', () => {
  it('finds functions, methods and nested functions', async () => {
    const { functions } = await extractFunctions(
      'python',
      [
        'import functools',
        '',
        '@functools.cache',
        'def a(x, y=1, *args, **kw) -> int:',
        '    return x',
        '',
        'def _private():',
        '    def helper():',
        '        pass',
        '',
        'class Cart:',
        '    def __init__(self):',
        '        self.items = []',
        '',
        '    async def load(self, n: int):',
        '        pass',
        '',
        '    def _internal(self):',
        '        pass',
        '',
        'class _Hidden:',
        '    def run(self):',
        '        pass',
      ].join('\n'),
    );
    expect(summary(functions)).toEqual([
      'a [export]',
      '_private',
      '_private.helper',
      'Cart.__init__ [export]',
      'Cart.load [export] [async]',
      'Cart._internal',
      '_Hidden.run',
    ]);
    const a = functions[0]!;
    expect(a.range).toEqual({ start: 3, end: 5 }); // decorator included
    expect(a.params).toEqual(['x', 'y=1', '*args', '**kw']);
    expect(a.source.startsWith('@functools.cache')).toBe(true);
    expect(functions.find((f) => f.name === 'load')!.kind).toBe('method');
  });
});
