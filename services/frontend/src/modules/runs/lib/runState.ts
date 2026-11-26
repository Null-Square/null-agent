import type { Run } from '@/modules/security-ops/types';

type PlanApprovalCandidate = Pick<
  Run,
  'goal' | 'status' | 'executorSessionId' | 'plan' | 'awaitingPlanApproval' | 'interactionType'
>;

type RunSessionCandidate = Pick<
  Run,
  'status' | 'activeSessionId' | 'sessionId' | 'plannerSessionId' | 'executorSessionId'
>;

export function resolveRunSessionId(run?: RunSessionCandidate | null): string | undefined {
  if (!run) {
    return undefined;
  }

  if (run.executorSessionId) {
    return run.executorSessionId;
  }

  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return run.sessionId ?? run.activeSessionId ?? run.plannerSessionId ?? undefined;
  }

  return run.activeSessionId ?? run.sessionId ?? run.plannerSessionId ?? undefined;
}

export function isRunAwaitingPlanApproval(run?: PlanApprovalCandidate | null): boolean {
  if (!run) {
    return false;
  }

  if (run.status !== 'paused') {
    return false;
  }

  if (typeof run.awaitingPlanApproval === 'boolean') {
    return run.awaitingPlanApproval;
  }
  return Boolean(
    run.goal &&
    run.interactionType === 'plan_approval' &&
    !run.executorSessionId &&
    typeof run.plan === 'string' &&
    run.plan.trim().length > 0,
  );
}
