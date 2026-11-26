import { and, eq } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  advisories,
  assets,
  exposureMatchEvents,
  exposureMatches,
  findingEvidence,
  inventoryComponents,
  runs,
  type ExposureMatchState,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { CanonicalRiskService } from '@/domains/security-ops/risks/CanonicalRiskService';

/** A database handle or an open transaction; both support the same statements. */
type DbExecutor = DatabaseClient | Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export type CompleteVerificationParams = {
  organizationId: string;
  /** The verification run. The match is located through it, never by argument. */
  runId: string;
  userId: string;
  sessionId?: string;
  outcome: 'confirmed' | 'not_reproduced' | 'inconclusive';
  method: string;
  reason?: string | null;
  confidence?: number | null;
  /**
   * Already resolved against the run workspace by the caller — paths are
   * workspace-relative and every entry represents a real artifact file.
   * Exposure proof deliberately has no excerpt-only fallback.
   */
  evidence?: Array<{ path: string; label?: string }>;
};

/**
 * Closes the verification loop.
 *
 * The half that was missing: a run could be started and do the work, but nothing
 * carried the verdict back. A confirmed exposure now becomes a canonical Risk
 * carrying the advisory id. The match stays as source proof and is hidden as a
 * separate customer item once it links to that Risk.
 *
 * The whole transition is one transaction and guarded on the previous state, so
 * a late or duplicate submission cannot overwrite a customer's dismissal or a
 * verdict that already landed.
 */
export class ExposureVerificationCompletion {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async complete(
    params: CompleteVerificationParams,
  ): Promise<{ exposureMatchId: string; state: ExposureMatchState; riskId: string | null }> {
    const now = this.now();

    // A confirmed verdict creates a confirmed Risk, which is the strongest
    // claim this system makes. Allowing it without a durable artifact would let
    // a model assert exploitation it never demonstrated — and the whole product
    // rests on that claim being trustworthy.
    if (params.outcome === 'confirmed' && (params.evidence ?? []).length === 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_MISSING_REQUIRED,
        'A confirmed verdict requires at least one durable evidence artifact from this run',
      );
    }

    return this.db.transaction(async (tx) => {
      const [context] = await tx
        .select({
          exposureMatchId: exposureMatches.id,
          state: exposureMatches.state,
          assetId: exposureMatches.assetId,
          scopeId: runs.scopeId,
          assetValue: assets.value,
          advisoryCanonicalId: advisories.canonicalId,
          advisoryCveId: advisories.cveId,
          advisorySummary: advisories.summary,
          severity: advisories.severity,
          cvssVector: advisories.cvssV31Vector,
          cvssScore: advisories.cvssV31Score,
          componentName: inventoryComponents.displayName,
          componentVersion: inventoryComponents.resolvedVersion,
        })
        .from(exposureMatches)
        .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
        .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
        .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
        .innerJoin(runs, eq(runs.id, exposureMatches.verificationRunId))
        .where(
          and(
            // Located by the run that was started for it. This is both the
            // binding and the ownership check: a run can only close the exposure
            // it was created to answer.
            eq(exposureMatches.verificationRunId, params.runId),
            eq(exposureMatches.organizationId, params.organizationId),
          ),
        )
        .limit(1);

      if (!context) {
        throw new AppError(
          ERROR_CODES.RESOURCE_NOT_FOUND,
          'No exposure is awaiting verification from this run',
        );
      }

      const toState: ExposureMatchState =
        params.outcome === 'confirmed'
          ? 'confirmed'
          : params.outcome === 'not_reproduced'
            ? 'not_reproduced'
            : 'inconclusive';

      // Claim the verdict before doing anything that has a side effect.
      //
      // Reading `verifying` and then updating by id alone let two duplicate
      // submissions both pass the check and race to write different outcomes.
      // This conditional update is the arbiter: only one submission can move the
      // match out of `verifying`, so only one can create a finding.
      const [claimed] = await tx
        .update(exposureMatches)
        .set({
          state: toState,
          stateReason: [params.method, params.reason].filter(Boolean).join(' — ') || null,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(exposureMatches.id, context.exposureMatchId),
            eq(exposureMatches.state, 'verifying'),
          ),
        )
        .returning({ id: exposureMatches.id });

      if (!claimed) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'This exposure is not awaiting a verdict; it may already have been answered',
        );
      }

