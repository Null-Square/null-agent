import { and, eq, isNull, notInArray, or, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  advisories,
  advisoryAffectedRanges,
  advisorySources,
  advisorySyncState,
  type AdvisorySourceKey,
} from '@/db/schema';

import type { DerivedAffectedRange, NormalizedAdvisory, NvdCve } from './nvdNormalizer';

/** A database handle or an open transaction; both support the same statements. */
type DbExecutor = DatabaseClient | Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export type SyncCursor = {
  mode: 'publication' | 'modification';
  windowStart: Date | null;
  windowEnd: Date | null;
  pageOffset: number;
  backfillStartedAt: Date | null;
  lastStatus: string | null;
};

export type AdvisoryFeedState = {
  source: AdvisorySourceKey;
  mode: 'publication' | 'modification';
  windowStart: Date | null;
  windowEnd: Date | null;
  pageOffset: number;
  backfillStartedAt: Date | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  nextRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  recordsIngested: number;
};

/**
 * Persistence for advisories.
 *
 * The canonical/source split lives here rather than in the sync service because
 * every feed will need it: an advisory is one real-world vulnerability, and
 * NVD, KEV, EPSS, OSV and the WordPress feeds are all *descriptions* of it.
 * Keying on a CVE id alone would break the moment a Wordfence advisory arrives
 * without one, which is common enough to be the normal case in our primary
 * segment.
 */
export class AdvisoryRepository {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Upsert one advisory together with the source payload it came from and the
   * ranges derived from it.
   *
   * Ranges are deleted and re-derived rather than merged: they are a pure
   * projection of the source data, and a stale range that no longer reflects
   * the advisory is a false alert waiting to happen.
   */
  async upsertFromSource(params: {
    source: AdvisorySourceKey;
    sourceAdvisoryId: string;
    normalized: NormalizedAdvisory;
    ranges: DerivedAffectedRange[];
    raw: NvdCve | Record<string, unknown>;
  }): Promise<{ advisoryId: string }> {
    // Advisory, source payload and ranges are one fact. Applied separately, a
    // crash between the range delete and insert leaves an advisory with no
    // ranges — silently unmatchable — or ranges that contradict it.
    return this.db.transaction(async (tx) => this.upsertFromSourceIn(tx, params));
  }

  /**
   * Persist one provider page as one atomic cursor unit.
   *
   * A full NVD page can hold 2,000 advisories. Reusing one transaction removes
   * thousands of per-row commits while preserving the existing canonical,
   * source, and affected-range invariants in one writer.
   */
  async upsertPageFromSource(
    rows: ReadonlyArray<{
      source: AdvisorySourceKey;
      sourceAdvisoryId: string;
      normalized: NormalizedAdvisory;
      ranges: DerivedAffectedRange[];
      raw: NvdCve | Record<string, unknown>;
    }>,
  ): Promise<{ advisoriesUpserted: number }> {
    if (rows.length === 0) return { advisoriesUpserted: 0 };

    return this.db.transaction(async (tx) => {
      for (const row of rows) {
        await this.upsertFromSourceIn(tx, row);
      }
      return { advisoriesUpserted: rows.length };
    });
  }

