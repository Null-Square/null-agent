import { v4 as uuidv4 } from 'uuid';
import type {
  TimelineEntry,
  TimelineEntryImportance,
  TimelineEntryKind,
  TimelineEntrySource,
  TimelineEntryStatus,
} from '@null-ai/contracts';
import type { PlanItem, SessionState, StreamEvent } from '../../../domain/types';

type TimelineEntryInput = {
  sessionId: string;
  ts?: number;
  kind: TimelineEntryKind;
  status: TimelineEntryStatus;
  title: string;
  detail?: string;
  source?: TimelineEntrySource;
  replaceKey?: string;
  importance?: TimelineEntryImportance;
  relatedIds?: Record<string, string | undefined>;
  metadata?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const truncate = (value: string | undefined, limit = 180): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed;
};

const toRelatedIds = (
  input?: Record<string, string | undefined>,
): Record<string, string> | undefined => {
  if (!input) {
    return undefined;
  }
  const entries = Object.entries(input).filter((entry): entry is [string, string] => {
    const [, value] = entry;
    return typeof value === 'string' && value.trim().length > 0;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const summarizeToolArgs = (args: Record<string, unknown> | undefined): string | undefined => {
  if (!args) {
    return undefined;
  }
  if (typeof args.command === 'string' && args.command.trim().length > 0) {
    return truncate(args.command);
  }
  const preview = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return `${key}=${value}`;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return `${key}=${String(value)}`;
      }
      return key;
    })
    .join(' ');
  return truncate(preview);
};

const summarizeToolResult = (result: unknown): string | undefined => {
  if (!isRecord(result)) {
    return undefined;
  }
  const error =
    typeof result.error === 'string'
      ? result.error
      : isRecord(result.data) && typeof result.data.error === 'string'
        ? result.data.error
        : undefined;
  if (error) {
    return truncate(error);
  }
  const message =
    typeof result.message === 'string'
      ? result.message
      : isRecord(result.data) && typeof result.data.message === 'string'
        ? result.data.message
        : undefined;
  return truncate(message);
};

const isToolResultError = (result: unknown): boolean => {
  if (!isRecord(result)) {
    return false;
  }
  if (typeof result.ok === 'boolean') {
    return !result.ok;
  }
  if (typeof result.success === 'boolean') {
    return !result.success;
  }
  if (typeof result.error === 'string' && result.error.trim().length > 0) {
    return true;
  }
  if (isRecord(result.data)) {
    const data = result.data;
    if (typeof data.success === 'boolean') {
      return !data.success;
    }
    if (typeof data.error === 'string' && data.error.trim().length > 0) {
      return true;
    }
  }
  return false;
};

const describePlanStep = (session: SessionState | undefined, stepId: string): PlanItem | undefined =>
  session?.plan.find((step) => step.id === stepId);

export const buildToolTimelineReplaceKey = (toolCallId?: string, toolName?: string): string | undefined => {
  if (toolCallId && toolCallId.trim().length > 0) {
    return `tool:${toolCallId}`;
  }
  if (toolName && toolName.trim().length > 0) {
    return `tool:${toolName}`;
  }
  return undefined;
};

export const createTimelineEntry = (input: TimelineEntryInput): TimelineEntry => ({
  id:
    typeof input.replaceKey === 'string' && input.replaceKey.trim().length > 0
      ? input.replaceKey
      : uuidv4(),
  sessionId: input.sessionId,
  ts: input.ts ?? Date.now(),
  kind: input.kind,
  status: input.status,
  title: input.title,
  ...(truncate(input.detail) ? { detail: truncate(input.detail) } : {}),
  source: input.source ?? 'system',
  ...(input.replaceKey ? { replaceKey: input.replaceKey } : {}),
  importance: input.importance ?? 'medium',
  ...(toRelatedIds(input.relatedIds) ? { relatedIds: toRelatedIds(input.relatedIds) } : {}),
  ...(input.metadata ? { metadata: input.metadata } : {}),
});

