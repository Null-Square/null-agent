import type { SessionState } from '../../../domain/types';
import type { GuardHandlingResult, PendingPlanStep } from './AutomationGuardHandler';
import { logger as appLogger } from '@/shared/logger';

/**
 * Unified decision for automation continuation.
 * Single source of truth - all callers respect this decision.
 */
export type AutomationDecision = {
  /** Action to take */
  action: 'continue' | 'stop' | 'await_user';
  /** Human-readable reason for the decision */
  reason: string;
  /** Message to send when action is 'continue' */
  message?: string;
  /** Optional durable backoff before continuing. */
  delayMs?: number;
  /** Additional payload for logging */
  payload?: Record<string, unknown>;
};

/**
 * Context for making automation decisions.
 * Contains all inputs needed to decide continue/stop.
 */
export interface DecisionContext {
  sessionId: string;
  session: SessionState;
  turnStatus: string;
  pendingPlanSteps: PendingPlanStep[];
  hasReport: boolean;
  requiresReport: boolean;
  guardResult?: GuardHandlingResult;
}

/** Operational waits are already scheduled durably by their owning handler. */
const DURABLY_SCHEDULED_WAIT_STATUSES = [
  'credits_exhausted',
  'token_limit_exceeded',
] as const;

const FAST_PLANNER_SUBMIT_CONTINUATIONS = 3;
const DEGRADED_PLANNER_RETRY_DELAY_MS = 30_000;

export const PLANNER_SUBMIT_REQUIRED_REASON = 'planner_submit_required';

const PLANNER_SUBMIT_REQUIRED_MESSAGE =
  'The run is still in planning because no plan has been submitted. Required planning context and prechecks have already been read or queried. Do not read more skill, workspace, or methodology files unless submit_plan explicitly rejects the plan and names missing data. Call submit_plan now with the user-facing markdown plan, missions[], and skillSlugs.';

const EXPOSURE_VERIFICATION_SUBMIT_REQUIRED_MESSAGE =
  'The bound CVE exposure verification is not closed yet. Do not call submit_plan. Complete only the remaining evidence-bounded verification work, then call submit_exposure_verification exactly once. Use inconclusive if the required proof or a safe verification path is unavailable.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getActivePhaseKey = (session: SessionState): string | null => {
  const securityopsFlags = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const phaseKey = securityopsFlags?.activePhaseKey;
  return typeof phaseKey === 'string' && phaseKey.trim().length > 0
    ? phaseKey.trim().toLowerCase()
    : null;
};

const getSecurityOpsFlags = (session: SessionState): Record<string, unknown> | undefined =>
  isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;

const isSessionCompleted = (session: SessionState): boolean => {
  if (session.completed === true) {
    return true;
  }
  const sessionFlags = isRecord(session.flags?.session) ? session.flags.session : undefined;
  return sessionFlags?.completed === true;
};

const isRunBoundPlannerAwaitingPlan = (session: SessionState): boolean => {
  const securityopsFlags = getSecurityOpsFlags(session);
  return (
    session.agentType === 'planner' &&
    typeof securityopsFlags?.runId === 'string' &&
    securityopsFlags.runId.trim().length > 0 &&
    !isSessionCompleted(session) &&
    !session.pendingApproval
  );
};

const getPlannerSubmitContinuationCount = (session: SessionState): number => {
  const state = isRecord(session.flags?.plannerSubmitRetry)
    ? session.flags.plannerSubmitRetry
    : undefined;
  const count = state?.count;
  return typeof count === 'number' && Number.isFinite(count) && count > 0
    ? count
    : 0;
};

/**
 * Unified Decision Engine for Automation Continuation.
 * 
 * DESIGN PRINCIPLE: Single source of truth for continue/stop decisions.
 * All automation concerns (guard, continuation, limits) go through here.
 * 
 * Priority order (highest to lowest):
 * 1. Session has blockedReason → stop
 * 2. Session completion is recorded → stop
 * 3. Session mode is not 'automated' → stop
 * 4. Turn status is terminal → stop
 * 5. Guard already scheduled retry → defer to guard
 * 6. Pending steps OR missing report → continue
 * 7. Otherwise → task complete, stop
 */
export class AutomationDecisionEngine {
  private readonly log = appLogger.child({ scope: 'AutomationDecisionEngine' });

