import type { Message, PlanItem } from '../types';

export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;

export const SESSION_EVENT_TYPES = [
  'session.created',
  'session.start_requested',
  'session.stop_requested',
  'session.completed',
  'legacy.session_imported',
  'input.accepted',
  'turn.started',
  'message.accepted',
  'model.response.accepted',
  'tool.requested',
  'tool.outcome_attached',
  'approval.requested',
  'approval.decided',
  'plan.changed',
  'compaction.applied',
  'execution.deferred',
  'closeout.requested',
  'closeout.completed',
  'turn.interrupted',
  'turn.completed',
  'session.recovery_rebased',
  'session.data_loss_detected',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];
export type DesiredSessionExecution = 'running' | 'stopped';
export type SessionToolOutcome = 'succeeded' | 'failed' | 'blocked' | 'outcome_unknown';

export interface SessionEventPayloadMap {
  'session.created': {
    modelName: string;
    mode: 'interactive' | 'automated';
    desiredExecution?: DesiredSessionExecution;
  };
  'session.start_requested': {
    reason?: string;
    requestedBy?: string;
  };
  'session.stop_requested': {
    reason?: string;
    requestedBy?: string;
  };
  'session.completed': {
    reason: string;
  };
  'legacy.session_imported': {
    desiredExecution: DesiredSessionExecution;
    messages: Message[];
    turn?: number;
    source: string;
  };
  'input.accepted': {
    message: Message;
  };
  'turn.started': {
    turnId: string;
    turnNumber: number;
    inputMessageIds?: string[];
  };
  'message.accepted': {
    message: Message;
    turnId?: string;
  };
  'model.response.accepted': {
    turnId: string;
    modelRequestId: string;
    message: Message;
  };
  'tool.requested': {
    turnId: string;
    toolCallId: string;
    toolName: string;
    modelRequestId?: string;
    arguments?: string;
  };
  'tool.outcome_attached': {
    turnId: string;
    toolCallId: string;
    outcome: SessionToolOutcome;
    toolExecutionId?: string;
    message: Message;
    repair?: boolean;
  };
  'approval.requested': {
    turnId: string;
    toolCallId: string;
    actionId: string;
  };
  'approval.decided': {
    actionId: string;
    decision: 'granted' | 'denied';
    reason?: string;
  };
  'plan.changed': {
    plan: PlanItem[];
  };
  'compaction.applied': {
    transactionId: string;
    throughMessageId: string;
    summaryMessage: Message;
  };
  'execution.deferred': {
    reason: string;
    retryAt?: string;
  };
  'closeout.requested': {
    reason: string;
  };
  'closeout.completed': {
    reason?: string;
  };
  'turn.interrupted': {
    turnId: string;
    reason: string;
    source: 'user_stop' | 'recovery' | 'runtime';
  };
  'turn.completed': {
    turnId: string;
    reason?: string;
  };
  'session.recovery_rebased': {
    recoverableThroughSequence: number;
    abandonedThroughSequence: number;
    reason: string;
    desiredExecution?: DesiredSessionExecution;
  };
  'session.data_loss_detected': {
    kind: 'sequence_gap' | 'invalid_event' | 'missing_projection' | 'missing_native_session';
    detail: string;
    recoverableThroughSequence?: number;
  };
}

export type SessionEventPayload<T extends SessionEventType = SessionEventType> =
  SessionEventPayloadMap[T];

export interface SessionEventDraft<T extends SessionEventType = SessionEventType> {
  eventId: string;
  eventType: T;
  schemaVersion?: number;
  payload: SessionEventPayloadMap[T];
  causationEventId?: string;
  correlationId?: string;
  createdAt?: Date;
}

export interface SessionEventProposal<T extends SessionEventType = SessionEventType> {
  eventType: T;
  schemaVersion?: number;
  payload: SessionEventPayloadMap[T];
  causationEventId?: string;
  correlationId?: string;
  createdAt?: Date;
}

export interface SessionEventRecord<T extends SessionEventType = SessionEventType>
  extends SessionEventDraft<T> {
  sessionId: string;
  sequence: number;
  schemaVersion: number;
  createdAt: Date;
}

export const isSessionEventType = (value: unknown): value is SessionEventType =>
  typeof value === 'string' && (SESSION_EVENT_TYPES as readonly string[]).includes(value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isMessage = (value: unknown): value is Message => {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant' || value.role === 'tool')
    && typeof value.content === 'string'
    && typeof value.timestamp === 'number';
};
