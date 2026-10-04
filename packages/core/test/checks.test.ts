import { describe, expect, it } from 'vitest';
import {
  compareOutcomes,
  describeChange,
  diffPaths,
  edgeCaseInputs,
  exampleRank,
  formatValue,
  jsImportCandidates,
  makeMutants,
  parseJestJson,
  parseJUnit,
  positionalParams,
  pyImportCandidates,
  sanitizeTestCode,
  semgrepSeverity,
  type ChangedFunction,
} from '../src/index.js';

describe('outcome comparison', () => {
  it('finds the paths that differ', () => {
    expect(diffPaths({ returned: 2 }, { returned: 1.99 })).toEqual(['returned']);
    expect(
      diffPaths({ returned: { items: [{ qty: 1 }] } }, { returned: { items: [{ qty: 2 }] } }),
    ).toEqual(['returned.items[0].qty']);
    expect(diffPaths({ returned: [1] }, { returned: [1, 2] })).toEqual(['returned']);
    expect(diffPaths({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('ignores parts that differ between two identical runs', () => {
    const base1 = { returned: { id: 'x1', total: 2 } };
    const base2 = { returned: { id: 'x2', total: 2 } };
    const head1 = { returned: { id: 'y1', total: 1.99 } };
    const head2 = { returned: { id: 'y2', total: 1.99 } };
    expect(compareOutcomes([base1, base2], [head1, head2])).toEqual(['returned.total']);
  });

  it('treats the same error type as no change, whatever the message', () => {
    const before = { threw: { type: 'TypeError', message: 'a' } };
    const after = { threw: { type: 'TypeError', message: 'b' } };
    expect(compareOutcomes([before, before], [after, after])).toEqual([]);
    const other = { threw: { type: 'ValueError', message: 'a' } };
    expect(compareOutcomes([before, before], [other, other])).toEqual(['threw.type']);
  });

  it('cannot compare missing outcomes', () => {
    expect(compareOutcomes([null, null], [{ returned: 1 }, null])).toBeNull();
  });

  it('ranks new crashes on valid input first', () => {
    const ok = { returned: 1 };
    const crash = { threw: { type: 'TypeError', message: '' } };
    expect(exampleRank(ok, crash)).toBeLessThan(exampleRank(ok, { returned: 2 }));
    expect(exampleRank(ok, { returned: 2 })).toBeLessThan(exampleRank(crash, ok));
  });
});

describe('describing changes', () => {
  it('reads like a sentence', () => {
    expect(
      describeChange('roundMoney', [1.999], { returned: 2 }, { returned: 1.99 }, ['returned']),
    ).toBe('roundMoney(1.999) returns 1.99 (was 2)');
    expect(
      describeChange(
        'cheapestItem',
        [[]],
        { returned: null },
        { threw: { type: 'TypeError', message: '' } },
        ['threw'],
      ),
    ).toBe('cheapestItem([]) throws TypeError (was null)');
    expect(describeChange('f', [1], { returned: 1 }, { timeout: true }, ['timeout'])).toBe(
      'f(1) hangs (was 1)',
    );
  });

  it('uses Python spelling for Python values', () => {
    expect(formatValue(null, 60, 'python')).toBe('None');
    expect(formatValue(true, 60, 'python')).toBe('True');
    expect(formatValue({ a: 'x' }, 60, 'python')).toBe("{'a': 'x'}");
    expect(formatValue("it's", 60, 'python')).toBe('"it\'s"');
  });

  it('renders encoded special values and truncates', () => {
    expect(formatValue({ $undefined: true })).toBe('undefined');
    expect(formatValue({ $number: 'NaN' })).toBe('NaN');
    expect(formatValue({ $class: 'Cart', items: [] })).toBe('Cart {items: []}');
    expect(formatValue('x'.repeat(100), 10)).toHaveLength(10);
  });
});

describe('behaviour inputs', () => {
  const fn = (params: string[], language: ChangedFunction['language'] = 'javascript') =>
    ({ params, language }) as ChangedFunction;

  it('counts positional parameters only', () => {
    expect(positionalParams(fn(['a', 'b = 1', '...rest']))).toEqual(['a', 'b = 1']);
    expect(positionalParams(fn(['this: Foo', 'x: number'], 'typescript'))).toEqual(['x: number']);
    expect(positionalParams(fn(['self', 'x', '*args', '**kw'], 'python'))).toEqual(['x']);
  });

  it('gives every function the empty-input edge cases', () => {
    const one = edgeCaseInputs(1, false);
    expect(one[0]).toEqual([[]]);
    expect(one).toContainEqual([1.999]);
    expect(one).toContainEqual([{ $undefined: true }]);
    expect(edgeCaseInputs(1, true)).not.toContainEqual([{ $undefined: true }]);
    expect(edgeCaseInputs(2, false).every((args) => args.length === 2)).toBe(true);
    expect(edgeCaseInputs(0, false)).toEqual([[]]);
  });
});

describe('test reports', () => {
  it('reads vitest-style JUnit', () => {
    const cases = parseJUnit(`<?xml version="1.0"?>
      <testsuites><testsuite name="test/cart.test.js">
        <testcase classname="test/cart.test.js" name="cart &gt; adds up" time="0.01"/>
        <testcase classname="test/cart.test.js" name="cart &gt; discounts">
          <failure message="expected 45 to be 44" type="AssertionError">stack</failure>
        </testcase>
        <testcase classname="test/cart.test.js" name="later"><skipped/></testcase>
      </testsuite></testsuites>`);
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([
      ['test/cart.test.js > cart > adds up', 'passed'],
      ['test/cart.test.js > cart > discounts', 'failed'],
      ['test/cart.test.js > later', 'skipped'],
    ]);
    expect(cases[1]!.message).toContain('expected 45 to be 44');
  });

  it('reads pytest JUnit, including errors', () => {
    const cases = parseJUnit(`<testsuites><testsuite name="pytest">
        <testcase classname="tests.test_cart" name="test_ok"/>
        <testcase classname="tests.test_cart" name="test_boom"><error message="ValueError"/></testcase>
      </testsuite></testsuites>`);
    expect(cases.map((c) => c.outcome)).toEqual(['passed', 'failed']);
    expect(cases[0]!.id).toBe('pytest > test_ok');
  });

  it('reads node --test JUnit with nested suites', () => {
    const cases = parseJUnit(`<testsuites>
        <testsuite name="cart"><testcase name="sums" classname="test"/></testsuite>
        <testcase name="top" classname="test"><failure type="testCodeFailure" message="boom"/></testcase>
      </testsuites>`);
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([
      ['test > top', 'failed'],
      ['cart > sums', 'passed'],
    ]);
  });

  it('reads jest --json', () => {
    const cases = parseJestJson(
      JSON.stringify({
        testResults: [
          {
            name: '/work/head/a.test.js',
            assertionResults: [
              { fullName: 'a works', status: 'passed' },
              { fullName: 'a fails', status: 'failed', failureMessages: ['nope'] },
            ],
          },
        ],
      }),
      '/work/head',
    );
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([
      ['a.test.js > a works', 'passed'],
      ['a.test.js > a fails', 'failed'],
    ]);
  });
});

describe('import scanning', () => {
  it('resolves relative JS/TS imports', () => {
    const src = `import { a } from '../src/cart.js';\nconst b = require('./util');\nimport x from 'lodash';\nawait import("../lib/dyn")`;
    const c = jsImportCandidates('test/cart.test.js', src);
    expect(c).toContain('src/cart.js');
    expect(c).toContain('src/cart.ts');
    expect(c).toContain('test/util.js');
    expect(c).toContain('lib/dyn/index.ts');
    expect(c.some((p) => p.includes('lodash'))).toBe(false);
  });

  it('resolves Python imports, relative and src layout', () => {
    const src =
      'from shop.cart import Cart, subtotal\nimport shop.util as u\nfrom . import helpers\nfrom ..core import base';
    const c = pyImportCandidates('tests/unit/test_cart.py', src);
    expect(c).toContain('shop/cart.py');
    expect(c).toContain('src/shop/cart.py');
    expect(c).toContain('shop/util.py');
    expect(c).toContain('tests/unit/helpers.py');
    expect(c).toContain('tests/core.py');
  });
});

describe('mutants', () => {
  it('flips a comparison, changes a constant and returns early (JS)', async () => {
    const src = 'export function f(a) {\n  if (a > 10) return 1;\n  return 0;\n}\n';
    const mutants = await makeMutants('javascript', src, { start: 1, end: 4 }, 3);
    expect(mutants.map((m) => m.description)).toEqual([
      '`>` changed to `<=` on line 2',
      '10 changed to 11 on line 2',
      'returns immediately',
    ]);
    expect(mutants[0]!.source).toContain('a <= 10');
    expect(mutants[2]!.source).toContain('{ return undefined;');
  });

  it('keeps Python indentation and docstrings', async () => {
    const src = 'def f(a):\n    """Doc."""\n    if a == 1:\n        return 2\n    return 3\n';
    const [, , early] = await makeMutants('python', src, { start: 1, end: 5 }, 3);
    expect(early!.source).toBe(
      'def f(a):\n    """Doc."""\n    return None\n    if a == 1:\n        return 2\n    return 3\n',
    );
  });

  it('respects the limit', async () => {
    const src = 'function f(a) { return a < 1; }';
    expect(await makeMutants('javascript', src, { start: 1, end: 1 }, 1)).toHaveLength(1);
  });
});

describe('generated test cleanup', () => {
  const js = { fn: { language: 'javascript' } as ChangedFunction, importName: 'cheapestItem' };
  const py = { fn: { language: 'python' } as ChangedFunction, importName: 'cheapest_item' };

  it('drops imports the preamble already has', () => {
    const code = [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { cheapestItem } from '../src/cart.js';",
      "test('x', () => assert.equal(cheapestItem([]), null));",
    ].join('\n');
    expect(sanitizeTestCode(code, js)).toBe(
      "test('x', () => assert.equal(cheapestItem([]), null));",
    );
  });

  it('keeps unrelated Python imports', () => {
    const code =
      'import pytest\nimport math\nfrom shop.cart import cheapest_item\n\ndef test_x():\n    assert math.isclose(1, 1)';
    expect(sanitizeTestCode(code, py)).toBe(
      'import math\n\ndef test_x():\n    assert math.isclose(1, 1)',
    );
  });
});

describe('semgrepSeverity', () => {
  it.each([
    ['ERROR', 'high'],
    ['WARNING', 'medium'],
    ['INFO', 'low'],
    [undefined, 'low'],
  ] as const)('%s → %s', (level, expected) => expect(semgrepSeverity(level)).toBe(expected));
});
