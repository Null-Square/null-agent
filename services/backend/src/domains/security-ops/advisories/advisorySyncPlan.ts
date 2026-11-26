import { MAX_WINDOW_DAYS, clampWindowEnd } from './NvdClient';

/**
 * Pure planning for the advisory sync cursor.
 *
 * Extracted from the service so the resumption rules — the part a crash
 * actually exercises — can be tested without a database or a network. A single
 * timestamp cursor cannot express "halfway through page 7 of a 120-day
 * window", and getting that wrong either restarts a window that holds tens of
 * thousands of records or silently skips its tail.
 */

export type SyncPlan = {
  queryMode: 'publication' | 'modification';
  windowStart: Date;
  windowEnd: Date;
  startIndex: number;
  /** True when this plan resumes an interrupted window rather than opening one. */
  resumed: boolean;
};

export type CursorState = {
  mode: 'publication' | 'modification';
  windowStart: Date | null;
  windowEnd: Date | null;
  pageOffset: number;
  lastStatus: string | null;
};

const daysAgo = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/**
 * Decide what to fetch next.
 *
 * Three cases, in order of precedence:
 *
 *  1. **An interrupted window** — the previous run ended `partial` or `failed`.
 *     Resume it at the page it reached; never advance past data we did not
 *     confirm we read.
 *  2. **A completed window** — continue forward from where it ended.
 *  3. **A cold start** — walk back `backfillDays` and begin, in windows the API
 *     will accept.
 */
export const planNextSync = (params: {
  cursor: CursorState | null;
  now: Date;
  /** How far back a cold start reaches. */
  backfillDays: number;
}): SyncPlan => {
  const { cursor, now } = params;

  if (cursor?.windowStart && cursor.windowEnd) {
    const interrupted = cursor.lastStatus === 'partial' || cursor.lastStatus === 'failed';

    if (interrupted) {
      return {
        queryMode: cursor.mode,
        windowStart: cursor.windowStart,
        windowEnd: cursor.windowEnd,
        startIndex: cursor.pageOffset,
        resumed: true,
      };
    }

    // The previous window completed. Start where it ended so no modification
    // can fall between two windows.
    const windowStart = cursor.windowEnd;
    return {
      queryMode: cursor.mode,
      windowStart,
      windowEnd: clampWindowEnd(windowStart, now),
      startIndex: 0,
      resumed: false,
    };
  }

  const windowStart = daysAgo(now, params.backfillDays);
  return {
    // A cold start must be publication-based. Querying old modification
    // windows produces an apparently successful but mostly empty corpus.
    queryMode: 'publication',
    windowStart,
    windowEnd: clampWindowEnd(windowStart, now),
    startIndex: 0,
    resumed: false,
  };
};

/**
 * Whether a completed window still trails the present, meaning the backfill
 * should keep walking forward on the next tick rather than idling.
 */
export const hasFurtherWindows = (windowEnd: Date, now: Date): boolean =>
  windowEnd.getTime() < now.getTime();

/**
 * How long a full backfill will take, given the client's rate limit.
 *
 * Surfaced so the operational cost of running keyless is visible before someone
 * starts a backfill that would take days: 5 requests per 30s versus 50 is the
 * difference between hours and a week.
 */
export const estimateBackfillWindows = (backfillDays: number): number =>
  Math.max(1, Math.ceil(backfillDays / MAX_WINDOW_DAYS));
