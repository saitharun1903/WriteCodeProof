import type { BAND_LABEL } from '@writecode-proof/core/labels';
import {
  BAND_ACTION,
  CHECK_LABEL,
  CHECK_ORDER,
  formatDuration,
  SEVERITY_ORDER,
  shortId,
} from '@writecode-proof/core/labels';
import { api, isActive, type Finding, type Meta, type Run } from './api.js';
import { CheckIcon, Message, RiskBadge, RunStatus, Severity } from './components.js';
import { changeLabel, fullTime, pullRequestUrl, shortSha, timeAgo } from './format.js';
import { Link } from './router.js';
import { useApi } from './useApi.js';

type CheckName = keyof typeof CHECK_LABEL;

function examplesOf(f: Finding): string[] {
  const list = (f.detail as { examples?: { summary?: string }[] }).examples;
  return Array.isArray(list)
    ? list
        .slice(1)
        .map((e) => e.summary ?? '')
        .filter(Boolean)
    : [];
}

function messageOf(f: Finding): string | null {
  const message = (f.detail as { message?: unknown }).message;
  return typeof message === 'string' && message ? message : null;
}

function FindingItem({ finding }: { finding: Finding }) {
  const examples = examplesOf(finding);
  const message = messageOf(finding);
  return (
    <li className="finding">
      <div className="finding__head">
        <Severity level={finding.severity} />
        <span className="finding__title">{finding.title}</span>
      </div>
      {finding.file && (
        <code className="finding__where">
          {finding.file}
          {finding.line ? `:${finding.line}` : ''}
        </code>
      )}
      {examples.length > 0 && (
        <ul className="finding__examples">
          {examples.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {message && <pre className="finding__message">{message}</pre>}
    </li>
  );
}

function Title({ run, meta }: { run: Run; meta: Meta | null }) {
  const url = pullRequestUrl(run, meta?.githubWebUrl ?? null);
  const change = changeLabel(run);
  return (
    <h1 className="run-title">
      <span>{run.repo ?? 'Unknown repository'}</span>{' '}
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {change}
        </a>
      ) : (
        <span className="muted">{change}</span>
      )}
    </h1>
  );
}

function Summary({ run }: { run: Run }) {
  if (run.status === 'queued' || run.status === 'running') {
    return (
      <Message title={run.status === 'queued' ? 'Waiting to start.' : 'Checking this change now.'}>
        <p>This page updates by itself.</p>
      </Message>
    );
  }
  if (run.status === 'cancelled') {
    return <Message title="Superseded by a newer push, so this run did not finish." />;
  }
  if (run.status === 'error') {
    return (
      <Message tone="error" title="The checks could not finish.">
        {run.error && <pre className="finding__message">{run.error}</pre>}
      </Message>
    );
  }
  const band = run.riskBand as keyof typeof BAND_LABEL | null;
  return (
    <section className="risk-panel" aria-label="Risk">
      <RiskBadge score={run.riskScore} band={run.riskBand} large />
      <div>
        {band && band in BAND_ACTION && <p className="risk-panel__action">{BAND_ACTION[band]}</p>}
        {run.why && <p className="risk-panel__why">{run.why}</p>}
      </div>
    </section>
  );
}

export function RunPage({ id }: { id: string }) {
  const {
    data: run,
    error,
    reload,
  } = useApi(
    `run:${id}`,
    (signal) => api.run(id, signal),
    (r) => isActive(r.status),
  );
  const { data: meta } = useApi('meta', (signal) => api.meta(signal));

  if (error) {
    const missing = 'status' in error && error.status === 404;
    return (
      <>
        <Link to="/" className="back">
          ← All runs
        </Link>
        <Message
          tone="error"
          title={missing ? 'There is no run with this id.' : 'Could not load this run.'}
        >
          {!missing && (
            <>
              <p>{error.message}</p>
              <button type="button" onClick={reload}>
                Try again
              </button>
            </>
          )}
        </Message>
      </>
    );
  }
  if (!run) return <p className="muted">Loading run…</p>;

  const checks = CHECK_ORDER.map((name) => run.checks.find((c) => c.check === name)).filter(
    (c): c is NonNullable<typeof c> => !!c,
  );
  const rank = (f: Finding) => SEVERITY_ORDER.indexOf(f.severity);
  // Groups with the most serious finding come first; within a group, worst first.
  const groups = CHECK_ORDER.map((check) => ({
    check,
    findings: run.findings.filter((f) => f.check === check).sort((a, b) => rank(a) - rank(b)),
  }))
    .filter((g) => g.findings.length > 0)
    .sort((a, b) => rank(a.findings[0]!) - rank(b.findings[0]!));
  const withNotes = checks.filter((c) => c.notes.length > 0);

  return (
    <>
      <Link to="/" className="back">
        ← All runs
      </Link>
      <header className="page-header page-header--run">
        <Title run={run} meta={meta} />
        <RunStatus status={run.status} />
      </header>
      <dl className="facts">
        <div>
          <dt>Source</dt>
          <dd>{run.source === 'github' ? 'Pull request' : 'Local check'}</dd>
        </div>
        <div>
          <dt>Compared</dt>
          <dd>
            <code>{shortSha(run.baseSha)}</code> →{' '}
            <code>{run.headSha ? shortSha(run.headSha) : 'working tree'}</code>
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            <time dateTime={run.createdAt} title={fullTime(run.createdAt)}>
              {timeAgo(run.createdAt)}
            </time>
          </dd>
        </div>
        {run.durationMs !== null && (
          <div>
            <dt>Took</dt>
            <dd>{formatDuration(run.durationMs)}</dd>
          </div>
        )}
        <div>
          <dt>Run</dt>
          <dd>
            <code title={run.id}>{shortId(run.id)}</code>
          </dd>
        </div>
      </dl>

      <Summary run={run} />

      {checks.length > 0 && (
        <section aria-labelledby="checks-heading">
          <h2 id="checks-heading">Checks</h2>
          <table className="checks">
            <tbody>
              {checks.map((c) => (
                <tr key={c.check}>
                  <td className="checks__icon">
                    <CheckIcon status={c.status} />
                  </td>
                  <th scope="row">{CHECK_LABEL[c.check as CheckName]}</th>
                  <td>{c.summary}</td>
                  <td className="muted checks__took">
                    {c.durationMs ? formatDuration(c.durationMs) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {groups.length > 0 && (
        <section aria-labelledby="findings-heading">
          <h2 id="findings-heading">Findings</h2>
          {groups.map(({ check, findings }) => (
            <div key={check} className="finding-group">
              <h3>{CHECK_LABEL[check]}</h3>
              <ul className="findings">
                {findings.map((f, i) => (
                  <FindingItem key={`${f.title}-${i}`} finding={f} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {withNotes.length > 0 && (
        <section aria-labelledby="notes-heading">
          <h2 id="notes-heading">Notes</h2>
          <ul className="notes">
            {withNotes.flatMap((c) =>
              c.notes.map((note) => (
                <li key={`${c.check}-${note}`}>
                  <span className="muted">{CHECK_LABEL[c.check as CheckName]}:</span> {note}
                </li>
              )),
            )}
          </ul>
        </section>
      )}
    </>
  );
}
