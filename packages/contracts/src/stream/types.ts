/**
 * SSE Stream Event Types
 *
 * Single source of truth for Server-Sent Event types: the backend emits
 * them and the frontend consumes them.
 */

import { z } from 'zod';

// =============================================================================
// SSE Event Types
// =============================================================================

/**
 * All possible SSE event types emitted by the backend.
 */
export const SSE_EVENT_TYPES = [
  // Message streaming
  'token',              // Text delta during generation
  'message',            // Full message object
  'message_start',      // Assistant message begins
  'message_end',        // Assistant message complete

  // Turn lifecycle
  'done',               // Turn complete
  'error',              // Error occurred
  'aborted',            // Turn aborted
  'ping',               // Heartbeat

  // Tool execution
  'tool_started',       // Tool execution began
  'tool_output',        // Tool output chunk (streaming)
  'tool_result',        // Tool execution result

  // Approval flow
  'approval_needed',    // Need user approval
  'approval_granted',   // Approval given
  'approval_denied',    // Approval rejected

  // Context management
  'context_estimate',   // CTX bar update (before each LLM call)
  'context_warning',    // 80% threshold reached
  'context_compacted',  // Older messages summarized
  'context_trimmed',    // Messages dropped (overflow)

  // Plan tracking
  'plan_update',        // Plan list update
  'plan_step_started',  // Plan step began
  'plan_step_updated',  // Plan step changed
  'plan_updated',       // Plan modified
  'plan_warning',       // Plan conflict detected

  // Session events
  'session.status',     // FSM status change (dot notation)
  'session_status',     // Status update (legacy alias)
  'sandbox_policy',     // Sandbox provisioned
  'task_selected',      // Task chosen
  'timeline_event',     // Normalized mission timeline event

  // Credits & limits
  'credits_exhausted',  // Out of credits
  'credits_low',        // Low credits warning
  'token_limit_exceeded', // Per-session/daily limit

  // Checkpoint events
  'checkpoint_created', // Snapshot created
  'checkpoint_restored', // Snapshot restored

  // Docker events
  'docker_build_start', // Docker build begins
  'docker_build_log',   // Docker build output
  'docker_build_end',   // Docker build complete

  // Warnings
  'warning',            // Generic warning
  'deadlock',           // Tool deadlock detected

  // Usage tracking
  'usage_recorded',     // Token usage recorded
] as const;

export const sseEventTypeSchema = z.enum(SSE_EVENT_TYPES);
export type SSEEventType = z.infer<typeof sseEventTypeSchema>;

/**
 * SSE event constants object for named property access.
 * Used by frontend for `SSE_EVENTS.TOKEN` style references.
 */
export const SSE_EVENTS = {
  // Streaming events
  TOKEN: 'token',
  MESSAGE: 'message',
  MESSAGE_START: 'message_start',
  MESSAGE_END: 'message_end',

  // Turn lifecycle
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
  PING: 'ping',

  // Tool execution
  TOOL_STARTED: 'tool_started',
  TOOL_OUTPUT: 'tool_output',
  TOOL_RESULT: 'tool_result',
  TOOL_STREAM: 'tool_stream',    // Legacy alias
  TOOL_ENDED: 'tool_ended',      // Legacy alias
  TOOL_COMPLETED: 'tool_completed', // Legacy alias for tool_result

  // Approval events
  APPROVAL_NEEDED: 'approval_needed',
  APPROVAL_GRANTED: 'approval_granted',
  APPROVAL_DENIED: 'approval_denied',

  // Plan events
  PLAN_UPDATE: 'plan_update',
  PLAN_STEP_STARTED: 'plan_step_started',
  PLAN_STEP_UPDATED: 'plan_step_updated',
  PLAN_STEP_ENDED: 'plan_step_ended',       // Legacy alias
  PLAN_STEP_COMPLETED: 'plan_step_completed', // Legacy alias
  PLAN_UPDATED: 'plan_updated',
  PLAN_WARNING: 'plan_warning',

  // Context management
  CONTEXT_ESTIMATE: 'context_estimate',
  CONTEXT_WARNING: 'context_warning',
  CONTEXT_COMPACTED: 'context_compacted',
  CONTEXT_TRIMMED: 'context_trimmed',

  // Session events
  SESSION_FSM_STATUS: 'session.status',
  SESSION_STATUS: 'session_status',
  SANDBOX_POLICY: 'sandbox_policy',
  TASK_SELECTED: 'task_selected',
  TIMELINE_EVENT: 'timeline_event',

  // Credits & limits
  CREDITS_EXHAUSTED: 'credits_exhausted',
  CREDITS_LOW: 'credits_low',
  TOKEN_LIMIT_EXCEEDED: 'token_limit_exceeded',

  // Checkpoint events
  CHECKPOINT_CREATED: 'checkpoint_created',
  CHECKPOINT_RESTORED: 'checkpoint_restored',

  // Docker events
  DOCKER_BUILD_START: 'docker_build_start',
  DOCKER_BUILD_LOG: 'docker_build_log',
  DOCKER_BUILD_END: 'docker_build_end',

  // Warnings
  WARNING: 'warning',
  DEADLOCK: 'deadlock',

  // Usage events
  USAGE_RECORDED: 'usage_recorded',
} as const;

