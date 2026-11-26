import type { DatabaseClient } from '@/db/client';
import {
  withPostgresAdvisoryLock,
  type AdvisoryLockResult,
} from '@/db/postgresAdvisoryLock';
import { logger } from '@/shared/logger';

import type { AdvisoryRepository } from './AdvisoryRepository';
import { NvdRateLimited, hasMorePages, type NvdClient } from './NvdClient';
import { deriveAffectedRanges, normalizeNvdAdvisory } from './nvdNormalizer';
import { hasFurtherWindows, planNextSync } from './advisorySyncPlan';

export type AdvisorySyncResult = {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  pagesFetched: number;
  advisoriesIngested: number;
  windowComplete: boolean;
  moreWindows: boolean;
  error?: string;
};

export type AdvisorySyncOptions = {
  /** Pages per tick, so one run cannot monopolise the rate-limit budget. */
  maxPagesPerRun?: number;
  /** How far back a cold start reaches. */
  backfillDays?: number;
  /** Test seam; production uses a PostgreSQL session advisory lock. */
  withLock?: <T>(run: () => Promise<T>) => Promise<AdvisoryLockResult<T>>;
};

export type AdvisorySyncRunOptions = {
  /** Runtime setting; lets Admin changes take effect without a restart. */
  maxPagesPerRun?: number;
  /** Durable scheduler due time persisted with every checkpoint. */
  nextRunAt?: Date | null;
  /** Short cadence while historical or paginated work remains. */
  continuationNextRunAt?: Date | null;
  /** Retry cadence for an actual provider failure. */
  retryNextRunAt?: Date | null;
};

/**
 * Incremental NVD synchronisation.
 *
 * Two properties matter more than throughput:
 *
 *  1. **The cursor never advances past data we did not confirm we read.** A
 *     rate limit or a crash leaves the window `partial`, and the next run
 *     resumes at the page it reached. Advancing optimistically would silently
 *     skip advisories, and a missed advisory is invisible — nobody ever gets
 *     the alert that should have fired.
 *  2. **Only one instance syncs at a time.** The tick is a plain interval in
 *     each replica, so without a lock every replica would ingest the same
 *     window and, downstream, every customer would be alerted twice.
 */
export class AdvisorySyncService {
  private readonly defaultMaxPagesPerRun: number;

  private readonly backfillDays: number;

  private readonly withLock: <T>(run: () => Promise<T>) => Promise<AdvisoryLockResult<T>>;

  constructor(
    private readonly db: DatabaseClient,
    private readonly client: NvdClient,
    private readonly repository: AdvisoryRepository,
    options: AdvisorySyncOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.defaultMaxPagesPerRun = options.maxPagesPerRun ?? 10;
    // A 30-day cold start would silently miss every still-relevant older CVE,
    // which is most of them: the software our customers run is frequently years
    // old. The window walker advances forward each tick, so a deep default
    // costs time rather than correctness.
    this.backfillDays = options.backfillDays ?? 3650;
    this.withLock = options.withLock ?? ((run) => withPostgresAdvisoryLock(
      this.db.$client,
      'threat-watch:advisory-sync:nvd',
      run,
    ));
  }

  /**
   * Run one synchronisation tick under an advisory lock.
   *
   * `pg_try_advisory_lock` rather than the blocking form: if another replica
   * holds it, the correct behaviour is to skip this tick, not to queue up a
   * second sync behind it.
   */
  async syncOnce(options: AdvisorySyncRunOptions = {}): Promise<AdvisorySyncResult> {
    const locked = await this.withLock(() => this.runSync(options));
    if (locked.acquired) return locked.value;

    logger.debug('[threat-watch] Advisory sync already running on another instance');
    return {
      status: 'skipped',
      pagesFetched: 0,
      advisoriesIngested: 0,
      windowComplete: false,
      moreWindows: false,
    };
  }

