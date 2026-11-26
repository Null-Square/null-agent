import { describe, expect, it, vi } from 'vitest';

import {
  buildPrematureStopCorrectiveMessage,
  checkContinuation,
  createExitCheckpoint,
  emitToolInvocationRollup,
  getActivePhaseKey,
  markDiminishingReturns,
  markRecoverableGuard,
  reconcilePlanForExit,
} from '@/domains/agent-brain/application/orchestration/execution/TurnLoopGuards';

const baseMetrics = {
  llmInputTokens: 0,
  llmOutputTokens: 0,
  llmCachedTokens: 0,
  llmLatencyMs: 0,
  llmTtftMsTotal: 0,
  llmTtftSamples: 0,
  llmStreamedOutputTokens: 0,
  llmStreamingMs: 0,
  llmCallCount: 2,
  tools: [],
  skippedToolCalls: 0,
  totalToolLatencyMs: 0,
};

const createCheckpointSession = (overrides: Record<string, unknown> = {}): any => ({
  id: 'session-1',
  flags: {},
  lastCheckpoint: {
    id: 'checkpoint-last',
  },
  plan: [
    {
      id: 'step-1',
      title: 'Validate target',
      status: 'running',
    },
  ],
  currentPlanStepId: 'step-1',
  ...overrides,
});

const createCheckpointStore = (session: any) => ({
  get: vi.fn(() => session),
  setAsync: vi.fn().mockResolvedValue(undefined),
});