  private async upsertFromSourceIn(
    // The transaction handle is structurally a DatabaseClient minus `$client`;
    // the existing writers in this codebase widen the same way.
    db: DbExecutor,
    params: {
      source: AdvisorySourceKey;
      sourceAdvisoryId: string;
      normalized: NormalizedAdvisory;
      ranges: DerivedAffectedRange[];
      raw: NvdCve | Record<string, unknown>;
    },
  ): Promise<{ advisoryId: string }> {
    const now = this.now();
    const { normalized } = params;

    const [advisory] = await db
      .insert(advisories)
      .values({
        canonicalId: normalized.canonicalId,
        canonicalSource: params.source,
        cveId: normalized.cveId,
        title: normalized.title,
        summary: normalized.summary,
        publishedAt: normalized.publishedAt,
        lastModifiedAt: normalized.lastModifiedAt,
        state: normalized.state,
        severity: normalized.severity,
        cvssV31Vector: normalized.cvssV31Vector,
        cvssV31Score: normalized.cvssV31Score,
        cweIds: normalized.cweIds,
        applicability: normalized.applicability,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [advisories.canonicalId],
        set: {
          title: normalized.title,
          summary: normalized.summary,
          publishedAt: normalized.publishedAt,
          lastModifiedAt: normalized.lastModifiedAt,
          state: normalized.state,
          severity: normalized.severity,
          cvssV31Vector: normalized.cvssV31Vector,
          cvssV31Score: normalized.cvssV31Score,
          cweIds: normalized.cweIds,
          applicability: normalized.applicability,
          updatedAt: now,
        },
      })
      .returning({ id: advisories.id });

    if (!advisory) {
      throw new Error(`Advisory upsert returned no row for ${normalized.canonicalId}`);
    }

    await db
      .insert(advisorySources)
      .values({
        advisoryId: advisory.id,
        source: params.source,
        sourceAdvisoryId: params.sourceAdvisoryId,
        sourceModifiedAt: normalized.lastModifiedAt,
        // Retained so an improved normalizer can reprocess every advisory
        // without re-downloading hundreds of thousands of records.
        raw: params.raw as Record<string, unknown>,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [advisorySources.source, advisorySources.sourceAdvisoryId],
        set: {
          advisoryId: advisory.id,
          sourceModifiedAt: normalized.lastModifiedAt,
          raw: params.raw as Record<string, unknown>,
          fetchedAt: now,
        },
      });

    // Scoped to this source. Deleting every range for the advisory would let an
    // NVD refresh erase Wordfence- or OSV-derived ranges (and vice versa) as
    // soon as a second feed exists; each feed owns and replaces only its own.
    await db
      .delete(advisoryAffectedRanges)
      .where(
        and(
          eq(advisoryAffectedRanges.advisoryId, advisory.id),
          eq(advisoryAffectedRanges.source, params.source),
        ),
      );

    if (params.ranges.length > 0) {
      await db.insert(advisoryAffectedRanges).values(
        params.ranges.map((range) => ({
          advisoryId: advisory.id,
          source: params.source,
          ecosystem: range.ecosystem,
          componentKey: range.componentKey,
          versionScheme: range.versionScheme,
          introducedVersion: range.introducedVersion,
          introducedInclusive: range.introducedInclusive,
          fixedVersion: range.fixedVersion,
          fixedInclusive: range.fixedInclusive,
          rawConstraint: range.rawConstraint,
          createdAt: now,
        })),
      );
    }

    return { advisoryId: advisory.id };
  }

  async loadCursor(source: AdvisorySourceKey): Promise<SyncCursor | null> {
    const [row] = await this.db
      .select({
        mode: advisorySyncState.cursorMode,
        windowStart: advisorySyncState.cursorWindowStart,
        windowEnd: advisorySyncState.cursorWindowEnd,
        pageOffset: advisorySyncState.cursorPageOffset,
        backfillStartedAt: advisorySyncState.backfillStartedAt,
        lastStatus: advisorySyncState.lastStatus,
      })
      .from(advisorySyncState)
      .where(eq(advisorySyncState.source, source))
      .limit(1);

    return row ?? null;
  }

  async loadFeedState(source: AdvisorySourceKey): Promise<AdvisoryFeedState | null> {
    const [row] = await this.db
      .select({
        source: advisorySyncState.source,
        mode: advisorySyncState.cursorMode,
        windowStart: advisorySyncState.cursorWindowStart,
        windowEnd: advisorySyncState.cursorWindowEnd,
        pageOffset: advisorySyncState.cursorPageOffset,
        backfillStartedAt: advisorySyncState.backfillStartedAt,
        lastRunAt: advisorySyncState.lastRunAt,
        lastSuccessAt: advisorySyncState.lastSuccessAt,
        nextRunAt: advisorySyncState.nextRunAt,
        lastStatus: advisorySyncState.lastStatus,
        lastError: advisorySyncState.lastError,
        consecutiveFailures: advisorySyncState.consecutiveFailures,
        recordsIngested: advisorySyncState.recordsIngested,
      })
      .from(advisorySyncState)
      .where(eq(advisorySyncState.source, source))
      .limit(1);

    return row ?? null;
  }

