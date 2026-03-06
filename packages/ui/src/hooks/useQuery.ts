import { useState, useEffect, useRef, useCallback } from "react";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const DEFAULT_TTL = 30_000; // 30 seconds

export function invalidate(keyPrefix: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(keyPrefix)) cache.delete(k);
  }
}

export function invalidateExact(key: string): void {
  cache.delete(key);
}

interface UseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: { ttl?: number; refetchInterval?: number },
): UseQueryResult<T> {
  const ttl = opts?.ttl ?? DEFAULT_TTL;
  const cached = cache.get(key) as CacheEntry<T> | undefined;
  const isFresh = cached && Date.now() - cached.timestamp < ttl;

  const [data, setData] = useState<T | null>(cached?.data ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const doFetch = useCallback(() => {
    // Deduplicate concurrent requests for the same key
    let promise = inflight.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = fetcher();
      inflight.set(key, promise);
      promise.finally(() => inflight.delete(key));
    }

    promise
      .then((result) => {
        cache.set(key, { data: result, timestamp: Date.now() });
        if (mountedRef.current) {
          setData(result);
          setLoading(false);
          setError(null);
        }
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });
  }, [key, fetcher]);

  useEffect(() => {
    mountedRef.current = true;
    if (isFresh) {
      // Cache is fresh — serve it, no fetch
      setData(cached!.data);
      setLoading(false);
    } else if (cached) {
      // Stale cache — show stale data immediately, refetch in background
      setData(cached.data);
      setLoading(false);
      doFetch();
    } else {
      // No cache — must fetch
      setLoading(true);
      doFetch();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Optional polling
  useEffect(() => {
    if (!opts?.refetchInterval) return;
    const interval = setInterval(doFetch, opts.refetchInterval);
    return () => clearInterval(interval);
  }, [opts?.refetchInterval, doFetch]);

  const refresh = useCallback(() => {
    cache.delete(key);
    setLoading(!data);
    doFetch();
  }, [key, data, doFetch]);

  return { data, loading, error, refresh };
}
