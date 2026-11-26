import type { SessionState } from '@/domains/agent-brain/domain/types';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { stopProcessing } from '@/domains/agent-brain/application/orchestration/utils/sessionProcessing';
import { logger } from '@/shared/logger';

export type TerminalKind =
  | 'worker_result_submitted'
  | 'phase_handoff_submitted'
  | 'run_finalized'
  | 'validation_outcome_submitted'
  | 'exposure_verification_submitted'
  | 'plan_submitted';

export interface SessionTerminalState {
  isTerminal: boolean;
  kind?: TerminalKind;
  existingResult?: unknown;
  completionRecorded?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const getSecurityOpsFlags = (session: SessionState | undefined): Record<string, unknown> | undefined =>
  isRecord(session?.flags?.securityops) ? session?.flags.securityops : undefined;

const getSessionFlags = (session: SessionState | undefined): Record<string, unknown> | undefined =>
  isRecord(session?.flags?.session) ? session?.flags.session : undefined;

const log = logger.child({ scope: 'TerminalActionLayer' });

const traceTerminalEvent = (
  ctx: ToolContext,
  sessionId: string,
  event: string,
  severity: 'debug' | 'info' | 'warn' | 'error',
  payload: Record<string, unknown>,
  note: string,
): void => {
  ctx.trace?.write?.(sessionId, ctx.turnNumber ?? 0, {
    event,
    severity,
    payload,
    note,
  }).catch((error) => {
    log.warn({ err: error, sessionId, event }, 'Failed to record terminal trace event');
  });
};

const isCompletionRecorded = (session: SessionState | undefined): boolean =>
  session?.completed === true || getSessionFlags(session)?.completed === true;

const isReportingPhase = (securityops: Record<string, unknown> | undefined): boolean =>
  getString(securityops?.activePhaseKey)?.toLowerCase() === 'reporting';

const buildPhaseHandoffResult = (securityops: Record<string, unknown>): Record<string, unknown> => ({
  phaseId: getString(securityops.activePhaseId),
  phase: getString(securityops.activePhaseKey),
  status: getString(securityops.phaseHandoffStatus),
  handoffRef: getString(securityops.phaseHandoffRef),
});

const buildRunFinalizedResult = (securityops: Record<string, unknown>): Record<string, unknown> => ({
  mode:
    securityops.finalizedMode === 'interim' || securityops.finalizedMode === 'final'
      ? securityops.finalizedMode
      : 'final',
  finalizedAt: getString(securityops.artifactsFinalizedAt),
  runCompletion: isRecord(securityops.runCompletion) ? securityops.runCompletion : undefined,
});

const markSessionCompletedInMemory = (
  session: SessionState,
  reason: TerminalKind | 'run_finalized.cleanup',
): void => {
  session.completed = true;
  session.blockedReason = undefined;
  session.pendingApproval = undefined;
  session.flags = {
    ...(session.flags ?? {}),
    session: {
      ...(getSessionFlags(session) ?? {}),
      completed: true,
    },
  };
  stopProcessing(session, {
    reason,
    turnNumber: session.turn,
    caller: 'TerminalActionLayer',
  });
};

const listTerminalRunSessions = (
  ctx: ToolContext,
  currentSession: SessionState,
  runId: string | undefined,
): SessionState[] => {
  const store = ctx.sessionStore as typeof ctx.sessionStore & {
    listByRunId?: (runId?: string) => SessionState[];
  };
  const sessions = runId && typeof store.listByRunId === 'function'
    ? store.listByRunId(runId)
    : [];
  const byId = new Map<string, SessionState>();
  for (const candidate of [...sessions, currentSession]) {
    if (candidate?.id) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()];
};

const cleanupRunSandboxes = async (
  ctx: ToolContext,
  currentSession: SessionState,
  options: { cleanupWorkspace?: boolean } = {},
): Promise<void> => {
  const runId = getString(getSecurityOpsFlags(currentSession)?.runId);
  const runSessions = listTerminalRunSessions(ctx, currentSession, runId);
  const sessionIds = runSessions.map((session) => session.id);
  traceTerminalEvent(ctx, currentSession.id, 'session.cleanup.started', 'info', {
    terminalState: 'run_finalized',
    reason: 'run_finalized',
    runId,
    sessionIds,
    cleanupWorkspace: options.cleanupWorkspace !== false,
  }, 'terminal run cleanup started');

  for (const runSession of runSessions) {
    if (runSession.completed !== true || getSessionFlags(runSession)?.completed !== true) {
      const completionRecorded = await ctx.sessionStore.recordSessionCompletedAsync(
        runSession.id,
        'run_finalized.cleanup',
      );
      if (!completionRecorded) {
        throw new Error(`durable_run_session_completion_failed:${runSession.id}`);
      }
      markSessionCompletedInMemory(runSession, 'run_finalized.cleanup');
      await ctx.sessionStore
        .setAsync(runSession.id, runSession, 'run_finalized.cleanup')
        .catch((error) => {
          log.warn({ err: error, sessionId: runSession.id, runId }, 'Failed to persist terminal run session cleanup');
        });
    }
  }

  const sandbox = ctx.sandbox as typeof ctx.sandbox & {
    destroySandbox?: (session: SessionState) => Promise<void>;
    destroy?: (session: SessionState) => Promise<void>;
  };
  const destroy = sandbox.destroySandbox ?? sandbox.destroy;
  if (typeof destroy !== 'function') {
    traceTerminalEvent(ctx, currentSession.id, 'session.cleanup.completed', 'warn', {
      terminalState: 'run_finalized',
      reason: 'run_finalized',
      runId,
      sessionIds,
      sandboxDestroyed: false,
      workspaceCleaned: false,
      error: 'sandbox_destroy_unavailable',
    }, 'terminal cleanup completed without sandbox destroy support');
    return;
  }

  let sandboxDestroyed = true;
  for (const runSession of runSessions) {
    await destroy.call(sandbox, runSession).catch((error: unknown) => {
      sandboxDestroyed = false;
      log.warn({ err: error, sessionId: runSession.id, runId }, 'Failed to destroy terminal run sandbox');
      traceTerminalEvent(ctx, currentSession.id, 'session.cleanup.failed', 'warn', {
        terminalState: 'run_finalized',
        reason: 'sandbox_destroy_failed',
        runId,
        sessionId: runSession.id,
        error: error instanceof Error ? error.message : String(error),
      }, 'terminal sandbox cleanup failed');
    });
  }

  let workspaceCleaned = options.cleanupWorkspace === false ? false : Boolean(runId);
  if (runId && options.cleanupWorkspace !== false) {
    await ctx.sessionStore.cleanupRunWorkspaceAsync(runId, {
      reason: 'run_finalized',
    }).catch((error) => {
      workspaceCleaned = false;
      log.warn({ err: error, runId }, 'Failed to clean up finalized run workspace');
      traceTerminalEvent(ctx, currentSession.id, 'session.cleanup.failed', 'warn', {
        terminalState: 'run_finalized',
        reason: 'workspace_cleanup_failed',
        runId,
        error: error instanceof Error ? error.message : String(error),
      }, 'terminal workspace cleanup failed');
    });
  }
  traceTerminalEvent(ctx, currentSession.id, 'session.cleanup.completed', sandboxDestroyed ? 'info' : 'warn', {
    terminalState: 'run_finalized',
    reason: 'run_finalized',
    runId,
    sessionIds,
    sandboxDestroyed,
    workspaceCleaned,
  }, 'terminal run cleanup completed');
};

const cleanupWorkerSandbox = async (
  ctx: ToolContext,
  workerSession: SessionState,
): Promise<void> => {
  const sandbox = ctx.sandbox as typeof ctx.sandbox & {
    destroySandbox?: (session: SessionState) => Promise<void>;
    destroy?: (session: SessionState) => Promise<void>;
  } | undefined;
  if (!sandbox) {
    traceTerminalEvent(ctx, workerSession.id, 'session.cleanup.completed', 'warn', {
      terminalState: 'worker_result_submitted',
      reason: 'worker_result_submitted',
      sessionId: workerSession.id,
      sandboxDestroyed: false,
      error: 'sandbox_unavailable',
    }, 'worker terminal cleanup completed without sandbox support');
    return;
  }
  const destroy = sandbox.destroySandbox ?? sandbox.destroy;
  if (typeof destroy !== 'function') {
    traceTerminalEvent(ctx, workerSession.id, 'session.cleanup.completed', 'warn', {
      terminalState: 'worker_result_submitted',
      reason: 'worker_result_submitted',
      sessionId: workerSession.id,
      sandboxDestroyed: false,
      error: 'sandbox_destroy_unavailable',
    }, 'worker terminal cleanup completed without sandbox destroy support');
    return;
  }

  await destroy.call(sandbox, workerSession).then(() => {
    traceTerminalEvent(ctx, workerSession.id, 'session.cleanup.completed', 'info', {
      terminalState: 'worker_result_submitted',
      reason: 'worker_result_submitted',
      sessionId: workerSession.id,
      sandboxDestroyed: true,
    }, 'worker terminal sandbox cleanup completed');
  }).catch((error: unknown) => {
    log.warn({ err: error, sessionId: workerSession.id }, 'Failed to destroy terminal worker sandbox');
    traceTerminalEvent(ctx, workerSession.id, 'session.cleanup.failed', 'warn', {
      terminalState: 'worker_result_submitted',
      reason: 'sandbox_destroy_failed',
      sessionId: workerSession.id,
      error: error instanceof Error ? error.message : String(error),
    }, 'worker terminal sandbox cleanup failed');
  });
};

export function checkSessionTerminal(session: SessionState | undefined): SessionTerminalState {
  if (!session) {
    return { isTerminal: false };
  }

  const securityops = getSecurityOpsFlags(session);
  const completionRecorded = isCompletionRecorded(session);

  if (
    session.coordination?.role === 'worker' &&
    session.completed === true &&
    session.workerResult
  ) {
    return {
      isTerminal: true,
      kind: 'worker_result_submitted',
      existingResult: session.workerResult,
      completionRecorded,
    };
  }

  if (
    securityops &&
    typeof securityops.artifactsFinalizedAt === 'string' &&
    isRecord(securityops.runCompletion) &&
    securityops.runCompletion.state === 'completed'
  ) {
    return {
      isTerminal: true,
      kind: 'run_finalized',
      existingResult: buildRunFinalizedResult(securityops),
      completionRecorded,
    };
  }

  if (
    session.coordination?.role === 'worker' &&
    session.coordination.workerType === 'validator_worker' &&
    securityops?.validationOutcomeSubmitted === true
  ) {
    return {
      isTerminal: true,
      kind: 'validation_outcome_submitted',
      existingResult: securityops.validationOutcomeResult,
      completionRecorded,
    };
  }

  // An exposure verification is a run-bound planner whose entire job is to
  // return one verdict, so submitting it ends the session.
  //
  // This needs its own kind rather than reusing the validator-worker branch
  // above: the run is a planner, not a worker, so that condition can never hold
  // for it. Without a terminal state the automation engine sees an unfinished
  // run-bound planner and drives it toward `submit_plan` — a tool the
  // verification policy denies — until the continuation budget is exhausted and
  // the paid run ends blocked instead of completed.
  if (securityops?.exposureVerificationSubmitted === true) {
    return {
      isTerminal: true,
      kind: 'exposure_verification_submitted',
      existingResult: securityops.exposureVerificationResult,
      completionRecorded,
    };
  }

  if (
    securityops?.phaseHandoffSubmitted === true &&
    getString(securityops.phaseHandoffRef) &&
    !isReportingPhase(securityops)
  ) {
    return {
      isTerminal: true,
      kind: 'phase_handoff_submitted',
      existingResult: buildPhaseHandoffResult(securityops),
      completionRecorded,
    };
  }

  if (session.agentType === 'planner' && completionRecorded) {
    return {
      isTerminal: true,
      kind: 'plan_submitted',
      existingResult: { runId: getString(securityops?.runId) },
      completionRecorded,
    };
  }

  return { isTerminal: false, completionRecorded };
}

export async function applyTerminal(
  session: SessionState,
  ctx: ToolContext,
  kind: TerminalKind,
  result: unknown,
): Promise<{ alreadyTerminal: boolean; existingResult?: unknown }> {
  const workingSession = ctx.sessionStore.get(session.id) ?? session;
  const terminal = checkSessionTerminal(workingSession);
  if (terminal.isTerminal && terminal.kind === kind && terminal.completionRecorded) {
    return { alreadyTerminal: true, existingResult: terminal.existingResult };
  }

  if (kind === 'worker_result_submitted' && isRecord(result)) {
    workingSession.workerResult = result as unknown as SessionState['workerResult'];
    if (typeof result.summary === 'string') {
      workingSession.summary = result.summary;
    }
  }

  if (kind === 'validation_outcome_submitted') {
    const securityops = getSecurityOpsFlags(workingSession) ?? {};
    workingSession.flags = {
      ...(workingSession.flags ?? {}),
      securityops: {
        ...securityops,
        validationOutcomeSubmitted: true,
        validationOutcomeResult: result,
      },
    };
  }

  if (kind === 'exposure_verification_submitted') {
    const securityops = getSecurityOpsFlags(workingSession) ?? {};
    workingSession.flags = {
      ...(workingSession.flags ?? {}),
      securityops: {
        ...securityops,
        exposureVerificationSubmitted: true,
        exposureVerificationResult: result,
      },
    };
  }

  const completionRecorded = await ctx.sessionStore.recordSessionCompletedAsync(workingSession.id, kind);
  if (!completionRecorded) {
    throw new Error(`durable_terminal_completion_failed:${workingSession.id}:${kind}`);
  }
  markSessionCompletedInMemory(workingSession, kind);
  await ctx.sessionStore.setAsync(workingSession.id, workingSession, kind);
  traceTerminalEvent(ctx, workingSession.id, 'session.terminal_applied', 'info', {
    terminalState: kind,
    reason: kind,
    result: isRecord(result) ? result : undefined,
  }, `terminal action applied: ${kind}`);
  if (kind === 'worker_result_submitted') {
    await cleanupWorkerSandbox(ctx, workingSession);
  }
  if (kind === 'run_finalized') {
    await cleanupRunSandboxes(ctx, workingSession, { cleanupWorkspace: false });
  }

  return { alreadyTerminal: false };
}