  /**
   * Checkpoint progress.
   *
   * The page offset advances per successful page and the window only on
   * completion, so a crash mid-backfill resumes at the page rather than
   * restarting a window that may hold tens of thousands of records.
   */
  async saveCursor(params: {
    source: AdvisorySourceKey;
    mode: 'publication' | 'modification';
    windowStart: Date | null;
    windowEnd: Date | null;
    pageOffset: number;
    backfillStartedAt?: Date | null;
    status: 'ok' | 'partial' | 'failed';
    error?: string | null;
    recordsIngested?: number;
    nextRunAt?: Date | null;
  }): Promise<void> {
    const now = this.now();
    const madeProgress = params.status === 'ok' || (params.status === 'partial' && !params.error);
    const failed = params.status === 'failed' || (params.status === 'partial' && Boolean(params.error));

    await this.db
      .insert(advisorySyncState)
      .values({
        source: params.source,
        cursorMode: params.mode,
        cursorWindowStart: params.windowStart,
        cursorWindowEnd: params.windowEnd,
        cursorPageOffset: params.pageOffset,
        backfillStartedAt: params.backfillStartedAt ?? null,
        lastRunAt: now,
        lastSuccessAt: madeProgress ? now : null,
        nextRunAt: params.nextRunAt ?? null,
        lastStatus: params.status,
        lastError: params.error ?? null,
        consecutiveFailures: failed ? 1 : 0,
        recordsIngested: params.recordsIngested ?? 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [advisorySyncState.source],
        set: {
          cursorMode: params.mode,
          cursorWindowStart: params.windowStart,
          cursorWindowEnd: params.windowEnd,
          cursorPageOffset: params.pageOffset,
          // The watermark is immutable during a backfill. A clean baseline
          // starts it as null, and the first NVD backfill run initializes it.
          backfillStartedAt: sql`COALESCE(${advisorySyncState.backfillStartedAt}, ${params.backfillStartedAt ?? null})`,
          lastRunAt: now,
          lastSuccessAt: madeProgress ? now : advisorySyncState.lastSuccessAt,
          nextRunAt: params.nextRunAt ?? null,
          lastStatus: params.status,
          lastError: params.error ?? null,
          consecutiveFailures: failed
            ? sql`${advisorySyncState.consecutiveFailures} + 1`
            : 0,
          recordsIngested: sql`${advisorySyncState.recordsIngested} + ${params.recordsIngested ?? 0}`,
          updatedAt: now,
        },
      });
  }

  /** Record a complete snapshot-feed attempt without inventing cursor fields. */
  async recordFeedAttempt(params: {
    source: 'kev' | 'epss';
    status: 'ok' | 'failed';
    error?: string | null;
    recordsIngested?: number;
    nextRunAt: Date;
  }): Promise<void> {
    const now = this.now();
    const succeeded = params.status === 'ok';

    await this.db
      .insert(advisorySyncState)
      .values({
        source: params.source,
        cursorMode: 'modification',
        cursorWindowStart: null,
        cursorWindowEnd: null,
        cursorPageOffset: 0,
        lastRunAt: now,
        lastSuccessAt: succeeded ? now : null,
        nextRunAt: params.nextRunAt,
        lastStatus: params.status,
        lastError: params.error ?? null,
        consecutiveFailures: succeeded ? 0 : 1,
        recordsIngested: params.recordsIngested ?? 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [advisorySyncState.source],
        set: {
          lastRunAt: now,
          lastSuccessAt: succeeded ? now : advisorySyncState.lastSuccessAt,
          nextRunAt: params.nextRunAt,
          lastStatus: params.status,
          lastError: params.error ?? null,
          consecutiveFailures: succeeded
            ? 0
            : sql`${advisorySyncState.consecutiveFailures} + 1`,
          recordsIngested: sql`${advisorySyncState.recordsIngested} + ${params.recordsIngested ?? 0}`,
          updatedAt: now,
        },
      });
  }

