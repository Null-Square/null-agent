import type { SessionAction, SessionState } from '../slices/sessionSlice';
import type { ApprovalRequest, SandboxPolicy } from '@/types/chat';

export const setSessionStatus = (
  status: SessionState['status']
): SessionAction => ({
  type: 'session/setStatus',
  payload: status,
});

export const setStatusWithVersion = (
  status: SessionState['status'],
  version: number,
  pauseReason?: SessionState['pauseReason'],
  interactionType?: SessionState['interactionType'],
): SessionAction => ({
  type: 'session/setStatusWithVersion',
  payload: { status, version, pauseReason, interactionType },
});

export const setPauseMeta = (
  pauseReason?: SessionState['pauseReason'],
  interactionType?: SessionState['interactionType'],
  blockedReason?: string | null,
): SessionAction => ({
  type: 'session/setPauseMeta',
  payload: { pauseReason, interactionType, blockedReason },
});

export const setLoading = (value: boolean): SessionAction => ({
  type: 'session/setLoading',
  payload: value,
});

export const setAborting = (value: boolean): SessionAction => ({
  type: 'session/setAborting',
  payload: value,
});

export const resetSession = (): SessionAction => ({
  type: 'session/reset',
});

export const setSandboxPolicy = (policy?: SandboxPolicy): SessionAction => ({
  type: 'session/setSandboxPolicy',
  payload: policy,
});

export const setPendingApproval = (approval: ApprovalRequest | null): SessionAction => ({
  type: 'session/setPendingApproval',
  payload: approval,
});

export const clearPendingApproval = (actionId?: string): SessionAction => ({
  type: 'session/clearPendingApproval',
  payload: actionId ? { actionId } : undefined,
});

export const setBlockedReason = (reason: string | null): SessionAction => ({
  type: 'session/setBlockedReason',
  payload: reason,
});

export const setStreamConnected = (value: boolean): SessionAction => ({
  type: 'session/setStreamConnected',
  payload: value,
});

export const markStreamActivity = (
  timestamp?: number,
  kind: 'event' | 'ping' = 'event',
): SessionAction => ({
  type: 'session/markStreamActivity',
  payload: { timestamp, kind },
});
