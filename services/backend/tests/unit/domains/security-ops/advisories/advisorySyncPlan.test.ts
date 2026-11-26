import { describe, expect, it } from 'vitest';

import {
  estimateBackfillWindows,
  hasFurtherWindows,
  planNextSync,
} from '@/domains/security-ops/advisories/advisorySyncPlan';

const at = (iso: string) => new Date(iso);

describe('planNextSync', () => {
  const now = at('2026-06-01T00:00:00.000Z');

  it('opens a backfill window on a cold start', () => {
    const plan = planNextSync({ cursor: null, now, backfillDays: 30 });
    expect(plan.startIndex).toBe(0);
    expect(plan.queryMode).toBe('publication');
    expect(plan.resumed).toBe(false);
    expect(plan.windowStart).toEqual(at('2026-05-02T00:00:00.000Z'));
    expect(plan.windowEnd).toEqual(now);
  });

  it('caps a cold-start window at the API limit', () => {
    const plan = planNextSync({ cursor: null, now, backfillDays: 3650 });
    const days = (plan.windowEnd.getTime() - plan.windowStart.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(120);
  });

  it('resumes an interrupted window at the page it reached', () => {
    // The whole reason the cursor stores a page offset: re-reading a 120-day
    // window from zero can mean tens of thousands of records.
    const plan = planNextSync({
      cursor: {
        mode: 'publication',
        windowStart: at('2026-01-01T00:00:00.000Z'),
        windowEnd: at('2026-04-01T00:00:00.000Z'),
        pageOffset: 6000,
        lastStatus: 'partial',
      },
      now,
      backfillDays: 30,
    });

    expect(plan).toMatchObject({
      windowStart: at('2026-01-01T00:00:00.000Z'),
      windowEnd: at('2026-04-01T00:00:00.000Z'),
      startIndex: 6000,
      resumed: true,
    });
  });

  it('resumes after a failure too', () => {
    const plan = planNextSync({
      cursor: {
        mode: 'publication',
        windowStart: at('2026-01-01T00:00:00.000Z'),
        windowEnd: at('2026-04-01T00:00:00.000Z'),
        pageOffset: 200,
        lastStatus: 'failed',
      },
      now,
      backfillDays: 30,
    });
    expect(plan).toMatchObject({ startIndex: 200, resumed: true });
  });

  it('continues from the end of a completed window with no gap', () => {
    // Starting anywhere later would let a modification fall between windows.
    const plan = planNextSync({
      cursor: {
        mode: 'modification',
        windowStart: at('2026-01-01T00:00:00.000Z'),
        windowEnd: at('2026-04-01T00:00:00.000Z'),
        pageOffset: 8000,
        lastStatus: 'ok',
      },
      now,
      backfillDays: 30,
    });

    expect(plan).toMatchObject({
      queryMode: 'modification',
      windowStart: at('2026-04-01T00:00:00.000Z'),
      startIndex: 0,
      resumed: false,
    });
  });
});

describe('hasFurtherWindows', () => {
  it('keeps walking while the cursor trails the present', () => {
    expect(hasFurtherWindows(at('2026-04-01T00:00:00.000Z'), at('2026-06-01T00:00:00.000Z'))).toBe(
      true,
    );
    expect(hasFurtherWindows(at('2026-06-01T00:00:00.000Z'), at('2026-06-01T00:00:00.000Z'))).toBe(
      false,
    );
  });
});

describe('estimateBackfillWindows', () => {
  it('reports how many windows a backfill needs', () => {
    expect(estimateBackfillWindows(30)).toBe(1);
    expect(estimateBackfillWindows(120)).toBe(1);
    expect(estimateBackfillWindows(121)).toBe(2);
    // ~25 years of CVE history
    expect(estimateBackfillWindows(9125)).toBe(77);
  });
});