      const riskId =
        toState === 'confirmed' ? await this.createFinding(tx, { context, params, now }) : null;

      if (riskId) {
        await tx
          .update(exposureMatches)
          .set({ riskId, updatedAt: now })
          .where(eq(exposureMatches.id, context.exposureMatchId));
      }

      await tx.insert(exposureMatchEvents).values({
        matchId: context.exposureMatchId,
        organizationId: params.organizationId,
        type: 'state_changed',
        fromState: 'verifying',
        toState,
        actorUserId: params.userId,
        note: [params.method, params.reason].filter(Boolean).join(' — ') || null,
        createdAt: now,
      });

      logger.info(
        { exposureMatchId: context.exposureMatchId, outcome: params.outcome, riskId },
        '[threat-watch] Verification completed',
      );

      return { exposureMatchId: context.exposureMatchId, state: toState, riskId };
    });
  }

  /**
   * A confirmed exposure, expressed as a canonical Risk.
   *
   * Deliberately conservative in what it claims: the summary states what was
   * tested and reproduced, not that the asset is generally insecure. The dedupe
   * key is the match itself, so re-verifying the same exposure updates rather
   * than accumulating duplicates in the customer's list.
   */
  private async createFinding(
    tx: DbExecutor,
    input: {
      context: {
        exposureMatchId: string;
        assetId: string;
        scopeId: string | null;
        assetValue: string;
        advisoryCanonicalId: string;
        advisoryCveId: string | null;
        advisorySummary: string | null;
        severity: string | null;
        cvssVector: string | null;
        cvssScore: number | null;
        componentName: string;
        componentVersion: string | null;
      };
      params: CompleteVerificationParams;
      now: Date;
    },
  ): Promise<string> {
    const { context, params, now } = input;

    if (!context.scopeId) {
      // A confirmed source without a canonical Risk would create two truths.
      // Throwing here rolls back the claimed verdict and keeps it retryable.
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'A confirmed exposure verification run must belong to a scope',
      );
    }

    const component = `${context.componentName}${context.componentVersion ? ` ${context.componentVersion}` : ''}`;

    const riskId = await new CanonicalRiskService(tx, () => now).upsert({
        organizationId: params.organizationId,
        scopeId: context.scopeId,
        creatorUserId: params.userId,
        assetId: context.assetId,
        sourceKind: 'advisory_verification',
        sourceKey: `threat-watch:${context.exposureMatchId}`,
        title: `${context.advisoryCanonicalId} exploitable in ${component}`,
        severity: this.normalizeSeverity(context.severity),
        state: 'confirmed',
        summary:
          `${context.advisoryCanonicalId} was tested against ${context.assetValue} and reproduced. ` +
          `Observed component: ${component}.` +
          (context.advisorySummary ? ` Advisory: ${context.advisorySummary}` : ''),
        technicalAnalysis: params.method,
        pocDescription: params.reason ?? null,
        remediation: `Upgrade ${context.componentName} beyond the affected range for ${context.advisoryCanonicalId}.`,
        cvssVector: context.cvssVector,
        cvssScore: context.cvssScore,
        confidenceScore: params.confidence ?? 0.9,
        cveId: context.advisoryCveId,
        cveIds: context.advisoryCveId ? [context.advisoryCveId] : null,
        now,
      });

    // Persist the proof alongside the claim.
    //
    // A confirmed Risk the customer cannot inspect is just an assertion.
    // `finding_evidence` is the existing model the findings UI already reads, so
    // writing here means verification proof shows up wherever finding evidence
    // shows up, with no new surface to build.
    if ((params.evidence?.length ?? 0) > 0) {
      await tx
        .insert(findingEvidence)
        .values(
          params.evidence!.map((item) => ({
            organizationId: params.organizationId,
            findingId: riskId,
            userId: params.userId,
            sessionId: params.sessionId ?? null,
            kind: 'artifact' as const,
            path: item.path,
            label: item.label ?? null,
            excerpt: null,
            fileMissing: false,
            createdAt: now,
          })),
        )
        // Re-verification of the same exposure cites the same artifacts; the
        // finding is deduped on the match, so its evidence must be too.
        .onConflictDoNothing();
    }

    return riskId;
  }

  private normalizeSeverity(severity: string | null): string {
    const normalized = severity?.toLowerCase();
    return normalized && ['critical', 'high', 'medium', 'low', 'info'].includes(normalized)
      ? normalized
      : 'medium';
  }
}
