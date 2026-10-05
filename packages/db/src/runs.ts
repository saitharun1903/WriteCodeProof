import { and, count, desc, eq } from 'drizzle-orm';
import type { CheckResult, Finding, Risk } from '@writecode-proof/core';
import type { Db } from './client.js';
import { findings, installations, repos, runs } from './schema.js';

/** Largest finding detail stored as-is; bigger ones keep only their summary fields. */
const MAX_DETAIL_BYTES = 16 * 1024;

export type RunSource = 'cli' | 'github';
export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface NewRun {
  id: string;
  source: RunSource;
  repoId?: number | null;
  repoLabel?: string | null;
  prNumber?: number | null;
  baseSha: string;
  headSha: string | null;
  status?: RunStatus;
}

export interface FinishedRun {
  status: 'done';
  risk: Risk;
  checks: CheckResult[];
  durationMs: number;
}

export interface FailedRun {
  status: 'error' | 'cancelled';
  error: string;
  durationMs: number;
}

/** What is stored per check: everything but the findings, which have their own table. */
export type StoredCheck = Omit<CheckResult, 'findings'> & { findingCount: number };

function storedDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(detail);
  if (json.length <= MAX_DETAIL_BYTES) return detail;
  const examples = Array.isArray(detail.examples)
    ? detail.examples.map((e) => ({ summary: (e as { summary?: unknown }).summary }))
    : undefined;
  return { truncated: true, ...(examples ? { examples } : {}), message: detail.message ?? null };
}

export async function upsertInstallation(
  db: Db,
  githubInstallationId: number,
  accountLogin: string,
): Promise<number> {
  const [row] = await db
    .insert(installations)
    .values({ githubInstallationId, accountLogin })
    .onConflictDoUpdate({ target: installations.githubInstallationId, set: { accountLogin } })
    .returning({ id: installations.id });
  return row!.id;
}

export async function upsertRepo(
  db: Db,
  fullName: string,
  installationId: number | null,
  config?: unknown,
): Promise<number> {
  const set = { installationId, ...(config === undefined ? {} : { configJson: config }) };
  const [row] = await db
    .insert(repos)
    .values({ fullName, ...set })
    .onConflictDoUpdate({ target: repos.fullName, set })
    .returning({ id: repos.id });
  return row!.id;
}

export async function setRepoConfig(db: Db, repoId: number, config: unknown): Promise<void> {
  await db.update(repos).set({ configJson: config }).where(eq(repos.id, repoId));
}

export async function createRun(db: Db, run: NewRun): Promise<void> {
  await db.insert(runs).values({
    id: run.id,
    source: run.source,
    repoId: run.repoId ?? null,
    repoLabel: run.repoLabel ?? null,
    prNumber: run.prNumber ?? null,
    baseSha: run.baseSha,
    headSha: run.headSha,
    status: run.status ?? 'running',
  });
}

export async function setRunStatus(db: Db, id: string, status: RunStatus): Promise<void> {
  await db.update(runs).set({ status }).where(eq(runs.id, id));
}

/** Record the outcome of a run and its findings in one transaction. */
export async function finishRun(db: Db, id: string, outcome: FinishedRun | FailedRun) {
  await db.transaction(async (tx) => {
    if (outcome.status !== 'done') {
      await tx
        .update(runs)
        .set({
          status: outcome.status,
          error: outcome.error,
          durationMs: outcome.durationMs,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, id));
      return;
    }
    const { risk, checks } = outcome;
    const stored: StoredCheck[] = checks.map(({ findings: list, ...rest }) => ({
      ...rest,
      findingCount: list.length,
    }));
    await tx
      .update(runs)
      .set({
        status: 'done',
        riskScore: risk.score,
        riskBand: risk.band,
        why: risk.why,
        checksJson: stored,
        durationMs: outcome.durationMs,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, id));
    const rows = checks.flatMap((c) =>
      c.findings.map((f: Finding) => ({
        runId: id,
        check: f.check,
        severity: f.severity,
        title: f.title,
        detailJson: storedDetail({ ...f.detail, function: f.function }),
        file: f.file,
        line: f.line,
      })),
    );
    if (rows.length) await tx.insert(findings).values(rows);
  });
}

export interface RunListItem {
  id: string;
  source: RunSource;
  repo: string | null;
  prNumber: number | null;
  baseSha: string;
  headSha: string | null;
  status: RunStatus;
  riskScore: number | null;
  riskBand: string | null;
  why: string | null;
  durationMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

const listColumns = {
  id: runs.id,
  source: runs.source,
  repoName: repos.fullName,
  repoLabel: runs.repoLabel,
  prNumber: runs.prNumber,
  baseSha: runs.baseSha,
  headSha: runs.headSha,
  status: runs.status,
  riskScore: runs.riskScore,
  riskBand: runs.riskBand,
  why: runs.why,
  durationMs: runs.durationMs,
  createdAt: runs.createdAt,
  finishedAt: runs.finishedAt,
};

type ListRow = { repoName: string | null; repoLabel: string | null } & Omit<RunListItem, 'repo'>;
const toItem = ({ repoName, repoLabel, ...rest }: ListRow): RunListItem => ({
  ...rest,
  repo: repoName ?? repoLabel,
});

export interface ListOptions {
  page: number;
  pageSize: number;
  source?: RunSource;
}

/** Newest first. */
export async function listRuns(db: Db, { page, pageSize, source }: ListOptions) {
  const where = source ? and(eq(runs.source, source)) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select(listColumns)
      .from(runs)
      .leftJoin(repos, eq(runs.repoId, repos.id))
      .where(where)
      .orderBy(desc(runs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(runs).where(where),
  ]);
  return { items: rows.map(toItem), total: total?.n ?? 0, page, pageSize };
}

export async function getRun(db: Db, id: string) {
  const [row] = await db
    .select({ ...listColumns, checksJson: runs.checksJson, error: runs.error })
    .from(runs)
    .leftJoin(repos, eq(runs.repoId, repos.id))
    .where(eq(runs.id, id));
  if (!row) return null;
  const { checksJson, error, ...rest } = row;
  const list = await db
    .select({
      check: findings.check,
      severity: findings.severity,
      title: findings.title,
      detail: findings.detailJson,
      file: findings.file,
      line: findings.line,
    })
    .from(findings)
    .where(eq(findings.runId, id))
    .orderBy(findings.id);
  return { ...toItem(rest), checks: (checksJson ?? []) as StoredCheck[], error, findings: list };
}

export type RunDetail = NonNullable<Awaited<ReturnType<typeof getRun>>>;
