import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  advisories,
  assets,
  exposureMatchEvents,
  exposureMatches,
  inventoryComponents,
  inventoryNotes,
  type ExposureMatchState,
} from '@/db/schema';
import { logger } from '@/shared/logger';

export type InjectedLead = {
  matchId: string;
  noteId: string;
  advisoryId: string;
};

export type LeadInjectionOptions = {
  /** Most leads one run may receive. */
  maxPerRun?: number;
  /** Evidence older than this is too stale to hand a run as work. */
  stalenessThresholdDays?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turns unverified exposure matches into validation leads a run must close.
 *
 * Without this an unverified match is a notification that decays: the customer
 * sees it once and nothing ever settles it. As a lead it becomes work the next
 * run's validation phase cannot complete while leaving open, so the question
 * gets answered as part of an assessment they were already paying for.
 *
 * Rendered just in time rather than materialised when the match is created.
 * That distinction is load-bearing:
 *
 *  - run start loads up to 25 open scope leads, so eagerly writing one per
 *    match would flood a run with Threat Watch work and crowd out the leads the
 *    planner actually raised;
 *  - lead closure is checked against the owning `userId`, so a lead written by a
 *    background job could not be closed by another member's run at all;
 *  - and the validation phase cannot complete while leads remain open, which
 *    turns a noisy advisory day into runs that never finish.
 *
 * `exposure_matches` is already the durable hypothesis store. Leads are a
 * projection of it, created for one run, at the moment that run needs them.
 */
export class ExposureLeadInjector {
  private readonly maxPerRun: number;

  private readonly stalenessThresholdDays: number;

  constructor(
    private readonly db: DatabaseClient,
    options: LeadInjectionOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maxPerRun = options.maxPerRun ?? 5;
    this.stalenessThresholdDays = options.stalenessThresholdDays ?? 14;
  }

  /**
   * Select and render leads for one run.
   *
   * `userId` is the run's owner, and the lead is written under it so the run can
   * actually close what it is given.
   */
  async injectForRun(params: {
    organizationId: string;
    scopeId: string;
    userId: string;
    runId: string;
    sessionId?: string | null;
  }): Promise<InjectedLead[]> {
    const now = this.now();
    const freshnessCutoff = new Date(now.getTime() - this.stalenessThresholdDays * DAY_MS);

    const candidates = await this.db
      .select({
        matchId: exposureMatches.id,
        assetId: exposureMatches.assetId,
        advisoryId: advisories.canonicalId,
        severity: advisories.severity,
        kevListed: advisories.kevListed,
        priorityScore: exposureMatches.priorityScore,
        componentKey: inventoryComponents.componentKey,
        componentName: inventoryComponents.displayName,
        componentVersion: inventoryComponents.resolvedVersion,
        assetValue: assets.value,
      })
      .from(exposureMatches)
      .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
      .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
      .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
      .where(
        and(
          eq(exposureMatches.organizationId, params.organizationId),
          // Only matches we would defend as real work.
          inArray(exposureMatches.state, ['candidate', 'notified'] as ExposureMatchState[]),
          eq(exposureMatches.matchConfidence, 'exact_version'),
          // A conflicted or backport-risk component is exactly what verification
          // is for, but the evidence must at least be current.
          sql`${exposureMatches.inventoryObservedAt} >= ${freshnessCutoff}`,
          eq(inventoryComponents.versionConflict, false),
        ),
      )
      .orderBy(desc(exposureMatches.priorityScore))
      .limit(this.maxPerRun);

    if (candidates.length === 0) return [];

    const injected: InjectedLead[] = [];

    for (const candidate of candidates) {
      const dedupeKey = `exposure:${candidate.matchId}`;

      // A match already rendered for an earlier run must not be re-asked. The
      // note dedupe key carries the match id, so the writer collapses repeats.
      const [existing] = await this.db
        .select({ id: inventoryNotes.id })
        .from(inventoryNotes)
        .where(
          and(
            eq(inventoryNotes.organizationId, params.organizationId),
            eq(inventoryNotes.ntype, 'validation.lead'),
            eq(inventoryNotes.dedupeKey, dedupeKey),
          ),
        )
        .limit(1);

      if (existing) continue;

      const [note] = await this.db
        .insert(inventoryNotes)
        .values({
          userId: params.userId,
          organizationId: params.organizationId,
          scopeId: params.scopeId,
          assetId: candidate.assetId,
          sessionId: params.sessionId ?? null,
          ntype: 'validation.lead',
          title: `${candidate.advisoryId} may affect ${candidate.componentName}`,
          data: {
            source: 'threat_watch',
            exposureMatchId: candidate.matchId,
            advisoryId: candidate.advisoryId,
            componentKey: candidate.componentKey,
            observedVersion: candidate.componentVersion,
            assetValue: candidate.assetValue,
            severity: candidate.severity,
            kevListed: candidate.kevListed,
            hypothesis:
              `${candidate.componentName} ${candidate.componentVersion ?? ''}`.trim() +
              ` on ${candidate.assetValue} falls inside the affected range for ${candidate.advisoryId}. ` +
              'Confirm the version independently, check for a backported fix, and determine whether the ' +
              'documented vector reproduces. Failure to reproduce is not proof of safety.',
          },
          dedupeKey,
          confidence: 0.6,
          evidence: [],
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: inventoryNotes.id });

      if (!note) continue;

      await this.db
        .update(exposureMatches)
        .set({ state: 'verifying', stateReason: `queued as validation lead for run ${params.runId}`, updatedAt: now })
        .where(eq(exposureMatches.id, candidate.matchId));

      await this.db.insert(exposureMatchEvents).values({
        matchId: candidate.matchId,
        organizationId: params.organizationId,
        type: 'state_changed',
        toState: 'verifying',
        note: `Injected as validation lead for run ${params.runId}`,
        createdAt: now,
      });

      injected.push({
        matchId: candidate.matchId,
        noteId: note.id,
        advisoryId: candidate.advisoryId,
      });
    }

    if (injected.length > 0) {
      logger.info(
        { runId: params.runId, injected: injected.length },
        '[threat-watch] Injected exposure leads into run',
      );
    }

    return injected;
  }

  /**
   * Record a lead outcome back onto the match it came from.
   *
   * `deferred` and `blocked` return the match to the queue rather than closing
   * it: the run could not answer the question, which is different from having
   * answered it in the negative.
   */
  async applyLeadOutcome(params: {
    organizationId: string;
    exposureMatchId: string;
    outcome: 'validated' | 'false_positive' | 'blocked' | 'deferred' | 'superseded';
    reason?: string | null;
  }): Promise<{ state: ExposureMatchState }> {
    const now = this.now();

    const toState: ExposureMatchState =
      params.outcome === 'validated'
        ? 'confirmed'
        : params.outcome === 'false_positive'
          ? 'not_reproduced'
          : params.outcome === 'superseded'
            ? 'resolved'
            : 'notified';

    await this.db
      .update(exposureMatches)
      .set({
        state: toState,
        stateReason: params.reason ?? `validation lead closed as ${params.outcome}`,
        ...(toState === 'confirmed' || toState === 'not_reproduced' ? { verifiedAt: now } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(exposureMatches.id, params.exposureMatchId),
          eq(exposureMatches.organizationId, params.organizationId),
        ),
      );

    await this.db.insert(exposureMatchEvents).values({
      matchId: params.exposureMatchId,
      organizationId: params.organizationId,
      type: 'state_changed',
      fromState: 'verifying',
      toState,
      note: params.reason ?? `validation lead closed as ${params.outcome}`,
      createdAt: now,
    });

    return { state: toState };
  }
}
