/**
 * SessionResolverService
 *
 * Canonical backend authority for runtime session state resolution.
 * It resolves blocked reasons, interaction markers, recent activity,
 * and final display state from durable rows plus optional live session state.
 */

import { deriveSessionState } from '@null-ai/contracts';
import type { SessionRowDTO } from '@/shared/types/dtos';

const RECENT_ACTIVITY_WINDOW_MS = 60_000;
const LIVE_PROCESSING_STALE_BLOCK_REASONS = new Set(['user_paused', 'system_paused']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isRetryBlockedReason = (reason: string | null): boolean =>
  Boolean(reason?.startsWith('error_retry:') || reason?.startsWith('guard_retry:'));
const normalizeTimestampValue = (value?: Date | number | string | null): number | null => {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    // If less than 1 trillion, assume seconds; otherwise milliseconds
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};
const resolveBlockedReasonValue = (
  session: Partial<SessionRowDTO> | null,
  liveSession?: LiveSessionState,
  metadata?: Record<string, unknown>,
): string | null => {
  const fromRow = session?.blockedReason ?? null;
  const fromLive = liveSession?.blockedReason ?? liveSession?.flags?.blocked_reason ?? null;
  const fromMeta = (metadata as Record<string, Record<string, unknown>>)?.flags?.blocked_reason ?? null;
  return (fromRow ?? fromLive ?? fromMeta ?? null) as string | null;
};
const resolvePendingApprovalValue = (
  liveSession?: LiveSessionState,
  metadata?: Record<string, unknown> | null,
): PendingApprovalRef | null => {
  const livePending = liveSession?.pendingApproval;
  const liveToolCallId =
    isRecord(livePending)
      ? (typeof livePending.toolCallId === 'string' && livePending.toolCallId.trim()
        ? livePending.toolCallId
        : typeof livePending.actionId === 'string' && livePending.actionId.trim()
          ? livePending.actionId
          : null)
      : null;
  if (liveToolCallId) {
    return { toolCallId: liveToolCallId };
  }

  const persistedPending = isRecord(metadata?.pendingApproval) ? metadata?.pendingApproval : null;
  const persistedToolCallId =
    persistedPending
      ? (typeof persistedPending.toolCallId === 'string' && persistedPending.toolCallId.trim()
        ? persistedPending.toolCallId
        : typeof persistedPending.actionId === 'string' && persistedPending.actionId.trim()
          ? persistedPending.actionId
          : null)
      : null;
  if (persistedToolCallId) {
    return { toolCallId: persistedToolCallId };
  }

  return null;
};
const resolveCompletedValue = (
  session: Partial<SessionRowDTO> | null,
  liveSession?: LiveSessionState,
): boolean =>
  Boolean(
    session?.completed === true ||
    liveSession?.completed === true ||
    (isRecord(liveSession?.flags?.session) && liveSession?.flags?.session?.completed === true),
  );
const resolveIsProcessingValue = (
  session: Partial<SessionRowDTO> | null,
  liveSession?: LiveSessionState,
  nowMs: number = Date.now(),
): boolean => {
  if (liveSession?.stateMachine) {
    return liveSession.stateMachine.isProcessing();
  }

  const lastActiveMs =
    normalizeTimestampValue(liveSession?.lastActive) ??
    normalizeTimestampValue(session?.lastActiveAt);
  if (lastActiveMs === null) {
    return false;
  }

  return nowMs - lastActiveMs <= RECENT_ACTIVITY_WINDOW_MS;
};

/** Represents in-memory session state from SessionStore */
export interface LiveSessionState {
  stateMachine?: {
    isProcessing: () => boolean;
  };
  lastActive?: Date | number | string | null;
  blockedReason?: string;
  completed?: boolean;
  pendingApproval?: {
    toolCallId?: string;
    actionId?: string;
  } | null;
  flags?: Record<string, unknown>;
  usage?: {
    model?: string;
  };
  modelName?: string;
  sandboxImage?: string;
  sandboxProfile?: string;
  containerId?: string;
}

/** Session sandbox information */
export interface SandboxInfo {
  image: string | null;
  profile: string | null;
  containerId: string | null;
}

export type PendingApprovalRef = { toolCallId: string };

export type DerivedRuntimeState = ReturnType<typeof deriveSessionState> & {
  blockedReason: string | null;
  completed: boolean;
  isProcessing: boolean;
  pendingApproval: PendingApprovalRef | null;
};

export interface RuntimeStateInput {
  session?: Partial<SessionRowDTO> | null;
  liveSession?: LiveSessionState;
  metadata?: Record<string, unknown> | null;
  blockedReason?: string | null;
  completed?: boolean;
  isProcessing?: boolean;
  pendingApproval?: PendingApprovalRef | null;
  nowMs?: number;
}

/**
 * Service for resolving session state from multiple data sources.
 * Combines data from DB row, live session state, and metadata.
 */
export class SessionResolverService {
  /**
   * Normalize a timestamp value to milliseconds.
   * Handles Date objects, seconds, milliseconds, and ISO strings.
   */
  normalizeTimestamp(value?: Date | number | string | null): number | null {
    return normalizeTimestampValue(value);
  }

  /**
   * Determine if a session is currently processing.
   * Uses live session stateMachine first, then falls back to recent activity.
   */
  resolveIsProcessing(
    session: Partial<SessionRowDTO> | null,
    liveSession?: LiveSessionState,
    nowMs: number = Date.now(),
  ): boolean {
    return resolveIsProcessingValue(session, liveSession, nowMs);
  }

  /**
   * Resolve the blocked reason from multiple sources.
   * Priority: DB row > live session > metadata flags
   */
  resolveBlockedReason(
    session: Partial<SessionRowDTO> | null,
    liveSession?: LiveSessionState,
    metadata?: Record<string, unknown>,
  ): string | null {
    return resolveBlockedReasonValue(session, liveSession, metadata);
  }

  resolvePendingApproval(
    liveSession?: LiveSessionState,
    metadata?: Record<string, unknown> | null,
  ): PendingApprovalRef | null {
    return resolvePendingApprovalValue(liveSession, metadata);
  }

  resolveCompleted(
    session: Partial<SessionRowDTO> | null,
    liveSession?: LiveSessionState,
  ): boolean {
    return resolveCompletedValue(session, liveSession);
  }

  deriveRuntimeState(input: RuntimeStateInput): DerivedRuntimeState {
    const session = input.session ?? null;
    const metadata = input.metadata ?? (isRecord(session?.metadata) ? session.metadata : null);
    const rawBlockedReason =
      input.blockedReason !== undefined
        ? input.blockedReason
        : resolveBlockedReasonValue(session, input.liveSession, metadata ?? undefined);
    const pendingApproval =
      input.pendingApproval !== undefined
        ? input.pendingApproval
        : resolvePendingApprovalValue(input.liveSession, metadata);
    const completed =
      input.completed !== undefined
        ? input.completed
        : resolveCompletedValue(session, input.liveSession);
    const rawIsProcessing =
      input.isProcessing !== undefined
        ? input.isProcessing
        : resolveIsProcessingValue(session, input.liveSession, input.nowMs);
    const liveStateMachineProcessing = input.liveSession?.stateMachine?.isProcessing() === true;
    const explicitlyProcessing = input.isProcessing === true || liveStateMachineProcessing;
    const blockedReason =
      explicitlyProcessing &&
      rawBlockedReason &&
      LIVE_PROCESSING_STALE_BLOCK_REASONS.has(rawBlockedReason)
        ? null
        : rawBlockedReason;
    const isProcessing =
      completed || (blockedReason && !isRetryBlockedReason(blockedReason))
        ? false
        : rawIsProcessing;

    const derived = deriveSessionState({
      blockedReason: blockedReason ?? undefined,
      isProcessing,
      pendingApproval,
      completed,
    });

    return {
      ...derived,
      blockedReason: derived.blockedReason,
      completed,
      isProcessing,
      pendingApproval,
    };
  }

  /**
   * Resolve the model name used in the session.
   * Prioritizes stored metadata, then live session hints.
   */
  resolveModelName(
    metadata?: Record<string, unknown>,
    liveSession?: LiveSessionState,
  ): string | undefined {
    const modelName = (metadata as Record<string, unknown>)?.modelName;
    if (typeof modelName === 'string' && modelName.trim()) {
      return modelName;
    }
    const flags = (metadata as Record<string, unknown>)?.flags as Record<string, unknown> | undefined;
    const tokenTotals = flags?.token_usage_totals as Record<string, unknown> | undefined;
    const flaggedModel = tokenTotals?.model;
    if (typeof flaggedModel === 'string' && flaggedModel.trim()) {
      return flaggedModel;
    }
    const liveModel = liveSession?.modelName ?? liveSession?.usage?.model;
    if (typeof liveModel === 'string' && liveModel.trim()) {
      return liveModel;
    }
    return undefined;
  }

  /**
   * Resolve sandbox configuration for a session.
   * Combines data from metadata and live session state.
   */
  resolveSandbox(
    metadata?: Record<string, unknown>,
    liveSession?: LiveSessionState,
  ): SandboxInfo {
    return {
      image: ((metadata as Record<string, string>)?.sandboxImage ?? liveSession?.sandboxImage ?? null),
      profile: ((metadata as Record<string, string>)?.sandboxProfile ?? liveSession?.sandboxProfile ?? null),
      containerId: (liveSession?.containerId ?? null),
    };
  }
}

/** Singleton instance for convenience */
export const sessionResolverService = new SessionResolverService();
