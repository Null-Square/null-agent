import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { MilestonePhase } from '../../../infrastructure/telemetry/types';
import type { SessionState } from '../../../domain/types';
import {
  buildPrematureStopCorrectivePrompt,
  DIMINISHING_RETURNS_NUDGE,
  RECOVERABLE_GUARD_NUDGE,
} from '../../../domain/prompts';
import { shouldRequireReportForSession } from '../../../domain/workers/workerContracts';
import { checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import type { TurnRunResult, TurnRunStatus } from '../types';
import type { TurnMetricsPayload } from './TurnMetricsAccumulator';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getActivePhaseKey = (session: SessionState | undefined): string | null => {
  const securityops = isRecord(session?.flags?.securityops) ? session?.flags.securityops : undefined;
  const phaseKey = securityops?.activePhaseKey;
  return typeof phaseKey === 'string' && phaseKey.trim().length > 0
    ? phaseKey.trim().toLowerCase()
    : null;
};

export const buildPrematureStopCorrectiveMessage = (session: SessionState | undefined): string => {
  const terminal = checkSessionTerminal(session);
  return buildPrematureStopCorrectivePrompt({
    terminalKind: terminal.kind,
    isTerminal: terminal.isTerminal,
    activePhaseKey: getActivePhaseKey(session),
    requiresReport: shouldRequireReportForSession(session),
  });
};

export type ExitCheckpointReason = 'credits_exhausted' | 'max_tool_calls';

type TurnLoopSessionStore = {
  get(sessionId: string): SessionState | undefined;
  setAsync(sessionId: string, session: SessionState, reason?: string): Promise<void>;
};

type ExitCheckpointSessionStore = Pick<TurnLoopSessionStore, 'get'>;

type ExitCheckpointLogger = {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
};

export type CreateExitCheckpointInput = {
  sessionStore: ExitCheckpointSessionStore;
  checkpointManager?: {
    create: (sessionId: string) => Promise<{ id: string }>;
  };
  stream?: {
    raw: (event: 'checkpoint_created', payload: unknown) => void;
  };
  log?: ExitCheckpointLogger;
  sessionId: string;
  reason: ExitCheckpointReason;
  executedToolCalls: number;
};

export const createExitCheckpoint = async ({
  sessionStore,
  checkpointManager,
  stream,
  log,
  sessionId,
  reason,
  executedToolCalls,
}: CreateExitCheckpointInput): Promise<string | undefined> => {
  let checkpointId = sessionStore.get(sessionId)?.lastCheckpoint?.id;

  if (checkpointManager && executedToolCalls > 0) {
    try {
      const checkpoint = await checkpointManager.create(sessionId);
      checkpointId = checkpoint.id;
      log?.info(
        { sessionId, checkpointId: checkpoint.id, reason, executedToolCalls },
        '[TurnRunner] Exit workspace checkpoint created',
      );
      stream?.raw('checkpoint_created', checkpoint);
    } catch (error) {
      log?.warn(
        { err: error, sessionId, reason, executedToolCalls },
        '[TurnRunner] Failed to create exit workspace checkpoint',
      );
      checkpointId = sessionStore.get(sessionId)?.lastCheckpoint?.id;
    }
  }

  return checkpointId;
};

export type ReconcilePlanForExitReason =
  | 'credits_exhausted'
  | 'max_tool_calls'
  | 'awaiting_approval'
  | 'deadlock'
  | 'aborted';

export type ReconcilePlanForExitInput = {
  planRuntime: {
    reconcilePlanForExit: (
      sessionId: string,
      options: {
        reason: ReconcilePlanForExitReason;
        blockPending?: boolean;
        checkpointId?: string;
      },
    ) => Promise<unknown>;
  };
  sessionId: string;
  reason: ReconcilePlanForExitReason;
  blockPending?: boolean;
  checkpointId?: string;
};

export const reconcilePlanForExit = async ({
  planRuntime,
  sessionId,
  reason,
  blockPending,
  checkpointId,
}: ReconcilePlanForExitInput): Promise<void> => {
  await planRuntime.reconcilePlanForExit(sessionId, {
    reason,
    blockPending,
    checkpointId,
  });
};

export type WorkContinuationBoundary = 'model_call' | 'tool_call';

export type WorkContinuationDecision =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      source?: string;
    };

