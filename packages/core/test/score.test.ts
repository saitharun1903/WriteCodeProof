import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  DEFAULT_REPO_CONFIG,
  formatDuration,
  parseRepoConfig,
  renderMarkdown,
  scoreRisk,
  toJsonReport,
  type ChangeSet,
  type CheckName,
  type CheckResult,
  type Finding,
  type ProofRun,
  type RiskInput,
  type Severity,
} from '../src/index.js';

function finding(check: CheckName, severity: Severity, extra: Partial<Finding> = {}): Finding {
  return {
    check,
    severity,
    title: `${check} ${severity}`,
    file: 'src/a.js',
    line: 1,
    function: 'a',
    detail: {},
    ...extra,
  };
}

function result(
  check: CheckName,
  findings: Finding[] = [],
  extra: Partial<CheckResult> = {},
): CheckResult {
  return {
    check,
    status: findings.length ? 'warning' : 'passed',
    summary: 'ok',
    findings,
    stats: {},
    notes: [],
    durationMs: 1,
    ...extra,
  };
}

function input(findings: Finding[], extra: Partial<RiskInput> = {}): RiskInput {
  const byCheck = (c: CheckName) => findings.filter((f) => f.check === c);
  return {
    checks: (['existing_tests', 'generated_tests', 'behaviour_diff', 'security'] as const).map(
      (c) => result(c, byCheck(c)),
    ),
    changedLines: 10,
    sourceFiles: 1,
    untestedFiles: 0,
    aiAuthored: false,
    ...extra,
  };
}

const times = <T>(n: number, make: () => T) => Array.from({ length: n }, make);

describe('scoreRisk', () => {
  it('is zero and Low with no signals', () => {
    const risk = scoreRisk(input([]), DEFAULT_POLICY);
    expect(risk).toMatchObject({ score: 0, band: 'low', blocked: false });
    expect(risk.why).toBe('Why 0: no risk signals');
  });

  it('matches the example from the spec', () => {
    const risk = scoreRisk(
      input([finding('behaviour_diff', 'high'), finding('generated_tests', 'medium')], {
        aiAuthored: true,
      }),
      DEFAULT_POLICY,
    );
    expect(risk.score).toBe(5.5);
    expect(risk.band).toBe('medium');
    expect(risk.why).toBe(
      'Why 5.5: 1 unexplained behaviour change (+3), 1 failing generated test (+1.5), AI-authored (+1)',
    );
  });

  it('caps each signal at its maximum', () => {
    const risk = scoreRisk(
      input([
        ...times(5, () => finding('existing_tests', 'high')),
        ...times(5, () => finding('generated_tests', 'medium')),
      ]),
      DEFAULT_POLICY,
    );
    const points = Object.fromEntries(risk.contributions.map((c) => [c.label, c.points]));
    expect(points['5 existing tests now failing']).toBe(6);
    expect(points['5 failing generated tests']).toBe(4.5);
    expect(risk.score).toBe(10);
    expect(risk.band).toBe('high');
  });

  it('ignores unconfirmed generated tests', () => {
    const risk = scoreRisk(input([finding('generated_tests', 'info')]), DEFAULT_POLICY);
    expect(risk.score).toBe(0);
  });

  it('weights security findings by severity', () => {
    const risk = scoreRisk(
      input([
        finding('security', 'high'),
        finding('security', 'medium'),
        finding('security', 'low'),
      ]),
      DEFAULT_POLICY,
    );
    expect(risk.score).toBe(5);
  });

  it('blocks on a secret or a critical finding', () => {
    const leak = finding('security', 'critical', { detail: { tool: 'gitleaks' } });
    const risk = scoreRisk(input([leak]), DEFAULT_POLICY);
    expect(risk).toMatchObject({ band: 'blocked', blocked: true, blockReasons: ['secret_leak'] });
    expect(risk.why).toContain('secret in the diff (blocks merge)');
  });

  it('scores a critical finding as high when the policy does not block on it', () => {
    const leak = finding('security', 'critical', { detail: { tool: 'gitleaks' } });
    const risk = scoreRisk(input([leak]), { ...DEFAULT_POLICY, blockOn: [] });
    expect(risk.blocked).toBe(false);
    expect(risk.score).toBe(3);
  });

  it('scales diff size and missing coverage', () => {
    const at = (changedLines: number, untestedFiles = 0, sourceFiles = 2) =>
      scoreRisk(input([], { changedLines, untestedFiles, sourceFiles }), DEFAULT_POLICY).score;
    expect(at(50)).toBe(0);
    expect(at(225)).toBe(0.5);
    expect(at(400)).toBe(1);
    expect(at(5000)).toBe(1);
    expect(at(0, 1, 2)).toBe(0.8);
    expect(at(0, 2, 2)).toBe(1.5);
  });

  it('uses the policy bands', () => {
    const one = input([finding('behaviour_diff', 'high')]);
    expect(scoreRisk(one, DEFAULT_POLICY).band).toBe('medium');
    expect(scoreRisk(one, { ...DEFAULT_POLICY, highFrom: 3 }).band).toBe('high');
    expect(scoreRisk(one, { ...DEFAULT_POLICY, mediumFrom: 4 }).band).toBe('low');
  });
});