  private async runSync(options: AdvisorySyncRunOptions): Promise<AdvisorySyncResult> {
    const now = this.now();
    const maxPagesPerRun = Math.max(
      1,
      Math.floor(options.maxPagesPerRun ?? this.defaultMaxPagesPerRun),
    );
    const cursor = await this.repository.loadCursor('nvd');
    const plan = planNextSync({ cursor, now, backfillDays: this.backfillDays });
    const backfillStartedAt = cursor?.backfillStartedAt ?? now;

    let startIndex = plan.startIndex;
    let pagesFetched = 0;
    let advisoriesIngested = 0;

    logger.info(
      {
        windowStart: plan.windowStart.toISOString(),
        windowEnd: plan.windowEnd.toISOString(),
        startIndex,
        resumed: plan.resumed,
      },
      '[threat-watch] Advisory sync starting',
    );

    while (pagesFetched < maxPagesPerRun) {
      let page;
      try {
        page = await this.client.fetchPage({
          queryMode: plan.queryMode,
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
          startIndex,
        });
      } catch (error) {
        const rateLimited = error instanceof NvdRateLimited;
        const message = error instanceof Error ? error.message : 'unknown error';

        // Checkpoint at the page we actually reached, not the one we tried.
        await this.repository.saveCursor({
          source: 'nvd',
          mode: plan.queryMode,
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
          pageOffset: startIndex,
          status: rateLimited ? 'partial' : 'failed',
          error: message,
          recordsIngested: advisoriesIngested,
          backfillStartedAt,
          nextRunAt: options.retryNextRunAt ?? options.nextRunAt,
        });

        logger.warn(
          { err: error, startIndex, rateLimited },
          '[threat-watch] Advisory sync interrupted; window will resume',
        );

        return {
          status: rateLimited ? 'partial' : 'failed',
          pagesFetched,
          advisoriesIngested,
          windowComplete: false,
          moreWindows: true,
          error: message,
        };
      }

      pagesFetched += 1;

      const pageRows: Parameters<AdvisoryRepository['upsertPageFromSource']>[0][number][] = [];
      for (const cve of page.cves) {
        const normalized = normalizeNvdAdvisory(cve);
        if (!normalized) continue;

        pageRows.push({
          source: 'nvd',
          // Keyed on the canonical id, not the CVE id: a future feed may carry
          // no CVE, and the source record must still identify itself.
          sourceAdvisoryId: normalized.canonicalId,
          normalized,
          ranges: deriveAffectedRanges(cve),
          raw: cve,
        });
      }
      const persisted = await this.repository.upsertPageFromSource(pageRows);
      advisoriesIngested += persisted.advisoriesUpserted;

      if (!hasMorePages(page)) {
        // Window complete: advance so the next run starts where this ended.
        const moreWindows = hasFurtherWindows(plan.windowEnd, now);
        const nextMode = plan.queryMode === 'publication' && !moreWindows
          ? 'modification'
          : plan.queryMode;
        // Publication gives us the complete corpus as it exists when each page
        // is read. Modifications that occur while a long backfill is running
        // still need a delta pass. Rebase the modification cursor to the
        // durable start watermark at the handoff, then walk forward normally.
        const handingOffToModification = plan.queryMode === 'publication' && !moreWindows;
        const workRemaining = moreWindows || handingOffToModification;
        const savedWindowStart = handingOffToModification ? backfillStartedAt : plan.windowStart;
        const savedWindowEnd = handingOffToModification ? backfillStartedAt : plan.windowEnd;
        await this.repository.saveCursor({
          source: 'nvd',
          mode: nextMode,
          windowStart: savedWindowStart,
          windowEnd: savedWindowEnd,
          pageOffset: 0,
          backfillStartedAt,
          status: 'ok',
          error: null,
          recordsIngested: advisoriesIngested,
          nextRunAt: workRemaining
            ? (options.continuationNextRunAt ?? options.nextRunAt)
            : options.nextRunAt,
        });

        logger.info(
          { advisoriesIngested, pagesFetched, moreWindows: workRemaining },
          '[threat-watch] Advisory sync window complete',
        );

        return {
          status: 'ok',
          pagesFetched,
          advisoriesIngested,
          windowComplete: true,
          moreWindows: workRemaining,
        };
      }

      startIndex += page.returnedCount;

      // Checkpoint after every successful page, not only at window boundaries.
      // Saving only on failure or completion left a hard kill mid-loop replaying
      // the whole tick, which at 2000 records per page is real duplicated work
      // and, worse, is indistinguishable from progress in the cursor.
      await this.repository.saveCursor({
        source: 'nvd',
        mode: plan.queryMode,
        windowStart: plan.windowStart,
        windowEnd: plan.windowEnd,
        pageOffset: startIndex,
        status: 'partial',
        error: null,
        recordsIngested: 0,
        backfillStartedAt,
        nextRunAt: options.continuationNextRunAt ?? options.nextRunAt,
      });
    }

    // Page budget exhausted mid-window. `partial` is correct: the next run must
    // resume here rather than treat the window as read.
    await this.repository.saveCursor({
      source: 'nvd',
      mode: plan.queryMode,
      windowStart: plan.windowStart,
      windowEnd: plan.windowEnd,
      pageOffset: startIndex,
      status: 'partial',
      error: null,
      recordsIngested: advisoriesIngested,
      backfillStartedAt,
      nextRunAt: options.continuationNextRunAt ?? options.nextRunAt,
    });

    logger.info(
      { advisoriesIngested, pagesFetched, startIndex },
      '[threat-watch] Advisory sync paused at page budget',
    );

    return {
      status: 'partial',
      pagesFetched,
      advisoriesIngested,
      windowComplete: false,
      moreWindows: true,
    };
  }
}
