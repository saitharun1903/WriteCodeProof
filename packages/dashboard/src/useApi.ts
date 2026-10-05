import { useCallback, useEffect, useRef, useState } from 'react';

/** How often a page with unfinished runs asks for news. */
export const REFRESH_MS = 5000;

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload(): void;
}

/**
 * Fetch on mount and when `key` changes. While `keepRefreshing(data)` is true
 * the request repeats every REFRESH_MS, so queued and running runs update by
 * themselves.
 */
export function useApi<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  keepRefreshing: (data: T) => boolean = () => false,
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  const refreshRef = useRef(keepRefreshing);
  loadRef.current = load;
  refreshRef.current = keepRefreshing;

  // A new key is a new page: forget what the old one showed.
  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
  }, [key]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    loadRef
      .current(controller.signal)
      .then((result) => {
        setData(result);
        setError(null);
        if (refreshRef.current(result)) {
          timer = window.setTimeout(() => setTick((t) => t + 1), REFRESH_MS);
        }
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((t) => t + 1);
  }, []);
  return { data, error, loading, reload };
}
