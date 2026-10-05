import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Spec section 11. Source code is never stored: only findings and short snippets.

export const runSource = pgEnum('run_source', ['cli', 'github']);
export const runStatus = pgEnum('run_status', ['queued', 'running', 'done', 'error', 'cancelled']);
export const checkName = pgEnum('check_name', [
  'existing_tests',
  'generated_tests',
  'behaviour_diff',
  'security',
]);
export const severity = pgEnum('severity', ['critical', 'high', 'medium', 'low', 'info']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

export const installations = pgTable('installations', {
  id: serial('id').primaryKey(),
  githubInstallationId: bigint('github_installation_id', { mode: 'number' }).notNull().unique(),
  accountLogin: text('account_login').notNull(),
  createdAt: createdAt(),
});

export const repos = pgTable('repos', {
  id: serial('id').primaryKey(),
  installationId: integer('installation_id').references(() => installations.id, {
    onDelete: 'set null',
  }),
  fullName: text('full_name').notNull().unique(),
  configJson: jsonb('config_json'),
  createdAt: createdAt(),
});

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    /** Display name for CLI runs, which have no repo row (folder or remote name). */
    repoLabel: text('repo_label'),
    source: runSource('source').notNull(),
    prNumber: integer('pr_number'),
    baseSha: text('base_sha').notNull(),
    /** Null when a CLI run checked the working tree. */
    headSha: text('head_sha'),
    status: runStatus('status').notNull(),
    riskScore: real('risk_score'),
    riskBand: text('risk_band'),
    why: text('why'),
    /** Some checks could not run: the score is a lower bound. */
    incomplete: boolean('incomplete').notNull().default(false),
    /** Per-check status and summary (findings live in their own table). */
    checksJson: jsonb('checks_json'),
    /** Why the run did not finish, when status is error. */
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('runs_created_at_idx').on(t.createdAt),
    index('runs_repo_pr_idx').on(t.repoId, t.prNumber),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: serial('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    check: checkName('check').notNull(),
    severity: severity('severity').notNull(),
    title: text('title').notNull(),
    detailJson: jsonb('detail_json').notNull(),
    file: text('file'),
    line: integer('line'),
    createdAt: createdAt(),
  },
  (t) => [index('findings_run_idx').on(t.runId)],
);
