import { describe, expect, it } from 'vitest';

import type { AdvisoryFeedState } from '@/domains/security-ops/advisories/AdvisoryRepository';
import {
  deriveThreatWatchHealth,
  isSnapshotFeedDue,
  isThreatWatchCycleDue,
} from '@/domains/security-ops/advisories/threatWatchHealth';

const NOW = new Date('2026-08-21T12:00:00.000Z');

const feed = (
  source: 'nvd' | 'kev' | 'epss',
  overrides: Partial<AdvisoryFeedState> = {},
): AdvisoryFeedState => ({
  source,
  mode: source === 'nvd' ? 'publication' : 'modification',
  windowStart: new Date('2026-08-20T00:00:00.000Z'),
  windowEnd: new Date('2026-08-21T11:00:00.000Z'),
  pageOffset: 0,
  backfillStartedAt: source === 'nvd' ? new Date('2026-08-20T00:00:00.000Z') : null,
  lastRunAt: new Date('2026-08-21T11:00:00.000Z'),
  lastSuccessAt: new Date('2026-08-21T11:00:00.000Z'),
  nextRunAt: new Date('2026-08-21T13:00:00.000Z'),
  lastStatus: 'ok',
  lastError: null,
  consecutiveFailures: 0,
  recordsIngested: 10,
  ...overrides,
});

describe('Threat Watch scheduling and health', () => {
  it('uses the persisted due time so a restart does not start an early duplicate cycle', () => {
    expect(isThreatWatchCycleDue({
      enabled: true,
      intervalMinutes: 120,
      nvd: feed('nvd'),
      now: NOW,
    })).toBe(false);
    expect(isThreatWatchCycleDue({
      enabled: true,
      intervalMinutes: 120,
      nvd: feed('nvd', { nextRunAt: new Date('2026-08-21T11:59:59.000Z') }),
      now: NOW,
    })).toBe(true);
  });

  it('starts immediately only when enabled and no prior NVD attempt exists', () => {
    expect(isThreatWatchCycleDue({ enabled: true, intervalMinutes: 120, nvd: null, now: NOW })).toBe(true);
    expect(isThreatWatchCycleDue({ enabled: false, intervalMinutes: 120, nvd: null, now: NOW })).toBe(false);
  });

  it('treats a progressing historical cursor as backfill, not an outage', () => {
    const result = deriveThreatWatchHealth({
      enabled: true,
      intervalMinutes: 120,
      nvd: feed('nvd', { windowEnd: new Date('2017-01-01T00:00:00.000Z') }),
      kev: feed('kev'),
      epss: feed('epss'),
      now: NOW,
    });

    expect(result.status).toBe('degraded');
    expect(result.phase).toBe('backfilling');
    expect(result.summary).toMatch(/backfill is progressing/iu);
  });

  it('marks NVD down only after repeated failures or missed execution', () => {
    const oneFailure = deriveThreatWatchHealth({
      enabled: true,
      intervalMinutes: 120,
      nvd: feed('nvd', {
        lastStatus: 'failed',
        lastError: 'NVD unavailable',
        consecutiveFailures: 1,
      }),
      kev: feed('kev'),
      epss: feed('epss'),
      now: NOW,
    });
    const repeatedFailures = deriveThreatWatchHealth({
      enabled: true,
      intervalMinutes: 120,
      nvd: feed('nvd', {
        lastStatus: 'failed',
        lastError: 'NVD unavailable',
        consecutiveFailures: 3,
      }),
      kev: feed('kev'),
      epss: feed('epss'),
      now: NOW,
    });

    expect(oneFailure.status).toBe('degraded');
    expect(repeatedFailures.status).toBe('down');
    expect(repeatedFailures.phase).toBe('stalled');
  });

  it('degrades current advisory monitoring when a daily signal feed is stale', () => {
    const result = deriveThreatWatchHealth({
      enabled: true,
      intervalMinutes: 120,
      nvd: feed('nvd'),
      kev: feed('kev', { lastSuccessAt: new Date('2026-08-19T00:00:00.000Z') }),
      epss: feed('epss'),
      now: NOW,
    });

    expect(result.status).toBe('degraded');
    expect(result.phase).toBe('steady_state');
    expect(result.issues).toContain('KEV: latest successful snapshot is stale');
  });

  it('schedules snapshot feeds from their own persisted clocks', () => {
    expect(isSnapshotFeedDue(feed('kev'), NOW)).toBe(false);
    expect(isSnapshotFeedDue(feed('kev', { nextRunAt: NOW }), NOW)).toBe(true);
    expect(isSnapshotFeedDue(null, NOW)).toBe(true);
  });
});
