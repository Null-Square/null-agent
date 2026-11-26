/**
 * Legacy Session Types
 *
 * Prefer ChatSessionMeta from `@/types/chat` for live app code.
 * This file remains for compatibility with older helpers/tests.
 */

import {
  canAcceptSessionInput,
  resolveSessionActions,
  type SessionInteractionType,
  type SessionPauseReason,
  type SessionStatus as BackendSessionStatus,
  type DesiredSessionExecution,
  type SessionExecutionCondition,
} from '@null-ai/contracts';

export type { SessionInteractionType, SessionPauseReason };
export type SessionMode = 'interactive' | 'automated';

export interface SessionArtifact {
  id: string;
  filePath: string;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  createdAt: number;
  downloadUrl?: string;
  storage?: 'local' | 's3';
  bucket?: string;
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  currency?: string;
  model?: string;
  cachedPromptTokens?: number;
  platformCost?: number;
  platformPrice?: number;
  credits?: number;
  contextWindow?: number | null;
  contextRemaining?: number | null;
}

export interface SessionMeta {
  id: string;
  desiredExecution: DesiredSessionExecution;
  condition: SessionExecutionCondition;
  conditionReason?: string | null;
  title?: string;
  status?: BackendSessionStatus;
  pause_reason?: SessionPauseReason | null;
  interaction_type?: SessionInteractionType;
  blocked_reason?: string | null;
  blocked_meta?: Record<string, unknown> | null;
  isProcessing?: boolean;
  completed?: boolean;
  mode?: SessionMode;
  createdAt: number | string;
  updatedAt?: number | string;
  messageCount?: number;
  summary?: string | null;
  report?: string | null;
  artifacts?: SessionArtifact[];
  usage?: SessionUsage | null;
  coordination?: import('@/types/chat').SessionCoordination;
  workerTasks?: import('@/types/chat').WorkerTaskRecord[];
  workerResult?: import('@/types/chat').WorkerResultArtifact;
}

const isRunning = (session: SessionMeta | undefined): boolean =>
  Boolean(session && session.desiredExecution === 'running' && session.condition === 'executing');

export function isRunningSession(session: SessionMeta | undefined): boolean {
  return isRunning(session);
}

export function isBlockedSession(session: SessionMeta | undefined): boolean {
  return Boolean(session && session.condition.startsWith('waiting_'));
}

export function isPausedSession(session: SessionMeta | undefined): boolean {
  return Boolean(
    session && session.desiredExecution === 'stopped',
  );
}

export function isAwaitingUserSession(
  session: SessionMeta | undefined,
): boolean {
  return Boolean(session && session.condition === 'waiting_prerequisite' && session.blocked_reason === 'awaiting_user');
}

export function isTerminalSession(session: SessionMeta | undefined): boolean {
  return Boolean(
    session && session.condition === 'completed',
  );
}

export function canSendMessage(session: SessionMeta | undefined): boolean {
  if (!session || isRunning(session)) {
    return false;
  }

  return canAcceptSessionInput({
    desiredExecution: session.desiredExecution,
    condition: session.condition,
    conditionReason: session.conditionReason,
    status: session.status,
    pauseReason: session.pause_reason ?? null,
    blockedReason: session.blocked_reason ?? null,
  });
}

export interface SessionActions {
  canPause: boolean;
  canResume: boolean;
  canRespond: boolean;
}

export function getSessionActions(
  session: SessionMeta | undefined,
): SessionActions {
  if (!session) {
    return {
      canPause: false,
      canResume: false,
      canRespond: false,
    };
  }

  const actions = resolveSessionActions({
    desiredExecution: session.desiredExecution,
    condition: session.condition,
    conditionReason: session.conditionReason,
    status: session.status,
    pauseReason: session.pause_reason ?? null,
    interactionType: session.interaction_type ?? 'none',
    blockedReason: session.blocked_reason ?? null,
  });

  return {
    canPause: actions.showStop,
    canResume: actions.showStart,
    canRespond: false,
  };
}