export type CheckContinuationInput = {
  workContinuationGuard?: {
    canContinue: (input: {
      sessionId: string;
      boundary: WorkContinuationBoundary;
      abortSignal?: AbortSignal;
    }) => Promise<WorkContinuationDecision | undefined>;
  };
  recorder?: Pick<SessionTraceRecorder, 'write'>;
  log?: Pick<ExitCheckpointLogger, 'warn'>;
  sessionId: string;
  turnNumber: number;
  boundary: WorkContinuationBoundary;
  abortSignal?: AbortSignal;
};

export const checkContinuation = async ({
  workContinuationGuard,
  recorder,
  log,
  sessionId,
  turnNumber,
  boundary,
  abortSignal,
}: CheckContinuationInput): Promise<WorkContinuationDecision> => {
  const decision = await workContinuationGuard?.canContinue({
    sessionId,
    boundary,
    abortSignal,
  });
  const resolved = decision ?? { ok: true as const };
  if (!resolved.ok && recorder) {
    await recorder.write(sessionId, turnNumber, {
      event: 'session.work_blocked',
      severity: 'warn',
      payload: {
        boundary,
        reason: resolved.reason,
        status: 'aborted',
        retryable: false,
        resumeAllowed: resolved.reason !== 'aborted_by_user',
        nextAction: 'resume the session if the work block has been cleared',
        source: resolved.source,
      },
      note: `Work blocked before ${boundary}: ${resolved.reason}`,
    }).catch((error) => {
      log?.warn({ err: error, sessionId, boundary }, 'Failed to record work block');
    });
  }
  return resolved;
};

export type MarkRecoverableGuardInput = {
  sessionStore: TurnLoopSessionStore;
  recorder?: Pick<SessionTraceRecorder, 'write'>;
  sessionId: string;
  turnNumber: number;
  extra?: Record<string, unknown>;
  usage?: TurnRunResult['usage'];
  toolCallCount: number;
  requestedToolCallCount: number;
  metrics: TurnMetricsPayload;
  emitTurnToolInvocationRollup: (status: TurnRunStatus) => Promise<void>;
  summarize: (
    status: TurnRunStatus,
    extra?: Record<string, unknown>,
    toolCallsOverride?: number,
  ) => void;
};

export const markRecoverableGuard = async ({
  sessionStore,
  recorder,
  sessionId,
  turnNumber,
  extra = {},
  usage,
  toolCallCount,
  requestedToolCallCount,
  metrics,
  emitTurnToolInvocationRollup,
  summarize,
}: MarkRecoverableGuardInput): Promise<TurnRunResult> => {
  const session = sessionStore.get(sessionId);
  if (session) {
    const previousRecoverableGuard = isRecord(session.flags?.recoverableGuard)
      ? session.flags.recoverableGuard
      : {};
    const previousTriggerCount =
      typeof previousRecoverableGuard.triggerCount === 'number'
        ? previousRecoverableGuard.triggerCount
        : 0;
    session.flags = {
      ...(session.flags ?? {}),
      ephemeralNudge: RECOVERABLE_GUARD_NUDGE,
      recoverableGuard: {
        nudgedAtTurn: turnNumber,
        repairTurn: turnNumber + 1,
        triggerCount: previousTriggerCount + 1,
        details: extra,
      },
    };
    session.blockedReason = undefined;
    await sessionStore.setAsync(sessionId, session, 'recoverable_guard_nudge');
  }

  if (recorder) {
    await recorder.write(sessionId, turnNumber, {
      event: 'context.recoverable_guard_nudge',
      severity: 'warn',
      payload: {
        ...extra,
        action: 'repair_nudge',
      },
      note: 'Turn yielded to a recoverable guard nudge instead of stopping the run',
    });
  }

  await emitTurnToolInvocationRollup('max_tool_calls');
  summarize('max_tool_calls', {
    reason: 'recoverable_guard_nudge',
    ...extra,
  }, toolCallCount);
  return {
    status: 'max_tool_calls',
    toolCallCount,
    toolCallsRequested: requestedToolCallCount,
    messagesLength: sessionStore.get(sessionId)?.messages.length ?? 0,
    doneEmitted: false,
    usage,
    metrics,
  };
};

export type MarkDiminishingReturnsInput = {
  sessionStore: TurnLoopSessionStore;
  recorder?: Pick<SessionTraceRecorder, 'write'>;
  sessionId: string;
  turnNumber: number;
  details: Record<string, unknown>;
  usage?: TurnRunResult['usage'];
  toolCallCount: number;
  requestedToolCallCount: number;
  metrics: TurnMetricsPayload;
  emitTurnToolInvocationRollup: (status: TurnRunStatus) => Promise<void>;
  summarize: (
    status: TurnRunStatus,
    extra?: Record<string, unknown>,
    toolCallsOverride?: number,
  ) => void;
};