describe('repo config', () => {
  it('falls back to defaults when there is no file', () => {
    expect(DEFAULT_REPO_CONFIG).toMatchObject({
      mode: 'advise',
      testCommand: null,
      maxGeneratedFunctions: 10,
      policy: DEFAULT_POLICY,
    });
  });

  it('reads the example from the spec', () => {
    const { config, error } = parseRepoConfig(
      `version: 1
mode: enforce
languages: [typescript, javascript, python]
tests:
  command: "npm test"
  time_budget_seconds: 300
ignore: ["docs/**", "**/*.md"]
generated_tests:
  max_functions: 4
policies:
  auto_approve_below: 2
  one_reviewer: [3, 6]
  code_owner_above: 7
  block_on: [critical_security, secret_leak]
  ai_authored_weight: 2.0
`,
      '.writecode/proof.yml',
    );
    expect(error).toBeNull();
    expect(config).toMatchObject({
      mode: 'enforce',
      testCommand: 'npm test',
      testTimeBudgetS: 300,
      ignore: ['docs/**', '**/*.md'],
      maxGeneratedFunctions: 4,
      policy: {
        mediumFrom: 3,
        highFrom: 7,
        aiAuthoredWeight: 2,
        blockOn: ['critical_security', 'secret_leak'],
      },
    });
  });

  it('reports invalid config and uses defaults', () => {
    const bad = parseRepoConfig('version: 1\nmode: yolo\n', 'proof.yml');
    expect(bad.config).toBe(DEFAULT_REPO_CONFIG);
    expect(bad.error).toMatch(/mode/);

    const typo = parseRepoConfig('version: 1\npolicys: {}\n', 'proof.yml');
    expect(typo.error).toMatch(/policys/);

    const yaml = parseRepoConfig('version: [1\n', 'proof.yml');
    expect(yaml.error).toMatch(/not valid YAML/);
  });
});

