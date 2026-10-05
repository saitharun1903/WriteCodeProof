import { formatDuration } from '@writecode-proof/core/labels';
import { api, isActive, type RunPage, type RunQuery } from './api.js';
import { Message, RiskBadge, RunStatus } from './components.js';
import { changeLabel, fullTime, timeAgo } from './format.js';
import { Link, useRouter } from './router.js';
import { useApi } from './useApi.js';

const SOURCES = [
  { value: null, label: 'All' },
  { value: 'github', label: 'Pull requests' },
  { value: 'cli', label: 'Local checks' },
] as const;

function queryFrom(params: URLSearchParams): RunQuery {
  const page = Math.max(1, Number(params.get('page')) || 1);
  const source = params.get('source');
  return { page, source: source === 'cli' || source === 'github' ? source : null };
}

function href({ page, source }: RunQuery): string {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/?${qs}` : '/';
}

function EmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) return <Message title="No runs of this kind yet." />;
  return (
    <Message title="No runs yet.">
      <p>
        Check a change locally with <code>npx writecode-proof check</code> while{' '}
        <code>DATABASE_URL</code> is set, or open a pull request on a repository where the GitHub
        App is installed. Runs show up here as they start.
      </p>
    </Message>
  );
}

function Pager({ data, query }: { data: RunPage; query: RunQuery }) {
  const first = (data.page - 1) * data.pageSize + 1;
  const last = Math.min(data.total, data.page * data.pageSize);
  const hasNewer = data.page > 1;
  const hasOlder = last < data.total;
  if (!hasNewer && !hasOlder) return null;
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted">
        {first}–{last} of {data.total}
      </span>
      {hasNewer && <Link to={href({ ...query, page: data.page - 1 })}>← Newer</Link>}
      {hasOlder && <Link to={href({ ...query, page: data.page + 1 })}>Older →</Link>}
    </nav>
  );
}

export function RunsPage() {
  const { query: params } = useRouter();
  const query = queryFrom(params);
  const key = href(query);
  const { data, error, loading, reload } = useApi(
    key,
    (signal) => api.runs(query, signal),
    (page) => page.items.some((r) => isActive(r.status)),
  );

  return (
    <>
      <header className="page-header">
        <h1>Runs</h1>
        <div className="segmented" role="group" aria-label="Show">
          {SOURCES.map((s) => (
            <Link
              key={s.label}
              to={href({ page: 1, source: s.value })}
              aria-current={query.source === s.value ? 'page' : undefined}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </header>

      {error && (
        <Message tone="error" title="Could not load runs.">
          <p>{error.message}</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </Message>
      )}
      {!error && loading && !data && <p className="muted">Loading runs…</p>}
      {data && data.items.length === 0 && <EmptyState filtered={query.source !== null} />}

      {data && data.items.length > 0 && (
        <>
          <table className="runs">
            <thead>
              <tr>
                <th scope="col">Risk</th>
                <th scope="col">Change</th>
                <th scope="col" className="col-status">
                  Status
                </th>
                <th scope="col" className="col-why">
                  Why
                </th>
                <th scope="col" className="col-took">
                  Took
                </th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((run) => (
                <tr key={run.id}>
                  <td>
                    <RiskBadge score={run.riskScore} band={run.riskBand} />
                  </td>
                  <td>
                    <Link to={`/runs/${run.id}`} className="run-link">
                      <span className="run-link__repo">{run.repo ?? 'unknown repository'}</span>
                      <span className="run-link__change">{changeLabel(run)}</span>
                    </Link>
                    <span className="source">
                      {run.source === 'github' ? 'Pull request' : 'Local check'}
                      {/* Narrow screens hide the Status column; show what matters inline. */}
                      {run.status !== 'done' && (
                        <span className="status-inline">
                          {' · '}
                          <RunStatus status={run.status} />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="col-status">
                    <RunStatus status={run.status} />
                  </td>
                  <td className="col-why">
                    <span className="why">{run.why?.replace(/^Why [\d.]+: /, '') ?? ''}</span>
                  </td>
                  <td className="col-took muted">
                    {run.durationMs !== null ? formatDuration(run.durationMs) : ''}
                  </td>
                  <td>
                    <time dateTime={run.createdAt} title={fullTime(run.createdAt)}>
                      {timeAgo(run.createdAt)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager data={data} query={query} />
        </>
      )}
    </>
  );
}
