import { and, asc, eq, gt, gte, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { advisories, advisorySources, exposureMatches } from '@/db/schema';
import type {
  AdvisorySyncRunOptions,
  AdvisorySyncService,
} from '@/domains/security-ops/advisories/AdvisorySyncService';
import { logger } from '@/shared/logger';

import type { AdvisoryRepository } from '@/domains/security-ops/advisories/AdvisoryRepository';
import { isSnapshotFeedDue } from '@/domains/security-ops/advisories/threatWatchHealth';
import {
  FeedUnavailable,
  fetchEpssScores,
  fetchKevCatalog,
  type EpssEntry,
  type KevEntry,
} from '@/domains/security-ops/advisories/kevEpssFeeds';

import { evaluateCircuitBreaker, type CircuitBreakerDecision } from './exposureCircuitBreaker';
import type { ExposureMatchService } from './ExposureMatchService';
import type { ExposureVerificationService } from './ExposureVerificationService';
import type { ExposureNotifier, ExposureNotifyResult } from './ExposureNotifier';

export type ThreatWatchCycleResult = {
  sync: { status: string; advisoriesIngested: number; moreWindows: boolean };
  advisoriesMatched: number;
  matchesCreated: number;
  matchesRetracted: number;
  staleMarked: number;
  verificationsRecovered: number;
  enrichment?: {
    kevListed: number;
    kevCleared: number;
    epssApplied: number;
    reprioritized: number;
    kevRefreshed: boolean;
    epssRefreshed: boolean;
  };
  /** Present and tripped when alert volume this cycle is abnormal. */
  circuitBreaker?: CircuitBreakerDecision;
  notifications?: ExposureNotifyResult & { halted: boolean };
  reconciled?: { componentsConsidered: number; advisoriesMatched: number };
};

export type ThreatWatchCycleDeps = {
  /** Optional so the cycle still runs when enrichment is not configured. */
  advisoryRepository?: AdvisoryRepository;
  fetchKev?: typeof fetchKevCatalog;
  fetchEpss?: typeof fetchEpssScores;
  verificationService?: Pick<ExposureVerificationService, 'recoverStalledVerifications'>;
  /** Optional so a node without notification delivery still syncs and matches. */
  notifier?: Pick<ExposureNotifier, 'notifyNewExposures'>;
};

export type ThreatWatchCycleOptions = {
  /** Days before an unconfirmed component's matches are marked stale (D5). */
  stalenessThresholdDays?: number;
  /** How far back reconciliation looks for newly confirmed components. */
  reconcileLookbackHours?: number;
  /** Minimum age before an unbound or terminal verification is recovered. */
  verificationRecoveryMinutes?: number;
};

/**
 * One operational tick of Threat Watch.
 *
 * Sequenced deliberately:
 *
 *   1. **Sync** advisories, so matching sees the freshest data.
 *   2. **Match** only advisories this sync actually touched — the cheap,
 *      advisory-first direction.
 *   3. **Reconcile** recently confirmed components against advisories that
 *      already existed, which is the only way a newly onboarded customer is
 *      matched against history rather than only against the future.
 *   4. **Age out** matches whose evidence is too old to stand behind.
 *
 * Steps 2 and 3 cover opposite blind spots; running only one leaves either new
 * advisories or new customers permanently unmatched.
 */
export class ThreatWatchCycleService {
  private readonly stalenessThresholdDays: number;

  private readonly reconcileLookbackHours: number;

  private readonly verificationRecoveryMinutes: number;

  constructor(
    private readonly db: DatabaseClient,
    private readonly syncService: AdvisorySyncService,
    private readonly matchService: ExposureMatchService,
    options: ThreatWatchCycleOptions = {},
    private readonly now: () => Date = () => new Date(),
    private readonly deps: ThreatWatchCycleDeps = {},
  ) {
    this.stalenessThresholdDays = options.stalenessThresholdDays ?? 14;
    this.reconcileLookbackHours = options.reconcileLookbackHours ?? 24;
    this.verificationRecoveryMinutes = options.verificationRecoveryMinutes ?? 30;
  }

  async runCycle(
    params: {
      reconcile?: boolean;
      enrich?: boolean;
      sync?: AdvisorySyncRunOptions;
    } = {},
  ): Promise<ThreatWatchCycleResult> {
    const startedAt = this.now();
    const sync = await this.syncService.syncOnce(params.sync);

    const result: ThreatWatchCycleResult = {
      sync: {
        status: sync.status,
        advisoriesIngested: sync.advisoriesIngested,
        moreWindows: sync.moreWindows,
      },
      advisoriesMatched: 0,
      matchesCreated: 0,
      matchesRetracted: 0,
      staleMarked: 0,
      verificationsRecovered: 0,
    };

    // A skipped tick means another replica holds the lock and is doing this
    // work; duplicating the match pass would only race it.
    if (sync.status === 'skipped') return result;

    // Enrichment runs *before* matching, not after.
    //
    // Priority is computed at match time from the advisory's KEV flag and EPSS
    // score. Enriching afterwards meant a newly ingested advisory was scored
    // without them, so a KEV-listed exposure could be filed as low priority and
    // never reconsidered — the strongest signal in the model arriving one cycle
    // too late to use.
    if (params.enrich) {
      const enrichment = await this.refreshExploitationSignals();
      const { changedAdvisoryIds, ...publicEnrichment } = enrichment;
      result.enrichment = { ...publicEnrichment, reprioritized: 0 };

      // A CVE added to KEV years after publication gets no NVD modification, so
      // the advisory-first pass below would never revisit it. Rescore its open
      // matches explicitly, or the strongest signal in the model arrives and is
      // then ignored.
      if (changedAdvisoryIds.length > 0) {
        result.enrichment.reprioritized = await this.matchService.reprioritizeForAdvisories(
          changedAdvisoryIds,
        );
      }
    }

    const touched = await this.loadAdvisoriesTouchedSince(startedAt);

    for (const advisoryId of touched) {
      const matchResult = await this.matchService.matchAdvisory(advisoryId);
      result.advisoriesMatched += 1;
      result.matchesCreated += matchResult.matchesCreated;
    }

    // Retractions travel the opposite way to matches. `loadAdvisoriesTouchedSince`
    // filters to active advisories, so a withdrawal would otherwise never be
    // seen by the cycle and the customer would keep a live claim we no longer
    // stand behind.
    result.matchesRetracted = await this.resolveRetractedAdvisories(startedAt);

    if (params.reconcile) {
      const since = new Date(
        this.now().getTime() - this.reconcileLookbackHours * 60 * 60 * 1000,
      );
      result.reconciled = await this.matchService.reconcileComponents({ since });
    }

    if (this.deps.verificationService) {
      result.verificationsRecovered =
        await this.deps.verificationService.recoverStalledVerifications({
          olderThanMinutes: this.verificationRecoveryMinutes,
        });
    }

    result.staleMarked = await this.matchService.markStaleMatches(this.stalenessThresholdDays);

    result.circuitBreaker = await this.evaluateAlertVolume(startedAt);

    // Notify last, and only behind the breaker.
    //
    // The breaker finally has a consumer. An abnormal alert volume almost always
    // means a matching or ingestion fault rather than a genuinely dangerous day,
    // and the damage from mailing a customer fifty false exposures is far worse
    // than the damage from telling them late. So a tripped breaker suppresses
    // delivery while leaving the matches in place: nothing is lost, the operator
    // is alerted by the error log, and the next clean cycle sends them.
    if (this.deps.notifier) {
      if (result.circuitBreaker.tripped) {
        result.notifications = {
          considered: 0,
          notified: 0,
          suppressedByCap: 0,
          skippedBelowThreshold: 0,
          skippedIneligibleEvidence: 0,
          halted: true,
        };
        logger.error(
          { circuitBreaker: result.circuitBreaker },
          '[threat-watch] Alert volume circuit breaker tripped; notifications suppressed this cycle',
        );
      } else {
        result.notifications = {
          ...(await this.deps.notifier.notifyNewExposures()),
          halted: false,
        };
      }
    }

    logger.info(result, '[threat-watch] Cycle complete');

    return result;
  }

  /**
   * Check whether this cycle would flood anyone before alerting acts on it.
   *
   * The breaker is evaluated here, at the end of the cycle, because this is the
   * only place that knows the whole cycle's output. A tripped breaker is
   * recorded on the result and logged at error level so alerting — once it
   * exists — has a single authoritative signal to consult rather than
   * recomputing volume for itself.
   */
  private async evaluateAlertVolume(since: Date): Promise<CircuitBreakerDecision> {
    const rows = await this.db
      .select({
        organizationId: exposureMatches.organizationId,
        count: sql<number>`count(*)::int`,
      })
      .from(exposureMatches)
      .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
      .where(
        and(
          gte(exposureMatches.firstSeenAt, since),
          eq(exposureMatches.matchConfidence, 'exact_version'),
          eq(exposureMatches.state, 'candidate'),
        ),
      )
      .groupBy(exposureMatches.organizationId);

    const decision = evaluateCircuitBreaker({
      interruptGradeByOrganization: new Map(
        rows.map((row) => [row.organizationId, Number(row.count)]),
      ),
    });

    if (decision.tripped) {
      logger.error(
        { scope: decision.scope, observed: decision.observed, threshold: decision.threshold },
        `[threat-watch] Alert volume circuit breaker tripped: ${decision.reason}`,
      );
    }

    return decision;
  }

  /**
   * Refresh KEV membership and EPSS scores.
   *
   * Both are complete snapshots, and both are applied best-effort: a feed being
   * unavailable degrades ranking quality but must never abort a cycle that has
   * already ingested and matched real advisories. The feed parsers reject empty
   * or malformed snapshots themselves, so nothing here can quietly clear a flag
   * on the strength of a bad fetch.
   */
  private async refreshExploitationSignals(): Promise<{
    kevListed: number;
    kevCleared: number;
    epssApplied: number;
    changedAdvisoryIds: string[];
    kevRefreshed: boolean;
    epssRefreshed: boolean;
  }> {
    const summary = {
      kevListed: 0,
      kevCleared: 0,
      epssApplied: 0,
      changedAdvisoryIds: [] as string[],
      kevRefreshed: false,
      epssRefreshed: false,
    };
    const repository = this.deps.advisoryRepository;
    if (!repository) return summary;

    const now = this.now();
    const [kevState, epssState] = await Promise.all([
      repository.loadFeedState('kev'),
      repository.loadFeedState('epss'),
    ]);
    const successNextRunAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const failureNextRunAt = new Date(now.getTime() + 60 * 60 * 1000);

    if (isSnapshotFeedDue(kevState, now)) {
      try {
        const kev: KevEntry[] = await (this.deps.fetchKev ?? fetchKevCatalog)();
        const applied = await repository.replaceKevCatalog(kev);
        summary.kevListed = applied.listed;
        summary.kevCleared = applied.cleared;
        summary.changedAdvisoryIds = applied.changedAdvisoryIds;
        summary.kevRefreshed = true;
        await repository.recordFeedAttempt({
          source: 'kev',
          status: 'ok',
          recordsIngested: kev.length,
          nextRunAt: successNextRunAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        await repository.recordFeedAttempt({
          source: 'kev',
          status: 'failed',
          error: message,
          nextRunAt: failureNextRunAt,
        }).catch((stateError) => logger.error(
          { err: stateError, feed: 'kev' },
          '[threat-watch] Could not persist KEV feed failure state',
        ));
        logger.warn(
          { err: error, feed: 'kev', recoverable: error instanceof FeedUnavailable },
          '[threat-watch] KEV refresh failed; existing flags left untouched',
        );
      }
    }

    if (isSnapshotFeedDue(epssState, now)) {
      try {
        const epss: EpssEntry[] = await (this.deps.fetchEpss ?? fetchEpssScores)();
        const applied = await repository.applyEpssScores(epss);
        summary.epssApplied = applied.applied;
        summary.epssRefreshed = true;
        // Merged with KEV's, so a single reprioritisation pass covers both feeds
        // and an advisory changed by each is rescored once rather than twice.
        summary.changedAdvisoryIds = [
          ...new Set([...summary.changedAdvisoryIds, ...applied.changedAdvisoryIds]),
        ];
        await repository.recordFeedAttempt({
          source: 'epss',
          status: 'ok',
          recordsIngested: epss.length,
          nextRunAt: successNextRunAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        await repository.recordFeedAttempt({
          source: 'epss',
          status: 'failed',
          error: message,
          nextRunAt: failureNextRunAt,
        }).catch((stateError) => logger.error(
          { err: stateError, feed: 'epss' },
          '[threat-watch] Could not persist EPSS feed failure state',
        ));
        logger.warn(
          { err: error, feed: 'epss', recoverable: error instanceof FeedUnavailable },
          '[threat-watch] EPSS refresh failed; existing scores left untouched',
        );
      }
    }

    return summary;
  }

  /**
   * Advisories whose source payload was fetched during this cycle.
   *
   * Keyed on `advisory_sources.fetched_at` rather than `advisories.updated_at`
   * because an advisory re-fetched with identical content still needs matching:
   * the customer's inventory may have changed since we last looked, even when
   * the advisory did not.
   */
  private async loadAdvisoriesTouchedSince(since: Date): Promise<string[]> {
    // Paged to exhaustion rather than capped.
    //
    // A flat limit silently dropped everything past it, and because the next
    // cycle keys on a newer timestamp those advisories would never be selected
    // again — a customer could be exposed to something we ingested and then
    // permanently forgot to match. Ordering by id keeps the keyset stable.
    const pageSize = 2_000;
    const collected: string[] = [];
    let cursor: string | null = null;

    for (;;) {
      const rows: Array<{ advisoryId: string }> = await this.db
        .selectDistinct({ advisoryId: advisorySources.advisoryId })
        .from(advisorySources)
        .innerJoin(advisories, eq(advisories.id, advisorySources.advisoryId))
        .where(
          and(
            gte(advisorySources.fetchedAt, since),
            // Only `simple` advisories can produce ranges; matching the others
            // would be a no-op round trip per advisory.
            eq(advisories.applicability, 'simple'),
            eq(advisories.state, 'active'),
            cursor ? gt(advisorySources.advisoryId, cursor) : undefined,
          ),
        )
        .orderBy(asc(advisorySources.advisoryId))
        .limit(pageSize);

      if (rows.length === 0) break;

      for (const row of rows) collected.push(row.advisoryId);
      cursor = rows[rows.length - 1]!.advisoryId;

      if (rows.length < pageSize) break;
    }

    return collected;
  }

  /** Advisories retracted upstream, so their open matches can be resolved. */
  async resolveRetractedAdvisories(since: Date): Promise<number> {
    const rows = await this.db
      .select({ id: advisories.id, state: advisories.state })
      .from(advisories)
      .where(
        and(
          sql`${advisories.state} <> 'active'`,
          gte(advisories.updatedAt, since),
        ),
      )
      .limit(1_000);

    let resolved = 0;
    for (const row of rows) {
      resolved += await this.matchService.resolveMatchesForAdvisory(
        row.id,
        `advisory_${row.state}`,
      );
    }

    return resolved;
  }
}