  /**
   * Decide whether automation should continue, stop, or await user.
   * This is the ONLY method that should determine automation flow.
   */
  decide(context: DecisionContext): AutomationDecision {
    const { sessionId, session, turnStatus, pendingPlanSteps, hasReport, requiresReport, guardResult } = context;
    const pendingSteps = pendingPlanSteps ?? [];

    // Priority 1: Session blocked
    if (session.blockedReason) {
      return this.stop('blocked', session.blockedReason, {
        blockedReason: session.blockedReason,
      });
    }

    // Priority 2: Completion is monotonic. Stale plan, report, or handoff projections may
    // remain after closeout, but none of them may restart a completed session.
    if (isSessionCompleted(session)) {
      return this.stop('session_completed', 'Session is already complete');
    }

    // Priority 3: Not automated mode
    if (session.mode !== 'automated') {
      return this.stop('not_automated', 'Session is in interactive mode');
    }

    // Priority 4: Only a structured input request awaits a person. Operational
    // waits retain running intent and were already scheduled by their owner.
    if (turnStatus === 'awaiting_user') {
      return this.awaitUser(turnStatus, `Turn ended with status: ${turnStatus}`);
    }
    if (turnStatus === 'aborted') {
      return this.stop('turn_aborted', 'The current turn was explicitly interrupted');
    }
    if (DURABLY_SCHEDULED_WAIT_STATUSES.includes(
      turnStatus as typeof DURABLY_SCHEDULED_WAIT_STATUSES[number],
    )) {
      return this.stop('durable_wait_scheduled', `Turn wait already scheduled: ${turnStatus}`);
    }

    // Priority 5: Guard already handling. Crossing its fast retry budget is
    // diagnostic only; the handler has already scheduled a slower retry.
    if (guardResult?.scheduleAutoRetry) {
      return this.stop('guard_handling', 'Guard already scheduled retry');
    }

    // Priority 6: Work remaining → continue
    const hasPendingWork = pendingSteps.length > 0;
    const hasMissingRequiredReport = requiresReport && !hasReport;
    const securityopsFlags = getSecurityOpsFlags(session);
    const activePhaseKey = getActivePhaseKey(session);
    const isReportingPhaseHandoff = activePhaseKey === 'reporting';
    if (
      securityopsFlags?.phaseHandoffSubmitted === true &&
      (!isReportingPhaseHandoff || !hasMissingRequiredReport)
    ) {
      return this.stop(
        'phase_handoff_submitted',
        'Phase handoff accepted; lifecycle should start the next phase session',
        {
          activePhaseId: securityopsFlags.activePhaseId,
          activePhaseKey: securityopsFlags.activePhaseKey,
          phaseHandoffStatus: securityopsFlags.phaseHandoffStatus,
        },
      );
    }

    if (
      activePhaseKey &&
      activePhaseKey !== 'planning' &&
      securityopsFlags?.phaseHandoffSubmitted !== true &&
      !hasPendingWork &&
      !hasMissingRequiredReport
    ) {
      return {
        action: 'continue',
        reason: `phase_handoff_missing: active phase ${activePhaseKey} has not submitted handoff`,
        message:
          'The phase plan is complete, but this phase is not closed. Call submit_phase_handoff now with the active phase id, terminal phase status, completed objectives, unresolved questions, canonical writes, artifacts, and evidence references.',
        payload: {
          activePhaseId: securityopsFlags?.activePhaseId,
          activePhaseKey,
          hasReport,
          requiresReport,
        },
      };
    }

    if (isRunBoundPlannerAwaitingPlan(session)) {
      const continuationCount = getPlannerSubmitContinuationCount(session);
      const isExposureVerification = securityopsFlags?.runTrigger === 'exposure_verification';
      return {
        action: 'continue',
        reason: isExposureVerification
          ? `${PLANNER_SUBMIT_REQUIRED_REASON}:exposure_verification`
          : PLANNER_SUBMIT_REQUIRED_REASON,
        message: isExposureVerification
          ? EXPOSURE_VERIFICATION_SUBMIT_REQUIRED_MESSAGE
          : PLANNER_SUBMIT_REQUIRED_MESSAGE,
        ...(continuationCount >= FAST_PLANNER_SUBMIT_CONTINUATIONS
          ? { delayMs: DEGRADED_PLANNER_RETRY_DELAY_MS }
          : {}),
        payload: {
          continuationAttempt: continuationCount + 1,
          fastContinuationBudget: FAST_PLANNER_SUBMIT_CONTINUATIONS,
          degradedBackoff: continuationCount >= FAST_PLANNER_SUBMIT_CONTINUATIONS,
          runId: securityopsFlags?.runId,
        },
      };
    }

    if (hasPendingWork || hasMissingRequiredReport) {
      const reason = hasPendingWork
        ? `pending_steps:${pendingSteps.length}`
        : 'report_missing';
      
      this.log.debug(
        { sessionId, reason, pendingSteps: pendingSteps.length, hasReport, requiresReport },
        '[DecisionEngine] Continuing automation'
      );

      return {
        action: 'continue',
        reason,
        message: 'continue',
        payload: { pendingSteps: pendingSteps.length, hasReport, requiresReport },
      };
    }

    // Priority 7: Task complete
    return this.stop('task_complete', 'All steps done and report exists');
  }

  private stop(reason: string, description: string, payload?: Record<string, unknown>): AutomationDecision {
    return { action: 'stop', reason: `${reason}: ${description}`, payload };
  }

  private awaitUser(reason: string, description: string, payload?: Record<string, unknown>): AutomationDecision {
    return { action: 'await_user', reason: `${reason}: ${description}`, payload };
  }
}

/** Singleton instance for shared use */
let decisionEngineInstance: AutomationDecisionEngine | null = null;

export function getDecisionEngine(): AutomationDecisionEngine {
  if (!decisionEngineInstance) {
    decisionEngineInstance = new AutomationDecisionEngine();
  }
  return decisionEngineInstance;
}

export default AutomationDecisionEngine;
