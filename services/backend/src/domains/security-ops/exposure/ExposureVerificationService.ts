import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  advisories,
  assets,
  exposureMatchEvents,
  exposureMatches,
  inventoryComponents,
  runs,
  type ExposureMatchState,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { ExecutionSelection } from '@/domains/agent-brain/domain/runtime/ExecutionRuntimeRegistry';

export type VerificationOutcome = 'confirmed' | 'not_reproduced' | 'inconclusive';

export type StartVerificationParams = {
  organizationId: string;
  userId: string;
  matchId: string;
  executionSelection?: ExecutionSelection;
};

export type StartVerificationResult = {
  matchId: string;
  runId: string;
  /** True when an existing in-flight verification was returned instead. */
  alreadyRunning: boolean;
};

export type SubmitVerificationParams = {
  organizationId: string;
  matchId: string;
  outcome: VerificationOutcome;
  method: string;
  confidence?: number | null;
  reason?: string | null;
  riskId?: string | null;
  actorUserId?: string | null;
};

/**
 * Verification: turning "your version looks affected" into "we tested it".
 *
 * Two things in here are load-bearing and neither is provided by the run
 * launcher:
 *
 *  1. **Admission is enforced here.** `StartRunService` contains no access
 *     control — the runs router applies it before calling. A new entry point
 *     inherits nothing, so entitlement, credits and concurrency are applied
 *     explicitly below. Forgetting would let anyone spend an organization's
 *     credits through this route.
 *  2. **A finished run means nothing by itself.** The outcome is a typed
 *     submission bound to the match, and a run that dies without one is
 *     resolved to `inconclusive` by the recovery pass rather than leaving the
 *     match stuck in `verifying` forever.
 */
