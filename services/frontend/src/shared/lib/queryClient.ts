/**
 * Shared React Query configuration.
 *
 * Lives outside App.tsx so the defaults are reviewable and testable on their
 * own — they control the app's entire request volume, and the API is rate
 * limited per client.
 */

import { QueryClient, type DefaultOptions } from '@tanstack/react-query';

/**
 * How long fetched data is served from cache before a refetch is considered.
 *
 * React Query defaults this to 0, which means every re-mount refetches. Moving
 * between pages re-mounts the same queries, so clicking around quickly used to
 * fire a full set of requests per click and trip the API rate limit. Writes are
 * unaffected: mutations invalidate explicitly, and invalidation ignores this.
 */
export const DEFAULT_STALE_TIME_MS = 10_000;

/** Statuses where another attempt cannot succeed, or makes things worse. */
const NON_RETRYABLE_STATUSES = new Set([
  400, // malformed request - identical retry gets an identical answer
  401, // not authenticated - needs a new token, not another try
  403, // not authorised - needs different permissions
  404, // absent - retrying will not conjure it
  429, // rate limited - retrying spends the next window's budget
]);

const statusOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
};

/**
 * Retry predicate shared by every query.
 *
 * Note this sits *above* the fetch-level retry in `api/client.ts`. Both layers
 * retrying the same request multiplies attempts, so each layer only retries
 * what the other does not.
 */
export const shouldRetryQuery = (failureCount: number, error: unknown): boolean => {
  const status = statusOf(error);
  if (status !== undefined && NON_RETRYABLE_STATUSES.has(status)) return false;
  return failureCount < 2;
};

export const queryClientDefaultOptions: DefaultOptions = {
  queries: {
    staleTime: DEFAULT_STALE_TIME_MS,
    // Tab focus is a poor proxy for "this data changed". Queries that genuinely
    // need it opt back in individually.
    refetchOnWindowFocus: false,
    retry: shouldRetryQuery,
  },
};

export const createQueryClient = (): QueryClient =>
  new QueryClient({ defaultOptions: queryClientDefaultOptions });
