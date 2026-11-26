import type {
  DesiredSessionExecution,
  SessionExecutionReadModel,
} from '@null-ai/contracts';
import type { SessionJournalFold } from '../../domain/session-journal';
import type { SessionExecutionCoordinationFacts } from '../../ports/sessionRepository';

export interface SessionExecutionReadFacts {
  fold: Pick<
    SessionJournalFold,
    | 'desiredExecution'
    | 'isCompleted'
    | 'pendingApprovalActionId'
    | 'hasUnfinishedWork'
    | 'lastDeferredReason'
  >;
  coordination: SessionExecutionCoordinationFacts;
}

const SAFE_PREREQUISITE_REASONS = new Set([
  'awaiting_user',
  'guard_exhausted',
  'scope_unavailable',
  'sandbox_unavailable',
  'provider_quota_exhausted',
  'token_limit',
  'wall_timeout',
  'system_paused',
]);

const ignoredCompatibilityReason = (reason: string | null): boolean =>
  reason === null
  || reason === 'user_paused'
  || reason === 'aborted_by_user'
  || reason === 'error';

/**
 * Project presentation state from canonical history plus durable coordination.
 *
 * This function is intentionally pure. Recovery and execution code must never
 * consume its output; the journal fold and lease predicates remain authority.
 */
export const projectSessionExecutionReadModel = (
  facts: SessionExecutionReadFacts,
  now: Date = new Date(),
): SessionExecutionReadModel => {
  const { fold, coordination } = facts;
  const blockedReason = coordination.blockedReason;

  if (fold.isCompleted || coordination.completed) {
    return {
      desiredExecution: fold.desiredExecution,
      condition: 'completed',
    };
  }

  if (fold.pendingApprovalActionId || blockedReason === 'awaiting_approval') {
    return {
      desiredExecution: fold.desiredExecution,
      condition: 'waiting_approval',
    };
  }

  if (blockedReason === 'credits_exhausted') {
    return {
      desiredExecution: fold.desiredExecution,
      condition: 'waiting_credits',
    };
  }

  if (blockedReason === 'runner_unavailable') {
    return {
      desiredExecution: fold.desiredExecution,
      condition: 'waiting_runner',
    };
  }

  if (
    !ignoredCompatibilityReason(blockedReason)
    && blockedReason !== null
    && SAFE_PREREQUISITE_REASONS.has(blockedReason)
  ) {
    return {
      desiredExecution: fold.desiredExecution,
      condition: 'waiting_prerequisite',
      conditionReason: blockedReason,
    };
  }

  const hasValidExecutionOwner = Boolean(
    coordination.executionClaimToken
    && coordination.executionClaimExpiresAt
    && coordination.executionClaimExpiresAt.getTime() > now.getTime(),
  );
  if (hasValidExecutionOwner) {
    return {
      desiredExecution: fold.desiredExecution,
      condition: 'executing',
    };
  }

  if (fold.desiredExecution === 'running' && fold.hasUnfinishedWork) {
    return {
      desiredExecution: fold.desiredExecution,
      condition: 'recovering',
      ...(blockedReason === 'error' || fold.lastDeferredReason
        ? { conditionReason: fold.lastDeferredReason ?? 'runtime_interruption' }
        : {}),
    };
  }

  return {
    desiredExecution: fold.desiredExecution,
    condition: 'idle',
  };
};

/**
 * Server-only compatibility for historical rows without a journal genesis.
 * It intentionally never claims recovery because legacy rows cannot prove
 * unfinished semantic work. New clients still receive the canonical shape.
 */
export const projectLegacySessionExecutionReadModel = (
  coordination: SessionExecutionCoordinationFacts,
  now: Date = new Date(),
): SessionExecutionReadModel => {
  const desiredExecution: DesiredSessionExecution = coordination.blockedReason === 'user_paused'
    || coordination.blockedReason === 'aborted_by_user'
    ? 'stopped'
    : 'running';
  const fold = {
    desiredExecution,
    isCompleted: false,
    pendingApprovalActionId: undefined,
    hasUnfinishedWork: false,
    lastDeferredReason: undefined,
  };
  return projectSessionExecutionReadModel({ fold, coordination }, now);
};
