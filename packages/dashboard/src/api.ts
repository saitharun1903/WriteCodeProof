import type { RunDetail, RunListItem, RunSource } from '@writecode-proof/db';

/** Dates arrive from the API as ISO strings. */
type Json<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

export type RunSummary = Json<RunListItem>;
export type Run = Json<RunDetail>;
export type Finding = Run['findings'][number];
export type StoredCheck = Run['checks'][number];

export interface RunPage {
  items: RunSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Meta {
  version: string;
  githubWebUrl: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'The API is not reachable.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface RunQuery {
  page: number;
  source: RunSource | null;
}

export const api = {
  runs({ page, source }: RunQuery, signal?: AbortSignal) {
    const params = new URLSearchParams({ page: String(page) });
    if (source) params.set('source', source);
    return get<RunPage>(`/api/runs?${params}`, signal);
  },
  run: (id: string, signal?: AbortSignal) =>
    get<Run>(`/api/runs/${encodeURIComponent(id)}`, signal),
  meta: (signal?: AbortSignal) => get<Meta>('/api/meta', signal),
};

/** Statuses whose page should keep refreshing. */
export const isActive = (status: RunSummary['status']) =>
  status === 'queued' || status === 'running';