describe('reports', () => {
  const changes = {
    repoRoot: '/r',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    headRef: null,
    headSha: null,
    files: [],
    changedFunctions: [
      {
        file: 'src/a.js',
        oldFile: null,
        language: 'javascript',
        name: 'a',
        qualifiedName: 'a',
        kind: 'function',
        status: 'modified',
        exported: true,
        async: false,
        params: [],
        signature: 'function a()',
        oldSource: 'SECRET OLD BODY',
        newSource: 'SECRET NEW BODY',
        oldRange: { start: 1, end: 3 },
        newRange: { start: 1, end: 3 },
      },
    ],
    skippedFiles: [],
    parseWarnings: [],
    stats: { filesChanged: 1, additions: 2, deletions: 1 },
  } satisfies ChangeSet;
  const run: ProofRun = {
    runId: '0b80aa3e-1111-2222-3333-444455556666',
    changes,
    checks: [
      result('security'),
      result('existing_tests', [], { summary: '4 run, 4 pass' }),
      result('behaviour_diff', [
        finding('behaviour_diff', 'high', {
          title: 'cheapestItem([]) throws TypeError (was null)',
          detail: { examples: [{ summary: 'first' }, { summary: 'a | b' }] },
        }),
      ]),
      result('generated_tests', [], { status: 'skipped', summary: 'Skipped (no LLM)' }),
    ],
    notes: [],
    durationMs: 192_000,
  };
  const risk = scoreRisk(input(run.checks.flatMap((c) => c.findings)), DEFAULT_POLICY);

  it('renders the PR comment format', () => {
    const md = renderMarkdown({ run, risk });
    const lines = md.split('\n');
    expect(lines[0]).toBe('<!-- writecode-proof -->');
    expect(lines[1]).toBe('## WriteCode Proof · Risk 3/10 · Medium — one reviewer required');
    expect(md).toContain('Changed 1 function in 1 file.');
    // Table rows in the spec's order, whatever order the checks ran in.
    expect(md.indexOf('| Existing tests |')).toBeLessThan(md.indexOf('| Security |'));
    expect(md).toContain('| Existing tests | ✅ 4 run, 4 pass |');
    expect(md).toContain('| Generated tests | ➖ Skipped (no LLM) |');
    expect(md).toContain('**Why 3:** 1 unexplained behaviour change (+3)');
    expect(md).toContain('cheapestItem(\\[\\]) throws TypeError (was null)');
    expect(md).toContain('  - a \\| b');
    expect(md).toContain('<sub>Run 0b80aa3e · 3m 12s · WriteCode Proof</sub>');
  });

  it('never puts source code in the JSON report', () => {
    const json = JSON.stringify(toJsonReport({ run, risk }));
    expect(json).not.toContain('SECRET');
    expect(JSON.parse(json)).toMatchObject({
      version: 1,
      risk: { score: 3, band: 'medium' },
      changedFunctions: [{ name: 'a', status: 'modified', line: 1 }],
    });
  });

  it('formats durations', () => {
    expect(formatDuration(48_400)).toBe('48s');
    expect(formatDuration(192_000)).toBe('3m 12s');
  });
});

describe('incomplete runs', () => {
  const broken = (check: CheckName) =>
    result(check, [], { status: 'error', summary: 'Could not run: Lost connection to Docker' });

  it('records which checks did not run and says so in the reason', () => {
    const risk = scoreRisk(
      {
        ...input([]),
        checks: [result('existing_tests'), broken('security'), broken('behaviour_diff')],
      },
      DEFAULT_POLICY,
    );
    expect(risk.incompleteChecks).toEqual(['security', 'behaviour_diff']);
    expect(risk.band).toBe('low');
    expect(risk.why).toBe(
      'Why 0: no risk signals; incomplete: security, behaviour diff could not run',
    );
  });

  it('is shown as Incomplete in the PR comment, never as Low', () => {
    const checks = [result('existing_tests'), broken('security')];
    const run: ProofRun = {
      runId: 'r'.repeat(36),
      changes: { ...({} as ChangeSet), changedFunctions: [], files: [] },
      checks,
      notes: [],
      durationMs: 1000,
    };
    const risk = scoreRisk({ ...input([]), checks }, DEFAULT_POLICY);
    const md = renderMarkdown({ run, risk });
    expect(md).toContain(
      '## WriteCode Proof · Risk 0/10 · Incomplete — 1 check could not run, review by hand',
    );
    expect(md).toContain('> [!WARNING]');
    expect(md).toContain('> - Security: Could not run: Lost connection to Docker');
    expect(md).not.toContain('auto-approve');
  });

  it('keeps Blocked when a secret was found before the run broke', () => {
    const leak = finding('security', 'critical', { detail: { tool: 'gitleaks' } });
    const risk = scoreRisk(
      { ...input([]), checks: [result('security', [leak]), broken('behaviour_diff')] },
      DEFAULT_POLICY,
    );
    expect(risk.band).toBe('blocked');
    expect(risk.incompleteChecks).toEqual(['behaviour_diff']);
  });
});