describe('TurnLoopGuards', () => {
  it('normalizes the active SecurityOps phase key', () => {
    expect(getActivePhaseKey({
      flags: {
        securityops: {
          activePhaseKey: ' Validation ',
        },
      },
    } as any)).toBe('validation');
    expect(getActivePhaseKey({ flags: { securityops: {} } } as any)).toBeNull();
  });

  it('builds premature-stop corrections from terminal and phase state', () => {
    expect(buildPrematureStopCorrectiveMessage({
      flags: {
        securityops: {
          activePhaseKey: 'validation',
        },
      },
    } as any)).toBe(
      'You stopped before closing the active phase. If work remains, continue immediately with a tool call. If the phase is complete, call submit_phase_handoff with completed objectives, unresolved questions, artifacts, canonical writes, and evidence references.',
    );

    expect(buildPrematureStopCorrectiveMessage({
      completed: true,
      coordination: { role: 'worker' },
      workerResult: { ok: true },
    } as any)).toBe(
      'Your worker result is already submitted and recorded. Do not call submit_worker_result again; stop this worker session.',
    );
  });

  it('creates an exit workspace checkpoint when tool work ran', async () => {
    const session = createCheckpointSession();
    const sessionStore = createCheckpointStore(session);
    const checkpointManager = { create: vi.fn().mockResolvedValue({ id: 'checkpoint-new' }) };
    const stream = { raw: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn() };

    const checkpointId = await createExitCheckpoint({
      sessionStore,
      checkpointManager,
      stream,
      log,
      sessionId: 'session-1',
      reason: 'credits_exhausted',
      executedToolCalls: 2,
    });

    expect(checkpointId).toBe('checkpoint-new');
    expect(checkpointManager.create).toHaveBeenCalledWith('session-1');
    expect(stream.raw).toHaveBeenCalledWith('checkpoint_created', { id: 'checkpoint-new' });
  });

  it('returns the existing workspace checkpoint when no tool work ran', async () => {
    const session = createCheckpointSession();
    const sessionStore = createCheckpointStore(session);
    const checkpointManager = { create: vi.fn() };

    const checkpointId = await createExitCheckpoint({
      sessionStore,
      checkpointManager,
      sessionId: 'session-1',
      reason: 'max_tool_calls',
      executedToolCalls: 0,
    });

    expect(checkpointId).toBe('checkpoint-last');
    expect(checkpointManager.create).not.toHaveBeenCalled();
  });

  it('falls back to the last checkpoint when checkpoint creation fails', async () => {
    const session = createCheckpointSession();
    const sessionStore = createCheckpointStore(session);
    const error = new Error('checkpoint backend unavailable');
    const checkpointManager = { create: vi.fn().mockRejectedValue(error) };
    const log = { info: vi.fn(), warn: vi.fn() };

    const checkpointId = await createExitCheckpoint({
      sessionStore,
      checkpointManager,
      log,
      sessionId: 'session-1',
      reason: 'credits_exhausted',
      executedToolCalls: 1,
    });

    expect(checkpointId).toBe('checkpoint-last');
    expect(log.warn).toHaveBeenCalledWith(
      { err: error, sessionId: 'session-1', reason: 'credits_exhausted', executedToolCalls: 1 },
      '[TurnRunner] Failed to create exit workspace checkpoint',
    );
  });

  it('reconciles plan state on turn exit', async () => {
    const planRuntime = {
      reconcilePlanForExit: vi.fn().mockResolvedValue(undefined),
    };

    await reconcilePlanForExit({
      planRuntime,
      sessionId: 'session-1',
      reason: 'credits_exhausted',
      blockPending: true,
      checkpointId: 'checkpoint-1',
    });

    expect(planRuntime.reconcilePlanForExit).toHaveBeenCalledWith('session-1', {
      reason: 'credits_exhausted',
      blockPending: true,
      checkpointId: 'checkpoint-1',
    });
  });

  it('allows continuation when no work guard blocks the boundary', async () => {
    await expect(
      checkContinuation({
        sessionId: 'session-1',
        turnNumber: 1,
        boundary: 'model_call',
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('records blocked work continuation decisions', async () => {
    const abortSignal = new AbortController().signal;
    const workContinuationGuard = {
      canContinue: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'aborted_by_user',
        source: 'state_machine',
      }),
    };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    const result = await checkContinuation({
      workContinuationGuard,
      recorder,
      sessionId: 'session-1',
      turnNumber: 2,
      boundary: 'tool_call',
      abortSignal,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'aborted_by_user',
      source: 'state_machine',
    });
    expect(workContinuationGuard.canContinue).toHaveBeenCalledWith({
      sessionId: 'session-1',
      boundary: 'tool_call',
      abortSignal,
    });
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      2,
      expect.objectContaining({
        event: 'session.work_blocked',
        payload: expect.objectContaining({
          boundary: 'tool_call',
          reason: 'aborted_by_user',
          status: 'aborted',
          retryable: false,
          resumeAllowed: false,
          source: 'state_machine',
        }),
      }),
    );
  });

  it('logs and still returns blocked work decisions when telemetry write fails', async () => {
    const error = new Error('trace unavailable');
    const workContinuationGuard = {
      canContinue: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'paused_by_user',
      }),
    };
    const recorder = { write: vi.fn().mockRejectedValue(error) };
    const log = { warn: vi.fn() };

    const result = await checkContinuation({
      workContinuationGuard,
      recorder,
      log,
      sessionId: 'session-1',
      turnNumber: 2,
      boundary: 'model_call',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'paused_by_user',
    });
    expect(log.warn).toHaveBeenCalledWith(
      { err: error, sessionId: 'session-1', boundary: 'model_call' },
      'Failed to record work block',
    );
  });

  it('marks recoverable guards as repair nudges without terminalizing the turn', async () => {
    const session = createCheckpointSession({
      messages: [{ role: 'user', content: 'continue' }],
      blockedReason: 'temporary_guard',
      flags: {
        recoverableGuard: {
          triggerCount: 2,
        },
      },
    });
    const sessionStore = createCheckpointStore(session);
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const emitTurnToolInvocationRollup = vi.fn().mockResolvedValue(undefined);
    const summarize = vi.fn();

    const result = await markRecoverableGuard({
      sessionStore,
      recorder,
      sessionId: 'session-1',
      turnNumber: 5,
      extra: { reason: 'recoverable_test_guard' },
      toolCallCount: 4,
      requestedToolCallCount: 6,
      metrics: baseMetrics,
      emitTurnToolInvocationRollup,
      summarize,
    });

    expect(session.blockedReason).toBeUndefined();
    expect(session.flags.ephemeralNudge).toContain('RECOVERABLE GUARD');
    expect(session.flags.recoverableGuard).toEqual({
      nudgedAtTurn: 5,
      repairTurn: 6,
      triggerCount: 3,
      details: { reason: 'recoverable_test_guard' },
    });
    expect(sessionStore.setAsync).toHaveBeenCalledWith('session-1', session, 'recoverable_guard_nudge');
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      5,
      expect.objectContaining({
        event: 'context.recoverable_guard_nudge',
        payload: expect.objectContaining({
          reason: 'recoverable_test_guard',
          action: 'repair_nudge',
        }),
      }),
    );
    expect(emitTurnToolInvocationRollup).toHaveBeenCalledWith('max_tool_calls');
    expect(summarize).toHaveBeenCalledWith(
      'max_tool_calls',
      {
        reason: 'recoverable_test_guard',
      },
      4,
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'max_tool_calls',
        toolCallCount: 4,
        toolCallsRequested: 6,
        messagesLength: 1,
        doneEmitted: false,
        metrics: baseMetrics,
      }),
    );
  });

  it('marks diminishing returns as repair nudges without terminalizing the turn', async () => {
    const session = createCheckpointSession({
      messages: [{ role: 'assistant', content: 'working' }, { role: 'tool', content: 'same result' }],
      flags: {
        diminishingReturns: {
          triggerCount: 1,
        },
      },
    });
    const sessionStore = createCheckpointStore(session);
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const emitTurnToolInvocationRollup = vi.fn().mockResolvedValue(undefined);
    const summarize = vi.fn();

    const result = await markDiminishingReturns({
      sessionStore,
      recorder,
      sessionId: 'session-1',
      turnNumber: 8,
      details: { stopReason: 'low_yield_continuations', totalToolCalls: 12 },
      toolCallCount: 12,
      requestedToolCallCount: 12,
      metrics: baseMetrics,
      emitTurnToolInvocationRollup,
      summarize,
    });

    expect(session.flags.ephemeralNudge).toContain('DIMINISHING RETURNS REPAIR');
    expect(session.flags.diminishingReturns).toEqual({
      nudgedAtTurn: 8,
      repairTurn: 9,
      triggerCount: 2,
      details: { stopReason: 'low_yield_continuations', totalToolCalls: 12 },
    });
    expect(sessionStore.setAsync).toHaveBeenCalledWith('session-1', session, 'diminishing_returns_nudge');
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      8,
      expect.objectContaining({
        event: 'context.diminishing_returns_nudge',
        payload: expect.objectContaining({
          action: 'repair_nudge',
          stopReason: 'low_yield_continuations',
          totalToolCalls: 12,
        }),
      }),
    );
    expect(emitTurnToolInvocationRollup).toHaveBeenCalledWith('max_tool_calls');
    expect(summarize).toHaveBeenCalledWith(
      'max_tool_calls',
      {
        reason: 'diminishing_returns_repair_nudge',
        stopReason: 'low_yield_continuations',
        totalToolCalls: 12,
      },
      12,
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'max_tool_calls',
        toolCallCount: 12,
        toolCallsRequested: 12,
        messagesLength: 2,
        doneEmitted: false,
        metrics: baseMetrics,
      }),
    );
  });

  it('emits aggregated tool invocation rollups', async () => {
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    await emitToolInvocationRollup({
      recorder,
      sessionId: 'session-1',
      turnNumber: 3,
      status: 'completed',
      phase: 'validation',
      activePhaseKey: 'validation',
      requestedToolCallCount: 4,
      metrics: {
        ...baseMetrics,
        skippedToolCalls: 1,
        totalToolLatencyMs: 42,
        tools: [
          { name: 'http_payload', durationMs: 10, success: true, outcome: 'success' },
          { name: 'file_read', durationMs: 12, success: false, outcome: 'failure' },
          { name: 'http_payload', durationMs: 20, success: false, outcome: 'blocked' },
        ],
      },
    });

    expect(recorder.write).toHaveBeenCalledWith('session-1', 3, {
      event: 'phase.tool_invocation_rollup',
      severity: 'info',
      payload: {
        phase: 'validation',
        activePhaseKey: 'validation',
        status: 'completed',
        turn: 3,
        llmCallCount: 2,
        requestedToolCalls: 4,
        executedToolCalls: 3,
        skippedToolCalls: 1,
        successCount: 1,
        failureCount: 1,
        blockedCount: 1,
        totalToolLatencyMs: 42,
        tools: [
          { name: 'file_read', calls: 1, success: 0, failure: 1, blocked: 0, durationMs: 12 },
          { name: 'http_payload', calls: 2, success: 1, failure: 0, blocked: 1, durationMs: 30 },
        ],
      },
      note: 'phase=validation tools=3 skipped=1',
    });
  });

  it('does not emit when recorder is unavailable', async () => {
    await expect(
      emitToolInvocationRollup({
        sessionId: 'session-1',
        turnNumber: 3,
        status: 'completed',
        phase: 'execution',
        activePhaseKey: null,
        requestedToolCallCount: 0,
        metrics: baseMetrics,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not emit when no tool calls or skips were recorded', async () => {
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    await emitToolInvocationRollup({
      recorder,
      sessionId: 'session-1',
      turnNumber: 3,
      status: 'completed',
      phase: 'execution',
      activePhaseKey: null,
      requestedToolCallCount: 0,
      metrics: baseMetrics,
    });

    expect(recorder.write).not.toHaveBeenCalled();
  });
});
