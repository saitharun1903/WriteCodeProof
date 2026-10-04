/** What one call did, as recorded by the harness. */
export interface Outcome {
  returned?: unknown;
  args?: unknown;
  threw?: { type: string; message: string };
  timeout?: true;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Paths at which `a` and `b` differ, e.g. `returned`, `returned.items[0].qty`.
 * Recurses through matching arrays/objects; reports the first point of divergence.
 */
export function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [path];
    return a.flatMap((v, i) => diffPaths(v, b[i], `${path}[${i}]`));
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].sort().flatMap((k) => {
      if (!(k in a) || !(k in b)) return [path ? `${path}.${k}` : k];
      return diffPaths(a[k], b[k], path ? `${path}.${k}` : k);
    });
  }
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}

const under = (path: string, prefix: string) =>
  prefix === '' ||
  path === prefix ||
  path.startsWith(`${prefix}.`) ||
  path.startsWith(`${prefix}[`);

/**
 * Error messages are left out: two versions rejecting bad input with the same
 * error type is not a change a caller can rely on. Messages stay in the report.
 */
const comparable = (o: Outcome): Outcome =>
  o.threw ? { ...o, threw: { type: o.threw.type, message: '' } } : o;

/**
 * Differences between base and head for one input, ignoring anything that
 * already differed between two identical runs of the same side (spec 5c).
 * Returns `null` when the outcomes can't be compared.
 */
export function compareOutcomes(
  base: [Outcome | null, Outcome | null],
  head: [Outcome | null, Outcome | null],
): string[] | null {
  const [b1, b2] = base.map((o) => (o ? comparable(o) : null));
  const [h1, h2] = head.map((o) => (o ? comparable(o) : null));
  if (!b1 || !h1) return null;
  const unstable = [...(b2 ? diffPaths(b1, b2) : []), ...(h2 ? diffPaths(h1, h2) : [])];
  return diffPaths(b1, h1).filter((p) => !unstable.some((u) => under(p, u)));
}

/**
 * Rank an example for showing to a reviewer: inputs the old code handled
 * fine come first, a new crash or hang before a different return value.
 */
export function exampleRank(before: Outcome, after: Outcome): number {
  const oldOk = !before.threw && !before.timeout;
  const newFails = !!(after.threw || after.timeout);
  if (oldOk && newFails) return 0;
  if (oldOk) return 1;
  return 2;
}

const MAX_SHOWN = 60;

export type ValueStyle = 'js' | 'python';

/** Compact, human-readable rendering of an encoded value. */
export function formatValue(value: unknown, max = MAX_SHOWN, style: ValueStyle = 'js'): string {
  const py = style === 'python';
  const render = (v: unknown): string => {
    if (v === null) return py ? 'None' : 'null';
    if (typeof v === 'boolean') return py ? (v ? 'True' : 'False') : String(v);
    if (Array.isArray(v)) return `[${v.map(render).join(', ')}]`;
    if (isObject(v)) {
      if (v.$undefined) return 'undefined';
      if (typeof v.$number === 'string') {
        return py && v.$number !== '-0'
          ? `float('${v.$number.toLowerCase().replace('infinity', 'inf')}')`
          : v.$number;
      }
      if (typeof v.$bigint === 'string') return `${v.$bigint}n`;
      if (typeof v.$int === 'string') return v.$int;
      if (typeof v.$date === 'string') return `Date(${v.$date})`;
      if (typeof v.$function === 'string') return `[Function ${v.$function}]`;
      if (Array.isArray(v.$tuple)) return `(${v.$tuple.map(render).join(', ')})`;
      if (Array.isArray(v.$set)) return `${py ? '' : 'Set'}{${v.$set.map(render).join(', ')}}`;
      if (Array.isArray(v.$map)) return `Map(${v.$map.length})`;
      if (v.$circular) return '[Circular]';
      const cls = typeof v.$class === 'string' ? `${v.$class} ` : '';
      const entries = Object.entries(v)
        .filter(([k]) => !k.startsWith('$'))
        .map(([k, x]) => (py && !cls ? `'${k}': ${render(x)}` : `${k}: ${render(x)}`));
      return `${cls}{${entries.join(', ')}}`;
    }
    if (typeof v === 'string') {
      // Like Python's repr: single quotes unless the text contains one.
      return py && !v.includes("'") && !v.includes('\\') ? `'${v}'` : JSON.stringify(v);
    }
    return String(v);
  };
  const text = render(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function describeOutcome(outcome: Outcome, style: ValueStyle = 'js'): string {
  if (outcome.timeout) return 'hangs';
  if (outcome.threw) return `throws ${outcome.threw.type}`;
  return `returns ${formatValue(outcome.returned, MAX_SHOWN, style)}`;
}

/** "roundMoney(1.999) returns 1.99 (was 2)" */
export function describeChange(
  name: string,
  args: unknown[],
  before: Outcome,
  after: Outcome,
  paths: string[],
  style: ValueStyle = 'js',
): string {
  const call = `${name}(${args.map((a) => formatValue(a, 40, style)).join(', ')})`;
  const now = describeOutcome(after, style);
  const was = describeOutcome(before, style);
  if (now === was && paths.every((p) => p.startsWith('args'))) {
    return `${call} now changes its arguments differently`;
  }
  return `${call} ${now} (was ${was.replace(/^returns /, '')})`;
}