export const markDiminishingReturns = async ({
  sessionStore,
  recorder,
  sessionId,
  turnNumber,
  details,
  usage,
  toolCallCount,
  requestedToolCallCount,
  metrics,
  emitTurnToolInvocationRollup,
  summarize,
}: MarkDiminishingReturnsInput): Promise<TurnRunResult> => {
  const session = sessionStore.get(sessionId);
  if (session) {
    const previousDiminishingReturns = isRecord(session.flags?.diminishingReturns)
      ? session.flags.diminishingReturns
      : {};
    const previousTriggerCount =
      typeof previousDiminishingReturns.triggerCount === 'number'
        ? previousDiminishingReturns.triggerCount
        : 0;
    session.flags = {
      ...(session.flags ?? {}),
      ephemeralNudge: DIMINISHING_RETURNS_NUDGE,
      diminishingReturns: {
        nudgedAtTurn: turnNumber,
        repairTurn: turnNumber + 1,
        triggerCount: previousTriggerCount + 1,
        details,
      },
    };
    await sessionStore.setAsync(sessionId, session, 'diminishing_returns_nudge');
  }
  if (recorder) {
    await recorder.write(sessionId, turnNumber, {
      event: 'context.diminishing_returns_nudge',
      severity: 'warn',
      payload: {
        ...details,
        action: 'repair_nudge',
      },
      note: 'Turn yielded for a diminishing-returns repair nudge',
    });
  }
  await emitTurnToolInvocationRollup('max_tool_calls');
  summarize('max_tool_calls', {
    reason: 'diminishing_returns_repair_nudge',
    ...details,
  }, toolCallCount);
  return {
    status: 'max_tool_calls',
    toolCallCount,
    toolCallsRequested: requestedToolCallCount,
    messagesLength: sessionStore.get(sessionId)?.messages.length ?? 0,
    doneEmitted: false,
    usage,
    metrics,
  };
};

export type ToolInvocationRollupInput = {
  recorder?: Pick<SessionTraceRecorder, 'write'>;
  sessionId: string;
  turnNumber: number;
  status: TurnRunStatus;
  phase: MilestonePhase;
  activePhaseKey: string | null;
  requestedToolCallCount: number;
  metrics: TurnMetricsPayload;
};

export const emitToolInvocationRollup = async ({
  recorder,
  sessionId,
  turnNumber,
  status,
  phase,
  activePhaseKey,
  requestedToolCallCount,
  metrics,
}: ToolInvocationRollupInput): Promise<void> => {
  if (!recorder) {
    return;
  }
  if (metrics.tools.length === 0 && metrics.skippedToolCalls === 0) {
    return;
  }

  const toolCounts: Record<string, {
    calls: number;
    success: number;
    failure: number;
    blocked: number;
    durationMs: number;
  }> = {};
  for (const tool of metrics.tools) {
    const current = toolCounts[tool.name] ?? {
      calls: 0,
      success: 0,
      failure: 0,
      blocked: 0,
      durationMs: 0,
    };
    current.calls += 1;
    current.durationMs += tool.durationMs;
    if (tool.outcome === 'blocked') {
      current.blocked += 1;
    } else if (tool.success) {
      current.success += 1;
    } else {
      current.failure += 1;
    }
    toolCounts[tool.name] = current;
  }

  await recorder.write(sessionId, turnNumber, {
    event: 'phase.tool_invocation_rollup',
    severity: 'info',
    payload: {
      phase,
      activePhaseKey,
      status,
      turn: turnNumber,
      llmCallCount: metrics.llmCallCount,
      requestedToolCalls: requestedToolCallCount,
      executedToolCalls: metrics.tools.length,
      skippedToolCalls: metrics.skippedToolCalls,
      successCount: metrics.tools.filter((tool) => tool.success).length,
      failureCount: metrics.tools.filter((tool) => tool.outcome !== 'blocked' && !tool.success).length,
      blockedCount: metrics.tools.filter((tool) => tool.outcome === 'blocked').length,
      totalToolLatencyMs: metrics.totalToolLatencyMs,
      tools: Object.entries(toolCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, rollup]) => ({
          name,
          calls: rollup.calls,
          success: rollup.success,
          failure: rollup.failure,
          blocked: rollup.blocked,
          durationMs: rollup.durationMs,
        })),
    },
    note: `phase=${phase} tools=${metrics.tools.length} skipped=${metrics.skippedToolCalls}`,
  });
};
