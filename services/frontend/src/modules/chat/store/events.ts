import type { PlanItemStatus, TimelineEntry, ToolStreamState } from '@/types/chat';
import {
  activityActions,
  planActions,
  sessionActions,
  toolActions,
  taskActions,
  configActions,
} from './actions';
import type { RootAction } from './types';
import {
  normalizePlanItems,
  normalizePlanStatus,
  normalizeStringArray,
  normalizeSandboxPolicy,
  toNumber,
} from './normalizers';
import type { ApprovalRequest, TaskSummary } from '@/types/chat';

type PlanStepUpdatedEvent = {
  stepId?: string;
  status?: PlanItemStatus | string;
  notes?: string;
  outputSnippet?: string;
  lastTool?: string;
  artifactLinks?: unknown;
  checkpointId?: string;
  blockedReason?: string;
  startedAt?: unknown;
  completedAt?: unknown;
};

type ToolStartedEvent = {
  name?: string;
  args?: Record<string, unknown>;
  toolCallId?: string;
};

type ToolOutputEvent = {
  name?: string;
  chunk?: string;
};

type ToolResultEvent = {
  name?: string;
  result?: unknown;
  toolCallId?: string;
};

export const planUpdateFromServer = (
  items: unknown[] | undefined
): RootAction[] => {
  if (!items) {
    return [];
  }
  return [planActions.setPlan(normalizePlanItems(items))];
};

export const planTurnComplete = (): RootAction[] => [];

export const planStepStartedFromServer = (stepId?: string): RootAction[] => {
  if (!stepId) {
    return [];
  }
  return [planActions.planStepStarted(stepId)];
};

export const planStepUpdatedFromServer = (
  data: PlanStepUpdatedEvent | undefined
): RootAction[] => {
  if (!data?.stepId) {
    return [];
  }
  return [
    planActions.planStepUpdated({
      id: data.stepId,
      status:
        data.status !== undefined ? normalizePlanStatus(data.status) : undefined,
      notes: data.notes,
      outputSnippet: data.outputSnippet,
      lastTool: data.lastTool,
      artifactLinks: normalizeStringArray(data.artifactLinks),
      checkpointId: data.checkpointId,
      blockedReason: data.blockedReason,
      startedAt: toNumber(data.startedAt),
      completedAt: toNumber(data.completedAt),
    }),
  ];
};

export const toolStartedFromServer = (data: ToolStartedEvent | undefined): RootAction[] => {
  if (!data?.name) {
    return [];
  }
  const command =
    data.args && typeof data.args.command === 'string'
      ? (data.args.command as string)
      : undefined;
  return [
    sessionActions.setLoading(true),
    toolActions.resetToolStream(data.name, command),
  ];
};

export const toolOutputFromServer = (
  data: ToolOutputEvent | undefined
): RootAction[] => {
  if (!data?.name || !data.chunk) {
    return [];
  }
  return [toolActions.appendToolStream(data.name, data.chunk)];
};

export const toolResultFromServer = (
  data: ToolResultEvent | undefined
): RootAction[] => {
  if (!data?.name) {
    return [];
  }
  const result = data.result as ToolStreamState['result'] | undefined;
  const status: ToolStreamState['status'] =
    result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)
      ? 'error'
      : 'completed';
  return [toolActions.completeToolStream(data.name, status, result)];
};

export const timelineEventFromServer = (
  entry: TimelineEntry | undefined
): RootAction[] => {
  if (!entry?.id || !entry.title) {
    return [];
  }
  return [
    activityActions.pushActivity(entry),
    sessionActions.markStreamActivity(entry.ts, 'event'),
  ];
};

export const approvalNeededFromServer = (
  data: ApprovalRequest | undefined,
  _createId: () => string
): RootAction[] => (
  data
    ? [
        sessionActions.setPendingApproval(data),
        sessionActions.setSessionStatus('paused'),
        sessionActions.setPauseMeta('approval', 'none', null),
        sessionActions.setLoading(false),
      ]
    : []
);

export const approvalGrantedFromServer = (
  data: { actionId?: string } | undefined,
  _createId: () => string
): RootAction[] => (
  data
    ? [
        sessionActions.clearPendingApproval(data.actionId),
        sessionActions.setLoading(false),
      ]
    : []
);

export const approvalDeniedFromServer = (
  data: { actionId?: string } | undefined,
  _createId: () => string
): RootAction[] => (
  data
    ? [
        sessionActions.clearPendingApproval(data.actionId),
        sessionActions.setLoading(false),
      ]
    : []
);

export const taskSelectedFromServer = (
  summary: TaskSummary | undefined
): RootAction[] => (summary ? [taskActions.setTask(summary)] : []);

export const checkpointCreatedFromServer = (
  data: { id?: string } | undefined,
  _createId: () => string
): RootAction[] => (data ? [] : []);

export const checkpointRestoredFromServer = (
  data: { id?: string } | undefined,
  _createId: () => string
): RootAction[] => (data ? [] : []);

export const abortedFromServer = (): RootAction[] => [
  sessionActions.setAborting(false),
  sessionActions.setLoading(false),
];

export const doneFromServer = (): RootAction[] => [
  sessionActions.setLoading(false),
  sessionActions.setAborting(false),
];

export const errorFromServer = (): RootAction[] => [
  sessionActions.setLoading(false),
  sessionActions.setSessionStatus('error'),
];

export const sandboxPolicyFromServer = (
  data: Record<string, unknown> | undefined
): RootAction[] => {
  const policy = normalizeSandboxPolicy(data);
  return [sessionActions.setSandboxPolicy(policy)];
};


export const usageRecordedFromServer = (
  data: Record<string, unknown> | undefined
): RootAction[] => {
  if (!data) return [];
  const usage = data as Record<string, unknown>;
  const contextWindow =
    typeof usage.contextWindow === 'number' ? usage.contextWindow : undefined;
  const contextRemaining =
    typeof usage.contextRemaining === 'number' ? usage.contextRemaining : undefined;
  const snakeUsage = usage as { context_window?: number; context_remaining?: number };
  return [
    configActions.setUsage({
      contextWindow: contextWindow ?? snakeUsage.context_window,
      contextRemaining: contextRemaining ?? snakeUsage.context_remaining,
    }),
  ];
};

/** Real-time context estimate for live CTX bar updates (emitted BEFORE LLM call) */
export const contextEstimateFromServer = (
  data: { estimatedTokens?: number; contextWindow?: number; percentUsed?: number } | undefined
): RootAction[] => {
  if (!data || typeof data.estimatedTokens !== 'number') return [];
  return [
    configActions.setUsage({
      tokensUsed: data.estimatedTokens,
      contextWindow: data.contextWindow,
      contextRemaining: data.contextWindow ? Math.max(0, data.contextWindow - data.estimatedTokens) : undefined,
    }),
  ];
};
