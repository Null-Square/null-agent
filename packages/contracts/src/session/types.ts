/**
 * Session Status Types
 * 
 * Canonical session status values used by the backend and the frontend.
 * These are the display-friendly statuses derived from DB fields.
 */

/**
 * Display-friendly session status.
 * Derived from DB fields: blocked_reason, isProcessing, pendingApproval, completed.
 *
 * Primary execution state is intentionally small. Pause semantics live in
 * `SessionPauseReason` and `SessionInteractionType`.
 */
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'error';

/**
 * Valid session status values as a const array (useful for validation)
 */
export const SESSION_STATUSES = [
  'idle',
  'running',
  'paused',
  'completed',
  'failed',
  'error',
] as const;

/** Durable user intent. Operational failures never change this value. */
export type DesiredSessionExecution = 'running' | 'stopped';

export const DESIRED_SESSION_EXECUTIONS = ['running', 'stopped'] as const;

/**
 * Read-only observation of a session's current execution position.
 * This is presentation data, never a continuation or recovery gate.
 */
export type SessionExecutionCondition =
  | 'executing'
  | 'waiting_approval'
  | 'waiting_credits'
  | 'waiting_runner'
  | 'waiting_prerequisite'
  | 'recovering'
  | 'completed'
  | 'idle';

export const SESSION_EXECUTION_CONDITIONS = [
  'executing',
  'waiting_approval',
  'waiting_credits',
  'waiting_runner',
  'waiting_prerequisite',
  'recovering',
  'completed',
  'idle',
] as const;

export interface SessionExecutionReadModel {
  desiredExecution: DesiredSessionExecution;
  condition: SessionExecutionCondition;
  /** Safe diagnostic/presentation code. It must never drive recovery or actions. */
  conditionReason?: string | null;
}

/**
 * Why a paused session is blocked.
 */
export type SessionPauseReason = 'manual' | 'approval' | 'credits' | 'runner' | 'system';

export const SESSION_PAUSE_REASONS = [
  'manual',
  'approval',
  'credits',
  'runner',
  'system',
] as const;

/**
 * Which semantic interaction the UI should surface.
 */
export type SessionInteractionType = 'none';

export const SESSION_INTERACTION_TYPES = [
  'none',
] as const;

/**
 * Blocked reason values stored in DB.
 * These take priority when deriving status.
 */
export type BlockedReason =
  | 'credits_exhausted'
  | 'user_paused'
  | 'awaiting_approval'
  | 'guard_exhausted'
  | 'aborted_by_user'
  | 'runner_unavailable'
  | 'system_paused'
  | 'error'
  | string; // Allow custom reasons

export const SYSTEM_PAUSED_BLOCKED_REASON = 'system_paused' as const;

export const SYSTEM_PAUSE_CAUSE_CODES = [
  'closeout_pending',
  'recovery_retry',
  'worker_interrupted',
] as const;

export type SystemPauseCauseCode = (typeof SYSTEM_PAUSE_CAUSE_CODES)[number];

/**
 * Known blocked reason values
 */
export const BLOCKED_REASONS = [
  'credits_exhausted',
  'user_paused',
  'awaiting_approval',
  'guard_exhausted',
  'aborted_by_user',
  'runner_unavailable',
  SYSTEM_PAUSED_BLOCKED_REASON,
  'error',
] as const;

export interface DerivedSessionState {
  status: SessionStatus;
  pauseReason: SessionPauseReason | null;
  interactionType: SessionInteractionType;
  blockedReason: string | null;
}

/**
 * Input for deriveStatus function.
 * Matches the canonical state model from DB/API.
 */
export interface DeriveStatusInput {
  /** Durable block reason from DB */
  blockedReason?: string | null;
  /** True when API call or tool execution is in progress */
  isProcessing?: boolean;
  /** Set when a tool is waiting on explicit operator approval */
  pendingApproval?: { toolCallId: string } | null;
  /** True when session has completed successfully with report.md */
  completed?: boolean;
}
