import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  advisories,
  advisoryAffectedRanges,
  componentOverrides,
  exposureMatchEvents,
  exposureMatches,
  inventoryComponents,
  type ComponentEcosystem,
  type ComponentEvidenceTier,
  type ExposureEvidenceSource,
  type ExposureMatchConfidence,
  type ExposureMatchState,
} from '@/db/schema';
import { isVersionInRange } from '@/domains/security-ops/components/compareVersions';
import { logger } from '@/shared/logger';

import { calculateExposurePriority } from './exposurePriority';

export type MatchAdvisoryResult = {
  advisoryId: string;
  candidatesConsidered: number;
  matchesCreated: number;
  matchesUpdated: number;
  suppressedByOverride: number;
  skippedIncomparable: number;
  skippedMissingVersionEvidence: number;
  matchesResolved: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Joins what customers run against what advisories affect.
 *
 * The whole feature narrows to this file, and its governing rule is the one
 * from PRD R1: a question we cannot answer confidently produces *no match*.
 * `isVersionInRange` returns null for an unknown scheme or an unparseable
 * bound, and null is treated as "not affected" — never as "affected". The cost
 * of a wrong yes is a customer told they are vulnerable when they are not, and
 * on a low-price tier that is the whole product.
 */
export class ExposureMatchService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Match one advisory against every customer's inventory.
   *
   * Entered from the advisory side because that is the shape of the work: a
   * sync touches a few hundred advisories, and each needs to find the handful
   * of customers it affects — an indexed lookup on (ecosystem, component_key),
   * not a scan of every customer.
   */
  async matchAdvisory(
    advisoryRowId: string,
    options?: { componentId?: string },
  ): Promise<MatchAdvisoryResult> {
    const result: MatchAdvisoryResult = {
      advisoryId: advisoryRowId,
      candidatesConsidered: 0,
      matchesCreated: 0,
      matchesUpdated: 0,
      suppressedByOverride: 0,
      skippedIncomparable: 0,
      skippedMissingVersionEvidence: 0,
      matchesResolved: 0,
    };

    const [advisory] = await this.db
      .select({
        id: advisories.id,
        canonicalId: advisories.canonicalId,
        state: advisories.state,
        applicability: advisories.applicability,
        severity: advisories.severity,
        cvssScore: advisories.cvssV31Score,
        epssPercentile: advisories.epssPercentile,
        kevListed: advisories.kevListed,
      })
      .from(advisories)
      .where(eq(advisories.id, advisoryRowId))
      .limit(1);

    if (!advisory) return result;

    // A withdrawn advisory is not a match, it is a retraction: resolve anything
    // we already told customers about rather than leaving it live.
    if (advisory.state !== 'active') {
      await this.resolveMatchesForAdvisory(advisoryRowId, `advisory_${advisory.state}`);
      return result;
    }

    // Ranges only exist for `simple` advisories, but assert it rather than rely
    // on the writer: matching a `complex` advisory is exactly the overmatch the
    // classifier exists to prevent.
    if (advisory.applicability !== 'simple') return result;

    const ranges = await this.db
      .select()
      .from(advisoryAffectedRanges)
      .where(eq(advisoryAffectedRanges.advisoryId, advisoryRowId));

    if (ranges.length === 0) return result;

    const now = this.now();

    // Load overrides once for the advisory batch. Looking one up inside the
    // component/range loop repeated the same query for multi-range advisories
    // and turned matching into an avoidable N+1 path.
    const relevantEcosystems = [...new Set(ranges.map((range) => range.ecosystem))];
    const relevantComponentKeys = [...new Set(ranges.map((range) => range.componentKey))];
    const overrideRows = await this.db
      .select({
        organizationId: componentOverrides.organizationId,
        assetId: componentOverrides.assetId,
        ecosystem: componentOverrides.ecosystem,
        componentKey: componentOverrides.componentKey,
        action: componentOverrides.action,
        correctedVersion: componentOverrides.correctedVersion,
        expiresAt: componentOverrides.expiresAt,
        updatedAt: componentOverrides.updatedAt,
      })
      .from(componentOverrides)
      .where(
        and(
          inArray(componentOverrides.ecosystem, relevantEcosystems),
          inArray(componentOverrides.componentKey, relevantComponentKeys),
        ),
      );
    const overrideByComponent = new Map(
      overrideRows.map((override) => [
        [
          override.organizationId,
          override.assetId,
          override.ecosystem,
          override.componentKey,
        ].join('|'),
        override,
      ]),
    );

    // Candidates are gathered per range, then a component's verdict is decided
    // across *all* of that advisory's ranges before anything is written.
    //
    // Deciding range-by-range made the outcome depend on range order: an
    // advisory with two ranges where one matches and one does not could resolve
    // the match on the non-matching range and then decline to resurrect it,
    // leaving a genuinely affected component marked resolved.
    type Verdict = {
      component: typeof inventoryComponents.$inferSelect;
      confidence: ExposureMatchConfidence | null;
      incomparable: boolean;
      suppressed: boolean;
      versionEvidenceAbsent: boolean;
      evidenceTier: ComponentEvidenceTier | null;
      evidenceSource: ExposureEvidenceSource | null;
      evidenceObservedAt: Date | null;
      versionEvaluated: string | null;
    };
    const verdicts = new Map<string, Verdict>();

    for (const range of ranges) {
      const candidates = await this.db
        .select({
          component: inventoryComponents,
        })
        .from(inventoryComponents)
        .where(
          and(
            eq(inventoryComponents.ecosystem, range.ecosystem),
            eq(inventoryComponents.componentKey, range.componentKey),
            options?.componentId
              ? eq(inventoryComponents.id, options.componentId)
              : undefined,
          ),
        );

      result.candidatesConsidered += candidates.length;

      for (const candidate of candidates) {
        const component = candidate.component;

        const existing = verdicts.get(component.id);
        // Already affected by another range of this advisory; nothing a further
        // range says can make it less affected.
        if (existing?.confidence) continue;

        const override = overrideByComponent.get([
          component.organizationId,
          component.assetId,
          component.ecosystem,
          component.componentKey,
        ].join('|'));
        const activeOverride = override &&
          (!override.expiresAt || override.expiresAt.getTime() > now.getTime())
            ? override
            : undefined;
        if (activeOverride?.action === 'not_present') {
          verdicts.set(component.id, {
            component,
            confidence: null,
            incomparable: false,
            suppressed: true,
            versionEvidenceAbsent: false,
            evidenceTier: null,
            evidenceSource: null,
            evidenceObservedAt: null,
            versionEvaluated: null,
          });
          continue;
        }

        // The customer's correction outranks our observation: they know what
        // they run better than a banner does.
        const correctedVersion = activeOverride?.action === 'version_correction'
          ? activeOverride.correctedVersion
          : null;
        const effectiveVersion = correctedVersion ?? component.resolvedVersion;
        const evidenceTier: ComponentEvidenceTier = correctedVersion
          ? 'attested_exact'
          : component.resolvedEvidenceTier;
        const evidenceSource: ExposureEvidenceSource | null = correctedVersion
          ? 'customer_override'
          : component.resolvedObservationSource;
        const evidenceObservedAt = correctedVersion
          ? activeOverride!.updatedAt
          : component.resolvedVersionObservedAt;

        let confidence: ExposureMatchConfidence;

        if (!effectiveVersion) {
          // Keep the recognised component in inventory, but never turn a
          // missing version into an exposure claim. Product identity alone
          // cannot answer whether an affected range applies.
          verdicts.set(component.id, {
            component,
            confidence: null,
            incomparable: false,
            suppressed: false,
            versionEvidenceAbsent: true,
            evidenceTier: 'absent',
            evidenceSource,
            evidenceObservedAt,
            versionEvaluated: null,
          });
          continue;
        }

        if (!evidenceObservedAt) {
          // A version without the timestamp of the observation that supplied
          // it is legacy/partial evidence. Falling back to `lastConfirmedAt`
          // would let a newer versionless heartbeat refresh an arbitrarily old
          // version and create an interrupt-grade false alert.
          verdicts.set(component.id, {
            component,
            confidence: null,
            incomparable: false,
            suppressed: false,
            versionEvidenceAbsent: true,
            evidenceTier,
            evidenceSource,
            evidenceObservedAt: null,
            versionEvaluated: effectiveVersion,
          });
          continue;
        } else {
          const inRange = isVersionInRange({
            // The range's scheme is authoritative, not the component's: the
            // advisory declares how its own bounds are ordered. Comparing CPE
            // bounds under semver rules (or the reverse) silently produces the
            // wrong answer instead of a refusal.
            scheme: range.versionScheme,
            version: effectiveVersion,
            range: {
              introducedVersion: range.introducedVersion,
              introducedInclusive: range.introducedInclusive,
              fixedVersion: range.fixedVersion,
              fixedInclusive: range.fixedInclusive,
            },
          });

          if (inRange === null) {
            // Incomparable. Silence beats a guess — but another range of this
            // advisory may still decide it.
            verdicts.set(component.id, {
              component,
              confidence: existing?.confidence ?? null,
              incomparable: true,
              suppressed: false,
              versionEvidenceAbsent: false,
              evidenceTier,
              evidenceSource,
              evidenceObservedAt,
              versionEvaluated: effectiveVersion,
            });
            continue;
          }

          if (inRange === false) {
            // Not affected by *this* range. Whether the match should close is
            // decided once every range has been considered.
            verdicts.set(component.id, {
              component,
              confidence: existing?.confidence ?? null,
              incomparable: existing?.incomparable ?? false,
              suppressed: false,
              versionEvidenceAbsent: false,
              evidenceTier,
              evidenceSource,
              evidenceObservedAt,
              versionEvaluated: effectiveVersion,
            });
            continue;
          }

          confidence = 'exact_version';
        }

        verdicts.set(component.id, {
          component,
          confidence,
          incomparable: false,
          suppressed: false,
          versionEvidenceAbsent: false,
          evidenceTier,
          evidenceSource,
          evidenceObservedAt,
          versionEvaluated: effectiveVersion,
        });
      }
    }

    // Every range has now been considered, so each component's verdict is final:
    // affected if *any* range matched, resolved only if none did.
    for (const verdict of verdicts.values()) {
      const { component } = verdict;

      if (verdict.suppressed) {
        result.suppressedByOverride += 1;
        await this.resolveMatchIfOpen(component, advisoryRowId, 'component_overridden', now);
        continue;
      }

      if (!verdict.confidence) {
        if (verdict.versionEvidenceAbsent) {
          result.skippedMissingVersionEvidence += 1;
          const closed = await this.resolveMatchIfOpen(
            component,
            advisoryRowId,
            verdict.versionEvaluated
              ? 'version_evidence_timestamp_absent'
              : 'version_evidence_absent',
            now,
          );
          if (closed) result.matchesResolved += 1;
          continue;
        }
        if (verdict.incomparable) {
          // We could not decide. Leaving any existing match alone is the
          // conservative choice: we neither assert exposure nor retract one.
          result.skippedIncomparable += 1;
          continue;
        }

        // No range covered this component. The customer patched, or the
        // advisory narrowed — either way an open match is no longer true.
        const closed = await this.resolveMatchIfOpen(
          component,
          advisoryRowId,
          'version_no_longer_affected',
          now,
        );
        if (closed) result.matchesResolved += 1;
        continue;
      }

      const evidenceAgeDays = Math.max(
        0,
        (now.getTime() - verdict.evidenceObservedAt!.getTime()) / DAY_MS,
      );

      const priorityScore = calculateExposurePriority({
        kevListed: advisory.kevListed,
        epssPercentile: advisory.epssPercentile,
        cvssScore: advisory.cvssScore,
        matchConfidence: verdict.confidence,
        backportRisk: component.backportRisk,
        versionConflict: component.versionConflict,
        evidenceAgeDays,
      });

      const created = await this.upsertMatch({
        organizationId: component.organizationId,
        assetId: component.assetId,
        componentId: component.id,
        advisoryRowId,
        canonicalId: advisory.canonicalId,
        componentKey: component.componentKey,
        confidence: verdict.confidence,
        versionEvaluated: verdict.versionEvaluated!,
        priorityScore,
        inventoryObservedAt: verdict.evidenceObservedAt!,
        evidenceTier: verdict.evidenceTier,
        evidenceSource: verdict.evidenceSource,
        now,
      });

      if (created) result.matchesCreated += 1;
      else result.matchesUpdated += 1;
    }

    return result;
  }

  /**
   * Close a single open match that is no longer true.
   *
   * Only open states are touched: a `confirmed` match records something a run
   * actually observed, and a later inventory change does not retract evidence.
   * Returns whether anything was closed so the caller can report it.
   */
  private async resolveMatchIfOpen(
    component: { organizationId: string; id: string },
    advisoryRowId: string,
    reason: string,
    now: Date,
  ): Promise<boolean> {
    const resolved = await this.db
      .update(exposureMatches)
      .set({ state: 'resolved', stateReason: reason, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(exposureMatches.organizationId, component.organizationId),
          eq(exposureMatches.componentId, component.id),
          eq(exposureMatches.advisoryId, advisoryRowId),
          inArray(exposureMatches.state, ['candidate', 'notified', 'inconclusive', 'stale'] as ExposureMatchState[]),
        ),
      )
      .returning({ id: exposureMatches.id, organizationId: exposureMatches.organizationId });

    if (resolved.length === 0) return false;

    await this.db.insert(exposureMatchEvents).values(
      resolved.map((match) => ({
        matchId: match.id,
        organizationId: match.organizationId,
        type: 'resolved',
        toState: 'resolved' as ExposureMatchState,
        note: reason,
        createdAt: now,
      })),
    );

    return true;
  }

  private async upsertMatch(params: {
    organizationId: string;
    assetId: string;
    componentId: string;
    advisoryRowId: string;
    canonicalId: string;
    componentKey: string;
    confidence: ExposureMatchConfidence;
    versionEvaluated: string;
    priorityScore: number;
    inventoryObservedAt: Date;
    evidenceTier: ComponentEvidenceTier | null;
    evidenceSource: ExposureEvidenceSource | null;
    now: Date;
  }): Promise<boolean> {
    const dedupeKey = [
      params.organizationId,
      params.assetId,
      params.componentKey,
      params.canonicalId,
    ].join('|');

    // Resolved hypotheses may become true again after rollback, reinstall, or
    // removal of a correction. Re-open only `resolved`; customer dismissals and
    // verification outcomes stay durable.
    const [reopened] = await this.db
      .update(exposureMatches)
      .set({
        state: 'candidate',
        stateReason: null,
        resolvedAt: null,
        updatedAt: params.now,
      })
      .where(
        and(
          eq(exposureMatches.organizationId, params.organizationId),
          eq(exposureMatches.dedupeKey, dedupeKey),
          eq(exposureMatches.state, 'resolved'),
        ),
      )
      .returning({ id: exposureMatches.id });

    if (reopened) {
      await this.db.insert(exposureMatchEvents).values({
        matchId: reopened.id,
        organizationId: params.organizationId,
        type: 'reopened',
        fromState: 'resolved',
        toState: 'candidate',
        note: 'The component matches this advisory again',
        createdAt: params.now,
      });
    }

    const [row] = await this.db
      .insert(exposureMatches)
      .values({
        organizationId: params.organizationId,
        assetId: params.assetId,
        componentId: params.componentId,
        advisoryId: params.advisoryRowId,
        matchConfidence: params.confidence,
        versionEvaluated: params.versionEvaluated,
        priorityScore: params.priorityScore,
        state: 'candidate',
        inventoryObservedAt: params.inventoryObservedAt,
        evidenceTier: params.evidenceTier,
        evidenceSource: params.evidenceSource,
        dedupeKey,
        firstSeenAt: params.now,
        lastSeenAt: params.now,
        createdAt: params.now,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: [exposureMatches.organizationId, exposureMatches.dedupeKey],
        set: {
          // Confidence and priority are refreshed because the inventory may
          // have improved since — a version we could not read last week may be
          // readable now. Resolved hypotheses were conditionally reopened
          // above; dismissed and verified outcomes remain untouched.
          matchConfidence: params.confidence,
          versionEvaluated: params.versionEvaluated,
          priorityScore: params.priorityScore,
          inventoryObservedAt: params.inventoryObservedAt,
          evidenceTier: params.evidenceTier,
          evidenceSource: params.evidenceSource,
          lastSeenAt: params.now,
          updatedAt: params.now,
        },
      })
      .returning({ id: exposureMatches.id, createdAt: exposureMatches.createdAt });

    if (!row) throw new Error('Exposure match upsert returned no row');

    const created = row.createdAt.getTime() === params.now.getTime();

    if (created) {
      await this.db.insert(exposureMatchEvents).values({
        matchId: row.id,
        organizationId: params.organizationId,
        type: 'created',
        toState: 'candidate',
        note: `${params.canonicalId} matched ${params.componentKey} (${params.confidence})`,
        createdAt: params.now,
      });
    }

    return created;
  }

  /**
   * Close out matches for an advisory that no longer stands.
   *
   * Only open states are touched: a match already confirmed by a verification
   * run records something we observed to be true, and a retraction upstream
   * does not undo our own evidence.
   */
  async resolveMatchesForAdvisory(advisoryRowId: string, reason: string): Promise<number> {
    const now = this.now();
    const openStates: ExposureMatchState[] = ['candidate', 'notified', 'stale'];

    const resolved = await this.db
      .update(exposureMatches)
      .set({ state: 'resolved', stateReason: reason, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(exposureMatches.advisoryId, advisoryRowId),
          inArray(exposureMatches.state, openStates),
        ),
      )
      .returning({ id: exposureMatches.id, organizationId: exposureMatches.organizationId });

    if (resolved.length > 0) {
      await this.db.insert(exposureMatchEvents).values(
        resolved.map((match) => ({
          matchId: match.id,
          organizationId: match.organizationId,
          type: 'resolved',
          toState: 'resolved' as ExposureMatchState,
          note: reason,
          createdAt: now,
        })),
      );

      logger.info(
        { advisoryRowId, reason, resolved: resolved.length },
        '[threat-watch] Resolved matches for retracted advisory',
      );
    }

    return resolved.length;
  }

  /**
   * Recompute priority for open matches of advisories whose signals changed.
   *
   * A CVE added to KEV long after publication gets no NVD modification, so the
   * advisory-first pass never revisits it and its existing matches keep whatever
   * priority they were first given. That is the single strongest signal in the
   * model arriving and then being ignored — and it is worst for the backfill,
   * where every historical match was scored before enrichment ran.
   *
   * This only rescores. It never creates or resolves matches, so it cannot
   * change what a customer is told, only the order they are told it in.
   */
  async reprioritizeForAdvisories(advisoryRowIds: readonly string[]): Promise<number> {
    if (advisoryRowIds.length === 0) return 0;

    const now = this.now();
    let updated = 0;

    for (const advisoryRowId of advisoryRowIds) {
      const [advisory] = await this.db
        .select({
          severity: advisories.severity,
          cvssScore: advisories.cvssV31Score,
          epssPercentile: advisories.epssPercentile,
          kevListed: advisories.kevListed,
        })
        .from(advisories)
        .where(eq(advisories.id, advisoryRowId))
        .limit(1);

      if (!advisory) continue;

      const openMatches = await this.db
        .select({
          id: exposureMatches.id,
          matchConfidence: exposureMatches.matchConfidence,
          inventoryObservedAt: exposureMatches.inventoryObservedAt,
          component: inventoryComponents,
        })
        .from(exposureMatches)
        .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
        .where(
          and(
            eq(exposureMatches.advisoryId, advisoryRowId),
            inArray(exposureMatches.state, [
              'candidate',
              'notified',
              'stale',
            ] as ExposureMatchState[]),
          ),
        );

      for (const match of openMatches) {
        const priorityScore = calculateExposurePriority({
          kevListed: advisory.kevListed,
          epssPercentile: advisory.epssPercentile,
          cvssScore: advisory.cvssScore,
          matchConfidence: match.matchConfidence,
          backportRisk: match.component.backportRisk,
          versionConflict: match.component.versionConflict,
          evidenceAgeDays: Math.max(
            0,
            (now.getTime() - match.inventoryObservedAt.getTime()) / DAY_MS,
          ),
        });

        await this.db
          .update(exposureMatches)
          .set({ priorityScore, updatedAt: now })
          .where(eq(exposureMatches.id, match.id));
        updated += 1;
      }
    }

    if (updated > 0) {
      logger.info({ advisories: advisoryRowIds.length, updated }, '[threat-watch] Reprioritized matches');
    }

    return updated;
  }

  /**
   * Match components discovered *after* the advisories that affect them.
   *
   * The sync-driven path only visits advisories that changed, so a customer
   * scanned today would never be matched against an advisory published last
   * year. This walks the other direction — component first — for components
   * confirmed since the given time.
   *
   * Without this the product has a silent, permanent blind spot for every new
   * customer, which is the worst possible shape for the failure: invisible, and
   * worst for exactly the people who just signed up.
   */
  async reconcileComponents(params: {
    since: Date;
    limit?: number;
  }): Promise<{ componentsConsidered: number; advisoriesMatched: number }> {
    // Paged to exhaustion, ordered by id for a stable keyset.
    //
    // A flat limit here silently excluded components from ever being matched —
    // worst for the largest customers, and invisible when it happened.
    const pageSize = params.limit ?? 2_000;
    const components: Array<{ id: string; ecosystem: ComponentEcosystem; componentKey: string }> = [];
    let cursor: string | null = null;

    for (;;) {
      const page: Array<{ id: string; ecosystem: ComponentEcosystem; componentKey: string }> = await this.db
        .select({
          id: inventoryComponents.id,
          ecosystem: inventoryComponents.ecosystem,
          componentKey: inventoryComponents.componentKey,
        })
        .from(inventoryComponents)
        .where(
          and(
            sql`${inventoryComponents.resolvedVersionObservedAt} >= ${params.since}`,
            cursor ? sql`${inventoryComponents.id} > ${cursor}` : undefined,
          ),
        )
        .orderBy(inventoryComponents.id)
        .limit(pageSize);

      if (page.length === 0) break;
      components.push(...page);
      cursor = page[page.length - 1]!.id;
      if (page.length < pageSize) break;
    }

    if (components.length === 0) {
      return { componentsConsidered: 0, advisoriesMatched: 0 };
    }

    // Collapse to the distinct component identities present, so a thousand
    // customers running nginx cost one advisory lookup rather than a thousand.
    const identities = new Map(
      components.map((component) => [
        `${component.ecosystem}|${component.componentKey}`,
        component,
      ]),
    );

    const advisoryIds = new Set<string>();

    for (const identity of identities.values()) {
      const rows = await this.db
        .selectDistinct({ advisoryId: advisoryAffectedRanges.advisoryId })
        .from(advisoryAffectedRanges)
        .where(
          and(
            eq(advisoryAffectedRanges.ecosystem, identity.ecosystem),
            eq(advisoryAffectedRanges.componentKey, identity.componentKey),
          ),
        );

      for (const row of rows) advisoryIds.add(row.advisoryId);
    }

    for (const advisoryId of advisoryIds) {
      await this.matchAdvisory(advisoryId);
    }

    logger.info(
      {
        componentsConsidered: components.length,
        distinctIdentities: identities.size,
        advisoriesMatched: advisoryIds.size,
      },
      '[threat-watch] Component reconciliation complete',
    );

    return { componentsConsidered: components.length, advisoriesMatched: advisoryIds.size };
  }

  /** Re-evaluate every advisory that names one corrected component. */
  async reconcileComponent(componentId: string): Promise<{ advisoriesMatched: number }> {
    const [component] = await this.db
      .select({
        id: inventoryComponents.id,
        ecosystem: inventoryComponents.ecosystem,
        componentKey: inventoryComponents.componentKey,
      })
      .from(inventoryComponents)
      .where(eq(inventoryComponents.id, componentId))
      .limit(1);

    if (!component) return { advisoriesMatched: 0 };

    const advisoryRows = await this.db
      .selectDistinct({ advisoryId: advisoryAffectedRanges.advisoryId })
      .from(advisoryAffectedRanges)
      .where(
        and(
          eq(advisoryAffectedRanges.ecosystem, component.ecosystem),
          eq(advisoryAffectedRanges.componentKey, component.componentKey),
        ),
      );

    for (const row of advisoryRows) {
      await this.matchAdvisory(row.advisoryId, { componentId: component.id });
    }

    return { advisoriesMatched: advisoryRows.length };
  }

  /**
   * Mark matches whose evidence has aged past the threshold.
   *
   * Staleness is not a mistake, it is an honest statement that we have not
   * looked recently — R3 requires it be visible rather than assumed away.
   */
  async markStaleMatches(stalenessThresholdDays: number): Promise<number> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - stalenessThresholdDays * DAY_MS);

    const stale = await this.db
      .update(exposureMatches)
      .set({ state: 'stale', stateReason: 'evidence_expired', updatedAt: now })
      .where(
        and(
          inArray(exposureMatches.state, ['candidate', 'notified'] as ExposureMatchState[]),
          sql`${exposureMatches.inventoryObservedAt} < ${cutoff}`,
        ),
      )
      .returning({ id: exposureMatches.id });

    return stale.length;
  }
}
