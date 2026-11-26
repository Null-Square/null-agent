import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_TIME_MS,
  createQueryClient,
  queryClientDefaultOptions,
  shouldRetryQuery,
} from './queryClient';

describe('queryClient defaults', () => {
  // These defaults govern the app's whole request volume against a rate
  // limited API. React Query's own defaults (staleTime 0, refetch on focus,
  // retry 3) made fast navigation refetch everything per click and then
  // multiply each rejection into further attempts.
  it('serves recent data from cache instead of refetching on every mount', () => {
    expect(queryClientDefaultOptions.queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
    expect(DEFAULT_STALE_TIME_MS).toBeGreaterThan(0);
  });

  it('does not refetch merely because the tab regained focus', () => {
    expect(queryClientDefaultOptions.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('applies the defaults to the client it builds', () => {
    const defaults = createQueryClient().getDefaultOptions();

    expect(defaults.queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.queries?.retry).toBe(shouldRetryQuery);
  });

  describe('shouldRetryQuery', () => {
    it.each([
      [429, 'rate limited - retrying spends the next window'],
      [401, 'unauthenticated - needs a new token, not another try'],
      [403, 'unauthorised - needs different permissions'],
      [404, 'absent - retrying will not conjure it'],
      [400, 'malformed - an identical retry gets an identical answer'],
    ])('does not retry %i (%s)', (status) => {
      expect(shouldRetryQuery(0, { status })).toBe(false);
    });

    it('retries server errors, which may be transient', () => {
      expect(shouldRetryQuery(0, { status: 500 })).toBe(true);
      expect(shouldRetryQuery(1, { status: 503 })).toBe(true);
    });

    it('gives up after two attempts', () => {
      expect(shouldRetryQuery(2, { status: 500 })).toBe(false);
    });

    it('retries errors that carry no status, such as network failures', () => {
      expect(shouldRetryQuery(0, new Error('Failed to fetch'))).toBe(true);
      expect(shouldRetryQuery(0, null)).toBe(true);
    });
  });
});
