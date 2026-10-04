import { XMLParser } from 'fast-xml-parser';
import { CHECK_DEFAULTS } from '../config/defaults.js';

export type TestOutcome = 'passed' | 'failed' | 'skipped';

export interface TestCase {
  /** Stable across base and head runs: suite path plus test name. */
  id: string;
  name: string;
  outcome: TestOutcome;
  message: string | null;
}

type XmlNode = Record<string, unknown>;

const clip = (text: string, max: number = CHECK_DEFAULTS.MAX_MESSAGE_CHARS) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function nodeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') {
    const n = node as XmlNode;
    const message = typeof n.message === 'string' ? n.message : '';
    const text = typeof n['#text'] === 'string' ? n['#text'] : '';
    return [message, text].filter(Boolean).join('\n');
  }
  return '';
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  isArray: (name) => ['testsuite', 'testcase', 'failure', 'error', 'skipped'].includes(name),
});

/** Read a JUnit XML report (vitest, node --test, pytest all write one). */
export function parseJUnit(xml: string): TestCase[] {
  const doc = parser.parse(xml) as XmlNode;
  const cases: TestCase[] = [];

  const walk = (node: XmlNode, suites: string[]) => {
    for (const tc of asArray(node.testcase as XmlNode[] | undefined)) {
      const name = String(tc.name ?? '');
      const classname = String(tc.classname ?? '');
      const path = suites.length ? suites : classname ? [classname] : [];
      const problems = [...asArray(tc.failure), ...asArray(tc.error)];
      const skipped = asArray(tc.skipped).length > 0;
      cases.push({
        id: [...path, name].join(' > '),
        name,
        outcome: problems.length ? 'failed' : skipped ? 'skipped' : 'passed',
        message: problems.length ? clip(problems.map(nodeText).join('\n').trim()) : null,
      });
    }
    for (const suite of asArray(node.testsuite as XmlNode[] | undefined)) {
      const suiteName = String(suite.name ?? '');
      walk(suite, suiteName ? [...suites, suiteName] : suites);
    }
  };

  const root = (doc.testsuites as XmlNode | undefined) ?? doc;
  walk(root, []);
  return cases;
}

interface JestReport {
  testResults?: {
    name?: string;
    message?: string;
    assertionResults?: {
      fullName?: string;
      title?: string;
      status?: string;
      failureMessages?: string[];
    }[];
  }[];
}

/** Read `jest --json` output. Paths are made relative to `root`. */
export function parseJestJson(json: string, root: string): TestCase[] {
  const report = JSON.parse(json) as JestReport;
  const cases: TestCase[] = [];
  for (const file of report.testResults ?? []) {
    const path = (file.name ?? '').replace(`${root}/`, '');
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && file.message) {
      cases.push({ id: path, name: path, outcome: 'failed', message: clip(file.message) });
    }
    for (const a of assertions) {
      const name = a.fullName ?? a.title ?? '';
      cases.push({
        id: `${path} > ${name}`,
        name,
        outcome: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped',
        message: a.failureMessages?.length ? clip(a.failureMessages.join('\n')) : null,
      });
    }
  }
  return cases;
}