const mapSessionStatusEvent = (
  sessionId: string,
  data: Extract<StreamEvent, { type: 'session.status' }>['data'],
): TimelineEntry[] => {
  switch (data.status) {
    case 'running':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'session_status',
          status: 'running',
          title: data.previousStatus === 'paused' ? 'Session resumed' : 'Session started',
          detail: typeof data.reason === 'string' ? data.reason : undefined,
          importance: 'medium',
        }),
      ];
    case 'paused':
      if (data.pause_reason === 'manual') {
        return [
          createTimelineEntry({
            sessionId,
            kind: 'session_status',
            status: 'pending',
            title: 'Session paused',
            detail: typeof data.reason === 'string' ? data.reason : undefined,
            importance: 'medium',
          }),
        ];
      }
      return [];
    case 'completed':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'session_status',
          status: 'success',
          title: 'Session completed',
          importance: 'high',
        }),
      ];
    case 'failed':
    case 'error':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'session_status',
          status: 'error',
          title: 'Session failed',
          detail: typeof data.reason === 'string' ? data.reason : undefined,
          importance: 'high',
        }),
      ];
    default:
      return [];
  }
};

export const mapStreamEventToTimelineEntries = (params: {
  sessionId: string;
  event: StreamEvent;
  session?: SessionState;
}): TimelineEntry[] => {
  const { event, sessionId, session } = params;

  switch (event.type) {
    case 'timeline_event':
    case 'token':
    case 'message':
    case 'message_start':
    case 'message_end':
    case 'tool_output':
    case 'done':
    case 'ping':
    case 'checkpoint_created':
    case 'docker_build_start':
    case 'docker_build_log':
    case 'usage.recorded':
      return [];
    case 'session.status':
      return mapSessionStatusEvent(sessionId, event.data);
    case 'task_selected':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'task_selected',
          status: 'success',
          title: 'Task selected',
          detail: event.data.title,
          importance: 'medium',
        }),
      ];
    case 'plan_update': {
      if (!Array.isArray(event.data) || event.data.length === 0) {
        return [];
      }
      const hasPlanReady = (session?.timeline ?? []).some((entry) => entry.kind === 'plan_ready');
      if (hasPlanReady) {
        return [];
      }
      return [
        createTimelineEntry({
          sessionId,
          kind: 'plan_ready',
          status: 'success',
          title: 'Plan ready',
          detail: `${event.data.length} steps queued`,
          importance: 'medium',
        }),
      ];
    }
    case 'plan_step_started': {
      const step = describePlanStep(session, event.data.stepId);
      const title = step?.title ?? event.data.stepId;
      return [
        createTimelineEntry({
          sessionId,
          kind: 'plan_step',
          status: 'running',
          title,
          detail: 'Plan step started',
          replaceKey: `plan-step:${event.data.stepId}`,
          importance: 'medium',
        }),
      ];
    }
    case 'plan_step_updated': {
      const step = describePlanStep(session, event.data.stepId);
      const title = step?.title ?? event.data.stepId;
      if (event.data.status === 'pending') {
        return [];
      }
      if (event.data.status === 'running') {
        return [
          createTimelineEntry({
            sessionId,
            kind: 'plan_step',
            status: 'running',
            title,
            detail: event.data.notes ?? event.data.lastTool,
            replaceKey: `plan-step:${event.data.stepId}`,
            importance: 'medium',
          }),
        ];
      }
      return [
        createTimelineEntry({
          sessionId,
          kind: 'plan_step',
          status: event.data.status === 'completed' ? 'success' : 'error',
          title,
          detail:
            event.data.blockedReason ??
            event.data.notes ??
            event.data.outputSnippet ??
            event.data.lastTool,
          replaceKey: `plan-step:${event.data.stepId}`,
          importance: event.data.status === 'completed' ? 'medium' : 'high',
        }),
      ];
    }
    case 'tool_started':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'tool',
          status: 'running',
          title: `Running ${event.data.name}`,
          detail: summarizeToolArgs(event.data.args),
          replaceKey: buildToolTimelineReplaceKey(event.data.toolCallId, event.data.name),
          importance: 'medium',
          metadata: { toolName: event.data.name },
        }),
      ];
    case 'tool_result': {
      const failed = isToolResultError(event.data.result);
      return [
        createTimelineEntry({
          sessionId,
          kind: 'tool',
          status: failed ? 'error' : 'success',
          title: `${failed ? 'Failed' : 'Completed'} ${event.data.name}`,
          detail: summarizeToolResult(event.data.result),
          replaceKey: buildToolTimelineReplaceKey(event.data.toolCallId, event.data.name),
          importance: failed ? 'high' : 'medium',
          metadata: { toolName: event.data.name },
        }),
      ];
    }
    case 'approval_needed':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'approval',
          status: 'pending',
          title: 'Approval required',
          detail: `Awaiting ${event.data.tool}`,
          replaceKey: `approval:${event.data.actionId}:requested`,
          importance: 'high',
        }),
      ];
    case 'approval_granted':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'approval',
          status: 'success',
          title: 'Approval granted',
          replaceKey: `approval:${event.data.actionId}:resolved`,
          importance: 'medium',
        }),
      ];
    case 'approval_denied':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'approval',
          status: 'error',
          title: 'Approval denied',
          detail: event.data.reason,
          replaceKey: `approval:${event.data.actionId}:resolved`,
          importance: 'high',
        }),
      ];
    case 'sandbox_policy':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'sandbox',
          status: 'success',
          title: 'Sandbox ready',
          detail: event.data.profile,
          importance: 'medium',
        }),
      ];
    case 'checkpoint_restored':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'checkpoint',
          status: 'success',
          title: 'Checkpoint restored',
          detail: event.data.id,
          importance: 'high',
        }),
      ];
    case 'docker_build_end':
      return event.data.status === 'failed'
        ? [
            createTimelineEntry({
              sessionId,
              kind: 'docker',
              status: 'error',
              title: 'Docker build failed',
              detail: event.data.error,
              replaceKey: `docker-build:${event.data.profileId}`,
              importance: 'high',
            }),
          ]
        : [];
    case 'warning':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'warning',
          status: 'error',
          title: 'Warning',
          detail: event.data.message,
          replaceKey: `warning:${event.data.code}`,
          importance: 'high',
          metadata: { code: event.data.code },
        }),
      ];
    case 'deadlock':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'warning',
          status: 'error',
          title: 'Execution deadlock detected',
          detail: event.data.message,
          replaceKey: `deadlock:${event.data.tool}`,
          importance: 'high',
          metadata: { tool: event.data.tool },
        }),
      ];
    case 'plan_warning':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'warning',
          status: 'error',
          title: 'Plan warning',
          detail: event.data.message,
          replaceKey: 'plan-warning',
          importance: 'high',
        }),
      ];
    case 'context_warning':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'context',
          status: 'error',
          title: 'Context nearing limit',
          detail: `${Math.round(event.data.percentUsed)}% of context window used`,
          replaceKey: 'context-warning',
          importance: 'high',
        }),
      ];
    case 'context_compacted':
      {
        const categoryCounts = [
          ['findings', event.data.findingsPreserved],
          ['techniques', event.data.techniquesPreserved],
          ['discoveries', event.data.discoveriesPreserved],
        ].filter(([, count]) => Number(count) > 0);
        const categoryDetail = categoryCounts.length > 0
          ? `; ${categoryCounts.map(([label, count]) => `${label}=${count}`).join(' ')}`
          : '';
      return [
        createTimelineEntry({
          sessionId,
          kind: 'context',
          status: 'success',
          title: 'Context compacted',
          detail: `${event.data.messagesSummarized} messages summarized${categoryDetail}`,
          importance: 'medium',
        }),
      ];
      }
    case 'context_trimmed':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'context',
          status: 'error',
          title: 'Context trimmed',
          detail: `${event.data.droppedMessages} messages dropped`,
          importance: 'high',
        }),
      ];
    case 'credits_low':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'credits',
          status: 'pending',
          title: 'Credits running low',
          detail: `${Math.round(event.data.percentRemaining)}% remaining`,
          replaceKey: 'credits-low',
          importance: 'high',
        }),
      ];
    case 'credits_exhausted':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'credits',
          status: 'error',
          title: 'Credits exhausted',
          detail: 'Session paused until credits reset or subscription changes',
          replaceKey: 'credits-exhausted',
          importance: 'high',
        }),
      ];
    case 'token_limit_exceeded':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'credits',
          status: 'error',
          title: 'Token limit reached',
          detail: event.data.message,
          replaceKey: `token-limit:${event.data.limitType}`,
          importance: 'high',
        }),
      ];
    case 'aborted':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'session_status',
          status: 'error',
          title: 'Session aborted',
          detail: event.data.reason,
          importance: 'high',
        }),
      ];
    case 'error':
      return [
        createTimelineEntry({
          sessionId,
          kind: 'warning',
          status: 'error',
          title: 'Session error',
          detail: event.data.message,
          importance: 'high',
          metadata: { code: event.data.code },
        }),
      ];
    default:
      return [];
  }
};
