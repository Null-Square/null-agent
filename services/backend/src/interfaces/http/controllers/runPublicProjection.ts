import { deriveRunDisplayState } from '@/domains/security-ops/runs/RunService';

export const customerRunnerId = (run: { executionTarget?: string | null; runnerId?: string | null }): string | null =>
  run.executionTarget === 'cloud' ? null : (run.runnerId ?? null);

export const customerRunnerName = (
  run: { executionTarget?: string | null },
  runnerName: string | null | undefined,
): string | null => (run.executionTarget === 'cloud' ? null : (runnerName ?? null));

export const customerCapacityWaitReason = (reason: string | null | undefined): string | null => {
  if (!reason) return null;
  if (reason === 'waiting_for_plan_slot') return 'waiting_for_plan_slot';
  if (reason.startsWith('profile_exceeds')) return 'unable_to_schedule_safely';
  if (reason === 'claiming') return 'preparing_secure_environment';
  if (reason === 'admission_worker_recovered') return 'launch_recovered';
  return 'waiting_for_capacity';
};

export const schedulingProjection = (run: {
  status: string;
  capacityWaitReason?: string | null;
  queuedAt?: Date | string | null;
  createdAt?: Date | string | null;
  claimOwner?: string | null;
  admittedAt?: Date | string | null;
}) =>
  run.status === 'queued'
    ? {
        state: run.admittedAt || run.claimOwner ? 'preparing' : 'queued',
        reason: customerCapacityWaitReason(run.capacityWaitReason) ?? 'waiting_for_capacity',
        submittedAt: run.queuedAt ?? run.createdAt ?? null,
        estimatedStart: null,
      }
    : {
        state: 'started',
        reason: null,
        submittedAt: run.queuedAt ?? run.createdAt ?? null,
        estimatedStart: null,
      };

export const withRunUiFlags = <
  TRun extends {
    sessionId?: string | null;
    goal: string;
    status: string;
    executorSessionId?: string | null;
    plan?: string | null;
    executionTarget?: string | null;
    runnerId?: string | null;
  },
>(
  run: TRun,
): Omit<
  TRun,
  | 'missionEnvelope'
  | 'launchPayload'
  | 'claimOwner'
  | 'claimExpiresAt'
  | 'admissionEpoch'
  | 'admissionPurpose'
  | 'schedulingClass'
  | 'capacityProfile'
  | 'capacityProfileVersion'
  | 'admittedAt'
  | 'eligibleAt'
  | 'notBeforeAt'
  | 'admissionAttemptCount'
  | 'admissionLastError'
  | 'epochStartedAt'
> & {
  activeSessionId: string | null;
  status: ReturnType<typeof deriveRunDisplayState>['status'];
  pauseReason: ReturnType<typeof deriveRunDisplayState>['pauseReason'];
  interactionType: ReturnType<typeof deriveRunDisplayState>['interactionType'];
  awaitingPlanApproval: boolean;
} => {
  const {
    missionEnvelope: _missionEnvelope,
    launchPayload: _launchPayload,
    claimOwner: _claimOwner,
    claimExpiresAt: _claimExpiresAt,
    admissionEpoch: _admissionEpoch,
    admissionPurpose: _admissionPurpose,
    schedulingClass: _schedulingClass,
    capacityProfile: _capacityProfile,
    capacityProfileVersion: _capacityProfileVersion,
    admittedAt: _admittedAt,
    eligibleAt: _eligibleAt,
    notBeforeAt: _notBeforeAt,
    admissionAttemptCount: _admissionAttemptCount,
    admissionLastError: _admissionLastError,
    epochStartedAt: _epochStartedAt,
    ...publicRun
  } = run as TRun & {
    missionEnvelope?: unknown;
    launchPayload?: unknown;
    claimOwner?: unknown;
    claimExpiresAt?: unknown;
    admissionEpoch?: unknown;
    admissionPurpose?: unknown;
    schedulingClass?: unknown;
    capacityProfile?: unknown;
    capacityProfileVersion?: unknown;
    admittedAt?: unknown;
    eligibleAt?: unknown;
    notBeforeAt?: unknown;
    admissionAttemptCount?: unknown;
    admissionLastError?: unknown;
    epochStartedAt?: unknown;
  };
  const displayState = deriveRunDisplayState({
    goal: publicRun.goal,
    status: publicRun.status,
    executorSessionId: publicRun.executorSessionId ?? null,
    plan: publicRun.plan ?? null,
  });
  const customerRun = {
    ...publicRun,
    runnerId: customerRunnerId(publicRun),
    capacityWaitReason: customerCapacityWaitReason(
      (publicRun as { capacityWaitReason?: string | null }).capacityWaitReason,
    ),
  };

  return {
    ...customerRun,
    activeSessionId: customerRun.sessionId ?? null,
    status: displayState.status,
    pauseReason: displayState.pauseReason,
    interactionType: displayState.interactionType,
    awaitingPlanApproval: displayState.awaitingPlanApproval,
  };
};