  /**
   * Replace KEV membership wholesale.
   *
   * CISA publishes the catalog as a complete list, and entries do get removed.
   * Only ever setting `kev_listed = true` meant a removal was invisible: the
   * advisory would keep the strongest priority signal we have, forever, on the
   * strength of a fact that is no longer true. So this clears membership for
   * anything absent from the incoming catalog, in the same transaction.
   */
  async replaceKevCatalog(
    entries: ReadonlyArray<{ cveId: string; addedAt: Date | null; knownRansomware: boolean }>,
  ): Promise<{ listed: number; cleared: number; changedAdvisoryIds: string[] }> {
    const now = this.now();

    return this.db.transaction(async (tx) => {
      const normalizedEntries = [
        ...new Map(
          entries.map((entry) => [entry.cveId.toUpperCase(), { ...entry, cveId: entry.cveId.toUpperCase() }]),
        ).values(),
      ];
      const cveIds = normalizedEntries.map((entry) => entry.cveId);

      // Clear first, then re-assert, so a removal is genuinely reflected. An
      // empty catalog is treated as a failed fetch rather than "nothing is
      // exploited any more", which would silently defuse every KEV priority.
      if (cveIds.length === 0) {
        return { listed: 0, cleared: 0, changedAdvisoryIds: [] };
      }

      const cleared = await tx
        .update(advisories)
        .set({ kevListed: false, kevAddedAt: null, updatedAt: now })
        .where(
          and(
            eq(advisories.kevListed, true),
            or(isNull(advisories.cveId), notInArray(advisories.cveId, cveIds)),
          ),
        )
        .returning({ id: advisories.id });

      // Advisories whose KEV status actually *changed*, so the caller can
      // reprioritize their open matches. A CVE added to KEV years after
      // publication never gets an NVD modification, so nothing else would ever
      // revisit it — and KEV is the strongest signal in the priority model.
      const changed = new Set<string>(cleared.map((row) => row.id));

      // Apply the complete catalog as one set. The public KEV catalog already
      // contains thousands of entries; one update per CVE needlessly turns a
      // snapshot into thousands of database round trips.
      const values = sql.join(
        normalizedEntries.map((entry) => sql`(${entry.cveId}, ${entry.addedAt})`),
        sql`, `,
      );
      const listedResult = await tx.execute(sql`
        UPDATE ${advisories} AS advisory
        SET kev_listed = true,
            kev_added_at = incoming.added_at::timestamptz,
            updated_at = ${now}
        FROM (VALUES ${values}) AS incoming(cve_id, added_at)
        WHERE advisory.cve_id = incoming.cve_id
          AND advisory.kev_listed = false
        RETURNING advisory.id
      `);
      const listedRows = (
        listedResult as unknown as { rows?: Array<{ id: string }> }
      ).rows ?? [];
      for (const row of listedRows) changed.add(row.id);

      // Date-only changes do not change priority, so update them without adding
      // the advisory to the reprioritization set.
      await tx.execute(sql`
        UPDATE ${advisories} AS advisory
        SET kev_added_at = incoming.added_at::timestamptz,
            updated_at = ${now}
        FROM (VALUES ${values}) AS incoming(cve_id, added_at)
        WHERE advisory.cve_id = incoming.cve_id
          AND advisory.kev_listed = true
          AND advisory.kev_added_at IS DISTINCT FROM incoming.added_at::timestamptz
      `);

      return {
        listed: listedRows.length,
        cleared: cleared.length,
        changedAdvisoryIds: [...changed],
      };
    });
  }

  /**
   * Apply EPSS exploitation probabilities.
   *
   * EPSS republishes every scored CVE daily — on the order of a quarter of a
   * million rows — so this is written as batched multi-row updates rather than
   * one statement per record. A per-row loop would take hours and hold a
   * connection for the duration.
   */
  async applyEpssScores(
    scores: ReadonlyArray<{ cveId: string; score: number; percentile: number }>,
    options: { batchSize?: number } = {},
  ): Promise<{ applied: number; changedAdvisoryIds: string[] }> {
    if (scores.length === 0) return { applied: 0, changedAdvisoryIds: [] };

    const batchSize = options.batchSize ?? 1_000;
    const changed = new Set<string>();
    let applied = 0;

    for (let offset = 0; offset < scores.length; offset += batchSize) {
      const batch = scores.slice(offset, offset + batchSize);

      // A single UPDATE ... FROM (VALUES ...) per batch. Only advisories we
      // already hold are touched; EPSS scores a great many CVEs we never
      // ingested, and inventing rows for them would bloat the table for nothing.
      const values = sql.join(
        batch.map(
          (entry) =>
            sql`(${entry.cveId}, ${entry.score}::real, ${entry.percentile}::real)`,
        ),
        sql`, `,
      );

      // Two deliberate constraints on this statement.
      //
      // `IS DISTINCT FROM` restricts the write to rows whose score actually
      // moved. EPSS republishes all ~250k scored CVEs daily and most are
      // unchanged, so an unconditional update rewrites the entire corpus every
      // cycle for no information gain.
      //
      // `updated_at` is deliberately *not* bumped. The cycle uses that column to
      // decide which advisories to re-run the matcher against, and EPSS cannot
      // change whether a version falls inside an affected range — it only
      // changes how a match is prioritised. Bumping it here would make every
      // enrichment pass a full-corpus rematch once the backfill has landed, a
      // cost that grows with the corpus and buys nothing. Changed ids are
      // returned instead, so the caller can rescore the affected open matches.
      const result = await this.db.execute(sql`
        UPDATE ${advisories} AS a
        SET epss_score = v.score,
            epss_percentile = v.percentile
        FROM (VALUES ${values}) AS v(cve_id, score, percentile)
        WHERE a.cve_id = v.cve_id
          AND (
            a.epss_score IS DISTINCT FROM v.score
            OR a.epss_percentile IS DISTINCT FROM v.percentile
          )
        RETURNING a.id
      `);

      const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
      for (const row of rows) changed.add(row.id);
      applied += rows.length;
    }

    return { applied, changedAdvisoryIds: [...changed] };
  }
}
