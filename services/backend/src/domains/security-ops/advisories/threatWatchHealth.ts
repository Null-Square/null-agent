import type { AdvisoryFeedState } from './AdvisoryRepository';

export type ThreatWatchOperationalStatus =
  | 'disabled'
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'down';

export type ThreatWatchOperationalPhase =
  | 'disabled'
  | 'starting'
  | 'backfilling'
  | 'steady_state'
  | 'stalled';

export type ThreatWatchHealth = {
  status: ThreatWatchOperationalStatus;
  phase: ThreatWatchOperationalPhase;
  summary: string;
  hoursBehind: number | null;
  lastRunAgeMinutes: number | null;
  issues: string[];
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAILY_FEED_STALE_MS = 36 * HOUR_MS;

const ageMs = (now: Date, value: Date | null | undefined): number | null =>
  value ? Math.max(0, now.getTime() - value.getTime()) : null;

export const isThreatWatchCycleDue = (input: {
  enabled: boolean;
  intervalMinutes: number;
  nvd: AdvisoryFeedState | null;
  now: Date;
}): boolean => {
  if (!input.enabled) return false;
  if (!input.nvd?.lastRunAt) return true;

  const dueAt = input.nvd.nextRunAt
    ?? new Date(input.nvd.lastRunAt.getTime() + input.intervalMinutes * MINUTE_MS);
  return input.now.getTime() >= dueAt.getTime();
};

export const isSnapshotFeedDue = (
  state: AdvisoryFeedState | null,
  now: Date,
): boolean => !state?.nextRunAt || now.getTime() >= state.nextRunAt.getTime();

/**
 * Derive health from execution freshness, not cursor age alone.
 *
 * A historical cursor can be years behind while making healthy forward
 * progress. That is `backfilling`, not `down`. The service is down only when
 * NVD attempts repeatedly fail or no owner completes work for several expected
 * intervals. Daily enrichment failures degrade prioritization but do not claim
 * that advisory monitoring itself stopped.
 */
export const deriveThreatWatchHealth = (input: {
  enabled: boolean;
  intervalMinutes: number;
  nvd: AdvisoryFeedState | null;
  kev: AdvisoryFeedState | null;
  epss: AdvisoryFeedState | null;
  now: Date;
}): ThreatWatchHealth => {
  if (!input.enabled) {
    return {
      status: 'disabled',
      phase: 'disabled',
      summary: 'Vulnerability monitoring is switched off in settings.',
      hoursBehind: null,
      lastRunAgeMinutes: null,
      issues: [],
    };
  }

  const nvd = input.nvd;
  if (!nvd?.lastRunAt) {
    return {
      status: 'starting',
      phase: 'starting',
      summary: 'Monitoring is enabled and waiting for its first NVD cycle.',
      hoursBehind: nvd?.windowEnd
        ? Math.max(0, Math.round(ageMs(input.now, nvd.windowEnd)! / HOUR_MS))
        : null,
      lastRunAgeMinutes: null,
      issues: [],
    };
  }

  const lastRunAge = ageMs(input.now, nvd.lastRunAt) ?? 0;
  const lastRunAgeMinutes = Math.round(lastRunAge / MINUTE_MS);
  const hoursBehind = nvd.windowEnd
    ? Math.max(0, Math.round((ageMs(input.now, nvd.windowEnd) ?? 0) / HOUR_MS))
    : null;
  const stallAfterMs = Math.max(6 * HOUR_MS, input.intervalMinutes * 3 * MINUTE_MS);
  const nvdStalled = lastRunAge > stallAfterMs || nvd.consecutiveFailures >= 3;
  const backfilling = hoursBehind !== null && hoursBehind > 6;
  const issues: string[] = [];

  if (nvd.lastStatus === 'failed' || (nvd.lastStatus === 'partial' && nvd.lastError)) {
    issues.push(`NVD: ${nvd.lastError ?? nvd.lastStatus}`);
  }

  for (const [label, feed] of [['KEV', input.kev], ['EPSS', input.epss]] as const) {
    if (!feed?.lastSuccessAt) {
      issues.push(`${label}: no successful refresh yet`);
      continue;
    }
    if ((ageMs(input.now, feed.lastSuccessAt) ?? 0) > DAILY_FEED_STALE_MS) {
      issues.push(`${label}: latest successful snapshot is stale`);
    } else if (feed.lastStatus === 'failed') {
      issues.push(`${label}: latest refresh failed`);
    }
  }

  if (nvdStalled) {
    return {
      status: 'down',
      phase: 'stalled',
      summary: nvd.lastError
        ? `NVD synchronization is stalled: ${nvd.lastError}`
        : `No successful NVD progress for ${lastRunAgeMinutes} minutes.`,
      hoursBehind,
      lastRunAgeMinutes,
      issues,
    };
  }

  if (backfilling) {
    return {
      status: 'degraded',
      phase: 'backfilling',
      summary: `Historical advisory backfill is progressing; the cursor is ${hoursBehind} hours behind.`,
      hoursBehind,
      lastRunAgeMinutes,
      issues,
    };
  }

  if (issues.length > 0) {
    return {
      status: 'degraded',
      phase: 'steady_state',
      summary: `Advisory monitoring is current, with ${issues.length} enrichment issue${issues.length === 1 ? '' : 's'}.`,
      hoursBehind,
      lastRunAgeMinutes,
      issues,
    };
  }

  return {
    status: 'healthy',
    phase: 'steady_state',
    summary: 'Advisory monitoring and exploitation-signal feeds are current.',
    hoursBehind,
    lastRunAgeMinutes,
    issues,
  };
};
