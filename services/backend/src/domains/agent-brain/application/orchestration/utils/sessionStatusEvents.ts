import { deriveSessionState, type SessionStatus } from '@null-ai/contracts';
import type { SessionState, StreamEvent } from '../../../domain/types';

type SessionStatusEventEmitter = {
  emit(sessionId: string, event: StreamEvent): void;
};

type SessionStatusTraceRecorder = {
  write?(sessionId: string, turn: number, event: {
    event: string;
    severity?: 'debug' | 'info' | 'warn' | 'error';
    payload?: Record<string, unknown>;
    note?: string;
  }): Promise<unknown>;
};

type SessionStatusLike = Pick<
  SessionState,
  'id' | 'version' | 'mode' | 'blockedReason' | 'pendingApproval' | 'stateMachine' | 'flags' | 'turn'
> & {
  completed?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const toBlockedReason = (session: SessionStatusLike): string | null =>
  session.blockedReason ?? (typeof session.flags?.blocked_reason === 'string' ? session.flags.blocked_reason : null) ?? null;

const inferStatusSource = (
  reason: string | undefined,
  status: SessionStatus,
): 'user' | 'system' | 'runner' | 'credit' | 'approval' | 'error' => {
  const normalized = reason?.toLowerCase() ?? '';
  if (normalized.includes('user') || normalized.includes('manual')) return 'user';
  if (normalized.includes('runner')) return 'runner';
  if (normalized.includes('credit')) return 'credit';
  if (normalized.includes('approval') || String(status) === 'awaiting_approval') return 'approval';
  if (normalized.includes('error') || normalized.includes('blocked') || String(status) === 'recoverable_pause') return 'error';
  return 'system';
};

const readSecurityOpsContext = (session: SessionStatusLike): { runId?: string; phaseId?: string } => {
  const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  return {
    runId: asString(securityops?.runId),
    phaseId: asString(securityops?.activePhaseId),
  };
};

export const deriveSessionStatusForEvent = (session: SessionStatusLike): SessionStatus =>
  deriveSessionState({
    blockedReason: toBlockedReason(session),
    isProcessing: session.stateMachine?.isProcessing() ?? false,
    pendingApproval: session.pendingApproval,
    completed: session.completed ?? false,
  }).status;

export const deriveSessionEventState = (session: SessionStatusLike) =>
  deriveSessionState({
    blockedReason: toBlockedReason(session),
    isProcessing: session.stateMachine?.isProcessing() ?? false,
    pendingApproval: session.pendingApproval,
    completed: session.completed ?? false,
  });

export const emitSessionStatusEvent = (
  emitter: SessionStatusEventEmitter,
  session: SessionStatusLike,
  previousStatus: SessionStatus,
  reason?: string,
  traceRecorder?: SessionStatusTraceRecorder,
): void => {
  const derived = deriveSessionEventState(session);
  const data = {
    id: session.id,
    status: derived.status,
    previousStatus,
    blocked_reason: derived.blockedReason,
    pause_reason: derived.pauseReason,
    interaction_type: derived.interactionType,
    reason,
    version: session.version ?? 0,
    updatedAt: Date.now(),
    mode: session.mode,
  };
  emitter.emit(session.id, {
    type: 'session.status',
    data,
  });
  if (!traceRecorder?.write) return;
  const context = readSecurityOpsContext(session);
  void traceRecorder.write(session.id, session.turn ?? 0, {
    event: 'session.status_changed',
    severity: derived.status === 'failed' ? 'error' : 'info',
    payload: {
      from: previousStatus,
      to: derived.status,
      reason,
      source: inferStatusSource(reason, derived.status),
      blocked_reason: derived.blockedReason,
      pause_reason: derived.pauseReason,
      interaction_type: derived.interactionType,
      mode: session.mode,
      ...context,
    },
    note: `session status ${previousStatus} -> ${derived.status}${reason ? ` (${reason})` : ''}`,
  }).catch(() => undefined);
};