// =============================================================================
// Event Payloads
// =============================================================================

/**
 * Token event - text delta during streaming
 */
export interface TokenEvent {
  type: 'token';
  data: {
    delta: string;
  };
}

/**
 * Message start/end events
 */
export interface MessageStartEvent {
  type: 'message_start';
  data: {
    messageId: string;
  };
}

export interface MessageEndEvent {
  type: 'message_end';
  data: {
    messageId: string;
  };
}

/**
 * Done event - turn complete
 */
export interface DoneEvent {
  type: 'done';
  data?: {
    reason?: string;
  };
}

/**
 * Error event
 */
export interface ErrorEvent {
  type: 'error';
  data: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

/**
 * Tool events
 */
export interface ToolStartedEvent {
  type: 'tool_started';
  data: {
    name: string;
    args: Record<string, unknown>;
    toolCallId?: string;
  };
}

export interface ToolCompletedEvent {
  type: 'tool_completed';
  data: {
    toolCallId: string;
    name: string;
    success: boolean;
    output?: string;
    error?: string;
  };
}

/**
 * Approval events
 */
export interface ApprovalRequiredEvent {
  type: 'approval_needed';
  data: {
    actionId: string;
    tool: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    preview?: {
      cmd?: string;
      path?: string;
      diff?: string;
      risk?: string[];
    };
    expiresAt?: string;
    requestedAt?: number;
    reason?: string;
  };
}

export interface ApprovalGrantedEvent {
  type: 'approval_granted';
  data: {
    actionId: string;
  };
}

/**
 * Context management events - aligned with backend StreamEvent payloads
 */
export interface ContextEstimateEvent {
  type: 'context_estimate';
  data: {
    estimatedTokens: number;
    contextWindow: number;
    maxHistoryTokens: number;
    percentUsed: number;
  };
}

export interface ContextWarningEvent {
  type: 'context_warning';
  data: {
    percentUsed: number;
    estimatedTokens: number;
    contextWindow: number;
  };
}

export interface ContextCompactedEvent {
  type: 'context_compacted';
  data: {
    beforeTokens: number;
    afterTokens: number;
    messagesSummarized: number;
    compactionVersion: number;
  };
}

export interface ContextTrimmedEvent {
  type: 'context_trimmed';
  data: {
    droppedMessages: number;
    keptMessages: number;
    usedTokens: number;
    tokenBudget: number;
    percentUsed: number;
  };
}

/**
 * Credits & limit events - aligned with backend StreamEvent payloads
 */
export interface CreditsExhaustedEvent {
  type: 'credits_exhausted';
  data: {
    sessionId: string;
    creditsRemaining: number;
    periodResetAt: number;
    planSlug: string;
    upgradeUrl: string;
  };
}

export interface CreditsLowEvent {
  type: 'credits_low';
  data: {
    sessionId: string;
    creditsRemaining: number;
    percentRemaining: number;
    periodResetAt: number;
  };
}

export interface TokenLimitExceededEvent {
  type: 'token_limit_exceeded';
  data: {
    sessionId: string;
    limitType: 'session' | 'daily';
    currentUsage: number;
    limit: number;
    usagePct: number;
    message?: string;
  };
}

/**
 * Session FSM status change event
 */
export interface SessionStatusEvent {
  type: 'session.status';
  data: {
    id: string;
    status: string;
    previousStatus: string;
    blocked_reason?: string | null;
    pause_reason?: 'manual' | 'approval' | 'credits' | 'runner' | null;
    interaction_type?: 'none';
    reason?: string;
    version: number;
    updatedAt: number;
    turnId?: string;
    mode?: 'interactive' | 'automated';
  };
}

export const TIMELINE_ENTRY_STATUSES = [
  'pending',
  'running',
  'success',
  'error',
  'info',
] as const;

export const TIMELINE_ENTRY_IMPORTANCE = ['low', 'medium', 'high'] as const;

export const TIMELINE_ENTRY_SOURCES = ['system', 'securityops', 'artifact'] as const;

export const TIMELINE_ENTRY_KINDS = [
  'session_status',
  'task_selected',
  'plan_ready',
  'plan_step',
  'tool',
  'approval',
  'sandbox',
  'checkpoint',
  'warning',
  'context',
  'credits',
  'docker',
  'artifact',
  'securityops',
] as const;

export const timelineEntryStatusSchema = z.enum(TIMELINE_ENTRY_STATUSES);
export const timelineEntryImportanceSchema = z.enum(TIMELINE_ENTRY_IMPORTANCE);
export const timelineEntrySourceSchema = z.enum(TIMELINE_ENTRY_SOURCES);
export const timelineEntryKindSchema = z.enum(TIMELINE_ENTRY_KINDS);

export const timelineEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number(),
  kind: timelineEntryKindSchema,
  status: timelineEntryStatusSchema,
  title: z.string(),
  detail: z.string().optional(),
  source: timelineEntrySourceSchema,
  replaceKey: z.string().optional(),
  importance: timelineEntryImportanceSchema,
  relatedIds: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type TimelineEntryStatus = z.infer<typeof timelineEntryStatusSchema>;
export type TimelineEntryImportance = z.infer<typeof timelineEntryImportanceSchema>;
export type TimelineEntrySource = z.infer<typeof timelineEntrySourceSchema>;
export type TimelineEntryKind = z.infer<typeof timelineEntryKindSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export interface TimelineEvent {
  type: 'timeline_event';
  data: TimelineEntry;
}

/**
 * Aborted event - turn was aborted
 */
export interface AbortedEvent {
  type: 'aborted';
  data: {
    reason?: string;
  };
}

/**
 * Checkpoint events
 */
export interface CheckpointCreatedEvent {
  type: 'checkpoint_created';
  data: {
    id: string;
    ts: string;
    filesCount: number;
    sizeBytes: number;
  };
}

// =============================================================================
// Union Type
// =============================================================================

/**
 * Union of all SSE event types for type-safe handling
 */
export type SSEEvent =
  | TokenEvent
  | MessageStartEvent
  | MessageEndEvent
  | DoneEvent
  | ErrorEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalRequiredEvent
  | ApprovalGrantedEvent
  | ContextEstimateEvent
  | ContextWarningEvent
  | ContextCompactedEvent
  | ContextTrimmedEvent
  | CreditsExhaustedEvent
  | CreditsLowEvent
  | TokenLimitExceededEvent
  | SessionStatusEvent
  | TimelineEvent
  | AbortedEvent
  | CheckpointCreatedEvent
  | { type: SSEEventType; data?: unknown }; // Fallback for other events

// =============================================================================
// Live data events
// =============================================================================

/**
 * "Something you are looking at changed" signals, pushed to every browser tab
 * watching an organization so lists refresh without a manual page reload.
 *
 * These are deliberately COARSE — one kind per resource family, never one per
 * mutation — because the browser answers each by invalidating a query and
 * refetching through the ordinary API. The event carries no row the client
 * keeps, so a dropped one costs a stale panel until the next event, never a
 * lost write or a wrong cache.
 *
 * Declared here rather than in either service because both ends must agree on
 * the exact strings, and a drifted kind fails silently: the client ignores
 * kinds it does not recognise (which is what makes version skew safe), so a
 * typo would simply stop refreshing with nothing in any log.
 */
export const LIVE_EVENT_KINDS = [
  'risk.created',
  'asset.discovered',
  'run.created',
  'run.changed',
] as const;

export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];

export const liveEventSchema = z.object({
  kind: z.enum(LIVE_EVENT_KINDS),
  /** Narrows the refetch where the client keys a query by scope. */
  scopeId: z.string().nullish(),
  /** Present on run events so a detail page can ignore other runs. */
  runId: z.string().nullish(),
});

export type LiveEvent = z.infer<typeof liveEventSchema>;