export class ExposureVerificationService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly deps: {
      /** Applies entitlement, credit and concurrency gates. Must not be skipped. */
      enforceVerificationAdmission: (params: {
        organizationId: string;
        userId: string;
      }) => Promise<void>;
      startVerificationRun: (params: {
        organizationId: string;
        userId: string;
        scopeId: string;
        goal: string;
        vars: Record<string, unknown>;
        executionSelection?: ExecutionSelection;
      }) => Promise<{ runId: string }>;
    } | undefined = undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Build the goal for a verification run.
   *
   * Deliberately narrow and explicit about what is *not* in scope. A
   * verification that wanders into a general pentest destroys the cost argument
   * that makes one-click verification viable on a low-price tier.
   */
  static buildGoal(params: {
    advisoryId: string;
    assetValue: string;
    componentDisplayName: string;
    observedVersion: string | null;
  }): string {
    const version = params.observedVersion ? ` ${params.observedVersion}` : '';
    return [
      `Determine whether ${params.advisoryId} is exploitable against ${params.assetValue}.`,
      `We observed ${params.componentDisplayName}${version} on this asset.`,
      '',
      'Scope: this single advisory against this single asset. Do not test any other',
      'vulnerability class, host, or advisory, and do not perform general reconnaissance',
      'beyond what is needed to confirm this one question.',
      '',
      'Confirm the component version independently rather than trusting the banner.',
      'Check for backport indicators before concluding from a version string alone:',
      'distributions routinely patch without changing the version.',
      '',
      'Conclude with exactly one of: confirmed (reproduced with evidence),',
      'not_reproduced (the documented vector did not work here), or inconclusive',
      '(blocked or insufficient evidence). Failure to reproduce is not proof of safety.',
    ].join('\n');
  }

  /**
   * Start a verification run for a match.
   *
   * Idempotent by state rather than by key: a match already `verifying` returns
   * its in-flight run, so a double-click or a retry cannot spend twice.
   */
  async startVerification(params: StartVerificationParams): Promise<StartVerificationResult> {
    const startDeps = this.deps;
    if (!startDeps) {
      throw new AppError(
        ERROR_CODES.INTERNAL_CONFIGURATION,
        'Exposure verification run start is not configured on this service',
      );
    }
    const context = await this.loadMatchContext(params.organizationId, params.matchId);

    if (context.state === 'verifying' && context.verificationRunId) {
      return { matchId: params.matchId, runId: context.verificationRunId, alreadyRunning: true };
    }

    if (context.state === 'dismissed' || context.state === 'resolved') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Cannot verify a match in state "${context.state}"`,
      );
    }

    if (!context.scopeId) {
      // A run needs a scope to carry its authorization boundary. An asset whose
      // originating scope was deleted has none, so verification is unavailable
      // until it is observed under a live scope again.
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Cannot verify: this asset has no live scope to run under',
      );
    }

    // Explicitly, because nothing upstream does it for this entry point.
    await startDeps.enforceVerificationAdmission({
      organizationId: params.organizationId,
      userId: params.userId,
    });

    const goal = ExposureVerificationService.buildGoal({
      advisoryId: context.advisoryCanonicalId,
      assetValue: context.assetValue,
      componentDisplayName: context.componentDisplayName,
      observedVersion: context.resolvedVersion,
    });

    // Claim the match *before* starting a paid run.
    //
    // The read, the run creation and the state write are three steps, so two
    // concurrent requests could previously both pass the state check and both
    // spend credits. This conditional update is the claim: only one request can
    // move the match out of an open state, and only the winner starts a run.
    const now = this.now();
    const [claimed] = await this.db
      .update(exposureMatches)
      .set({ state: 'verifying', stateReason: 'verification requested', updatedAt: now })
      .where(
        and(
          eq(exposureMatches.id, params.matchId),
          eq(exposureMatches.organizationId, params.organizationId),
          inArray(exposureMatches.state, [
            'candidate',
            'notified',
            'stale',
            'inconclusive',
            'not_reproduced',
          ] as ExposureMatchState[]),
        ),
      )
      .returning({ id: exposureMatches.id });

    if (!claimed) {
      // Someone else won the race. Return their run rather than starting a second.
      const current = await this.loadMatchContext(params.organizationId, params.matchId);
      if (current.state === 'verifying' && current.verificationRunId) {
        return {
          matchId: params.matchId,
          runId: current.verificationRunId,
          alreadyRunning: true,
        };
      }
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Cannot verify a match in state "${current.state}"`,
      );
    }

    let runId: string;
    try {
      const started = await startDeps.startVerificationRun({
        organizationId: params.organizationId,
        userId: params.userId,
        scopeId: context.scopeId,
        goal,
        vars: {
          exposureMatchId: params.matchId,
          advisoryId: context.advisoryCanonicalId,
          componentKey: context.componentKey,
          observedVersion: context.resolvedVersion,
          assetValue: context.assetValue,
        },
        executionSelection: params.executionSelection,
      });
      runId = started.runId;
    } catch (error) {
      // Release the claim, or the match is stranded in `verifying` with no run
      // behind it until the recovery pass eventually writes it off.
      await this.db
        .update(exposureMatches)
        .set({ state: context.state, stateReason: 'verification could not start', updatedAt: now })
        .where(eq(exposureMatches.id, params.matchId));
      throw error;
    }

    await this.db
      .update(exposureMatches)
      .set({ verificationRunId: runId, updatedAt: now })
      .where(eq(exposureMatches.id, params.matchId));

    await this.db.insert(exposureMatchEvents).values({
      matchId: params.matchId,
      organizationId: params.organizationId,
      type: 'state_changed',
      fromState: context.state,
      toState: 'verifying',
      actorUserId: params.userId,
      note: `Verification run ${runId} started`,
      createdAt: now,
    });

    return { matchId: params.matchId, runId, alreadyRunning: false };
  }

  /**
   * Record the typed outcome of a verification.
   *
   * Only a match actually in `verifying` may be closed this way; anything else
   * means the submission is stale or forged, and silently accepting it would
   * let a late result overwrite a customer's own dismissal.
   */
  async submitVerification(params: SubmitVerificationParams): Promise<{ state: ExposureMatchState }> {
    const context = await this.loadMatchContext(params.organizationId, params.matchId);

    if (context.state !== 'verifying') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Match is not awaiting verification (state "${context.state}")`,
      );
    }

    const toState: ExposureMatchState =
      params.outcome === 'confirmed'
        ? 'confirmed'
        : params.outcome === 'not_reproduced'
          ? 'not_reproduced'
          : 'inconclusive';

    const transitioned = await this.transition({
      matchId: params.matchId,
      organizationId: params.organizationId,
      fromState: 'verifying',
      toState,
      note: [params.method, params.reason].filter(Boolean).join(' — '),
      actorUserId: params.actorUserId ?? null,
      extra: {
        verifiedAt: this.now(),
        ...(params.riskId ? { riskId: params.riskId } : {}),
      },
    });

    if (!transitioned) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'The exposure changed state before this verdict could be recorded',
      );
    }

    return { state: toState };
  }

  /**
   * Rescue matches whose verification run ended without a submission.
   *
   * A crashed, cancelled or timed-out run would otherwise strand a match in
   * `verifying` permanently: invisible to the customer, never re-verifiable,
   * and never alertable. Resolved to `inconclusive` so it returns to the queue
   * rather than silently disappearing.
   *
   * Age alone is not sufficient evidence that a verification died. A deep run
   * against a slow target can legitimately exceed any cutoff, and writing it off
   * mid-flight would discard work the customer already paid for and could race
   * the submission itself. So the run's own terminal status decides, and age
   * only limits how far back to look.
   *
   * The exception is a match in `verifying` with no run bound at all. That is
   * the crash window between starting the run and persisting its id: the state
   * write cannot join the run start in one transaction, because starting a run
   * is an external side effect. Rather than reach for an outbox to close a
   * window this narrow, the orphan is recognised here — after enough time has
   * passed that a slow bind cannot be the explanation.
   */
  async recoverStalledVerifications(params: { olderThanMinutes: number }): Promise<number> {
    const cutoff = new Date(this.now().getTime() - params.olderThanMinutes * 60 * 1000);

    const stalled = await this.db
      .select({ id: exposureMatches.id, organizationId: exposureMatches.organizationId })
      .from(exposureMatches)
      .leftJoin(runs, eq(runs.id, exposureMatches.verificationRunId))
      .where(
        and(
          eq(exposureMatches.state, 'verifying'),
          sql`${exposureMatches.updatedAt} < ${cutoff}`,
          or(
            isNull(exposureMatches.verificationRunId),
            inArray(runs.status, ['completed', 'failed', 'cancelled']),
          ),
        ),
      )
      .limit(200);

    let recovered = 0;
    for (const match of stalled) {
      const transitioned = await this.transition({
        matchId: match.id,
        organizationId: match.organizationId,
        fromState: 'verifying',
        toState: 'inconclusive',
        note: 'Verification run ended without submitting an outcome',
        actorUserId: null,
        extra: {},
      });
      if (transitioned) recovered += 1;
    }

    if (recovered > 0) {
      logger.warn(
        { recovered },
        '[threat-watch] Recovered verifications that ended without an outcome',
      );
    }

    return recovered;
  }

  private async loadMatchContext(organizationId: string, matchId: string) {
    const [row] = await this.db
      .select({
        state: exposureMatches.state,
        // Components are organization+asset scoped; scope lives on the
        // observation. The asset's originating scope is the run's home, which
        // is also the scope whose authorization boundary the run must respect.
        scopeId: assets.scopeId,
        verificationRunId: exposureMatches.verificationRunId,
        assetValue: assets.value,
        componentKey: inventoryComponents.componentKey,
        componentDisplayName: inventoryComponents.displayName,
        resolvedVersion: inventoryComponents.resolvedVersion,
        advisoryCanonicalId: advisories.canonicalId,
      })
      .from(exposureMatches)
      .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
      .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
      .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
      .where(
        and(eq(exposureMatches.id, matchId), eq(exposureMatches.organizationId, organizationId)),
      )
      .limit(1);

    if (!row) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Exposure match not found');
    }

    return row;
  }

  private async transition(params: {
    matchId: string;
    organizationId: string;
    fromState: ExposureMatchState;
    toState: ExposureMatchState;
    note: string;
    actorUserId: string | null;
    extra: Record<string, unknown>;
  }): Promise<boolean> {
    const now = this.now();

    const [transitioned] = await this.db
      .update(exposureMatches)
      .set({ state: params.toState, updatedAt: now, ...params.extra })
      .where(
        and(
          eq(exposureMatches.id, params.matchId),
          eq(exposureMatches.organizationId, params.organizationId),
          eq(exposureMatches.state, params.fromState),
        ),
      )
      .returning({ id: exposureMatches.id });

    if (!transitioned) return false;

    await this.db.insert(exposureMatchEvents).values({
      matchId: params.matchId,
      organizationId: params.organizationId,
      type: 'state_changed',
      fromState: params.fromState,
      toState: params.toState,
      actorUserId: params.actorUserId,
      note: params.note,
      createdAt: now,
    });
    return true;
  }
}
