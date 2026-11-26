import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AutomationGuardHandler,
  type GuardHandlingResult,
  type PendingPlanStep,
} from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import AutomationModePolicy from '@/domains/agent-brain/application/services/AutomationModePolicy';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import {
  registerHostedRunPersistencePort,
} from '@/domains/security-ops/runs/HostedRunPersistencePort';
import { createResearchLabRuntimeHostCapabilities } from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import { InMemoryUsageStore } from '@/domains/platform/subscriptions/infrastructure/usageStores';

const buildGuardResult = (overrides: Partial<GuardHandlingResult> = {}): GuardHandlingResult => ({
  suppressDone: false,
  scheduleAutoRetry: false,
  exhausted: false, // P0 FIX: New required field
  ...overrides,
});

const hostedToolExecutionLifecycle = () => ({
  claim: vi.fn(),
  markStarted: vi.fn(),
  block: vi.fn(),
  markOutcomeUnknown: vi.fn(),
});
const hostedModelRequestLifecycle = () => ({
  append: vi.fn(),
  findByRequestId: vi.fn(),
  findBySession: vi.fn(),
});
const hostedHistoryTransformationLifecycle = () => ({
  prepare: vi.fn(),
  persistReplacement: vi.fn(),
  activate: vi.fn(),
  findById: vi.fn(),
  findActiveBySession: vi.fn(),
  findBySession: vi.fn(),
});

const createHandler = (overrides: Partial<{ mode: 'interactive' | 'automated'; profileKey?: string }> = {}) => {
  const session = {
    id: 'session-1',
    mode: 'automated',
    profileKey: 'profile-1',
    stateMachine: { isProcessing: () => false },
    ...overrides,
  } as any;
  const sessionStore = { get: vi.fn(() => session) } as any;
  const automationPolicy = { evaluateGuard: vi.fn() } as any;
  const sessionRepository = {
    setBlockedReason: vi.fn(async () => true),
  };
  const handler = new AutomationGuardHandler({
    sessionStore,
    automationPolicy,
    sessionRepository,
  });

  return { handler, session, sessionStore, sessionRepository };
};

describe('AutomationGuardHandler.evaluateContinuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when session is not automated', async () => {
    const { handler } = createHandler({ mode: 'interactive' });
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'completed',
      pendingPlanSteps: [],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(false);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('leaves continuation ownership to an explicit Research Lab host', async () => {
    const unregister = registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'hosted-run',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
      toolExecutionLifecycle: hostedToolExecutionLifecycle(),
      modelRequestLifecycle: hostedModelRequestLifecycle(),
      providerAttemptLifecycle: new InMemoryUsageStore(),
      historyTransformationLifecycle: hostedHistoryTransformationLifecycle(),
    } as any);
    const { handler, session } = createHandler();
    session.flags = {
      securityops: {
        runHost: 'research_lab',
        runId: 'hosted-run',
      },
    };
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    try {
      const result = await handler.evaluateContinuation({
        sessionId: 'session-1',
        turnNumber: 1,
        turnStatus: 'max_tool_calls',
        pendingPlanSteps: [{ id: 'step-1' }],
        hasReport: false,
        guardResult: buildGuardResult({ scheduleAutoRetry: true }),
        processMessage: vi.fn(),
      });

      expect(result).toBe(false);
      expect(scheduleSpy).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('leaves continuation ownership to the worker delegation loop', async () => {
    const { handler, session } = createHandler();
    session.coordination = {
      role: 'worker',
      workerType: 'recon_worker',
      parentSessionId: 'parent-session',
      parentTaskId: 'worker-task',
    };
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'max_tool_calls',
      pendingPlanSteps: [{ id: 'step-1' }],
      hasReport: false,
      guardResult: buildGuardResult({ scheduleAutoRetry: true }),
      processMessage: vi.fn(),
    });

    expect(result).toBe(false);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('does not schedule an in-memory retry for an explicit Research Lab host', async () => {
    vi.useFakeTimers();
    const unregister = registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'hosted-run',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
      toolExecutionLifecycle: hostedToolExecutionLifecycle(),
      modelRequestLifecycle: hostedModelRequestLifecycle(),
      providerAttemptLifecycle: new InMemoryUsageStore(),
      historyTransformationLifecycle: hostedHistoryTransformationLifecycle(),
    } as any);
    const { handler, session } = createHandler();
    session.flags = {
      securityops: {
        runHost: 'research_lab',
        runId: 'hosted-run',
      },
    };
    const processMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await handler.scheduleRetry({
        sessionId: 'session-1',
        message: 'continue',
        processMessage,
        reason: 'phase_handoff_missing',
      });
      await vi.runAllTimersAsync();

      expect(processMessage).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('keeps core continuation active when a sidecar marker has no hosted owner', async () => {
    const { handler, session } = createHandler();
    session.agentType = 'planner';
    session.flags = {
      securityops: {
        runHost: 'research_lab',
        runId: 'unregistered-sidecar-run',
        activePhaseKey: 'planning',
      },
    };
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'max_tool_calls',
      pendingPlanSteps: [],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('planner_submit_required'),
    }));
  });

  it('returns true and schedules when pending steps remain', async () => {
    const { handler, session } = createHandler();
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);
    const pendingPlanSteps: PendingPlanStep[] = [{ id: 'step-1' }];

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'completed',
      pendingPlanSteps,
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'continue', profile: session.profileKey }),
    );
  });

  it('returns true and schedules when report is missing', async () => {
    const { handler, session } = createHandler();
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'completed',
      pendingPlanSteps: [],
      hasReport: false,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'continue', profile: session.profileKey }),
    );
  });

  it('schedules a direct submit_plan continuation for run-bound planners without a submitted plan', async () => {
    const { handler, session } = createHandler();
    session.agentType = 'planner';
    session.flags = { securityops: { runId: 'run-1' } };
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'max_tool_calls',
      pendingPlanSteps: [],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Call submit_plan now'),
        reason: 'planner_submit_required',
      }),
    );
  });

  it('backs off a run-bound planner without inventing a user prerequisite', async () => {
    const { handler, session, sessionStore, sessionRepository } = createHandler();
    session.agentType = 'planner';
    session.flags = {
      securityops: { runId: 'run-1' },
      plannerSubmitRetry: { count: 3 },
    };
    sessionStore.setAsync = vi.fn(async (_sessionId: string, nextSession: typeof session) => {
      Object.assign(session, nextSession);
    });
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 4,
      turnStatus: 'max_tool_calls',
      pendingPlanSteps: [],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
      recorder: recorder as any,
    });

    expect(result).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'planner_submit_required',
        delayMs: 30_000,
      }),
    );
    expect(session.blockedReason).toBeUndefined();
    expect(sessionRepository.setBlockedReason).not.toHaveBeenCalled();
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      4,
      expect.objectContaining({
        event: 'automation.continue',
      }),
    );
  });

  it('returns false when guard already scheduled a retry', async () => {
    const { handler } = createHandler();
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'completed',
      pendingPlanSteps: [{ id: 'step-1' }],
      hasReport: true,
      guardResult: buildGuardResult({ scheduleAutoRetry: true }),
      processMessage: vi.fn(),
    });

    expect(result).toBe(false);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it.each(['awaiting_user', 'aborted', 'credits_exhausted'])(
    'returns false for stop status %s',
    async (turnStatus) => {
    const { handler } = createHandler();
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus,
      pendingPlanSteps: [{ id: 'step-1' }],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(false);
    expect(scheduleSpy).not.toHaveBeenCalled();
    },
  );

  it('continues pending work after a model deadlock signal', async () => {
    const { handler } = createHandler();
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'deadlock',
      pendingPlanSteps: [{ id: 'step-1' }],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(true);
    expect(scheduleSpy).toHaveBeenCalled();
  });

  it('continues pending work when exhaustion is only diagnostic telemetry', async () => {
    const { handler } = createHandler();
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'completed',
      pendingPlanSteps: [{ id: 'step-1' }], // Has pending work
      hasReport: false, // Missing report
      guardResult: buildGuardResult({ exhausted: true }), // But guard exhausted!
      processMessage: vi.fn(),
    });

    expect(result).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'continue' }));
  });

  it('returns false when session is blocked', async () => {
    const { handler, session } = createHandler();
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);
    session.blockedReason = 'guard_exhausted';

    const result = await handler.evaluateContinuation({
      sessionId: 'session-1',
      turnNumber: 1,
      turnStatus: 'completed',
      pendingPlanSteps: [{ id: 'step-1' }],
      hasReport: false,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(result).toBe(false);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});

describe('AutomationGuardHandler.scheduleRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not append a synthetic "continue" user message when auto-retrying', async () => {
    vi.useFakeTimers();

    const session = {
      id: 'session-1',
      mode: 'automated',
      profileKey: 'profile-1',
      flags: {},
      stateMachine: { isProcessing: () => false },
    } as any;

    const sessionStore = { get: vi.fn(() => session) } as any;
    const automationPolicy = { evaluateGuard: vi.fn() } as any;
    const handler = new AutomationGuardHandler({ sessionStore, automationPolicy });

    const processMessage = vi.fn(async () => {});

    await handler.scheduleRetry({
      sessionId: session.id,
      message: 'continue',
      profile: session.profileKey,
      processMessage,
      delayMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(processMessage).toHaveBeenCalledWith(session.id, '', session.profileKey);
  });

  it('does not start a competing retry for a worker-owned session', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-1',
      mode: 'automated',
      profileKey: 'profile-1',
      flags: {},
      coordination: {
        role: 'worker',
        workerType: 'recon_worker',
        parentSessionId: 'parent-session',
        parentTaskId: 'worker-task',
      },
      stateMachine: { isProcessing: () => false },
    } as any;
    const sessionStore = { get: vi.fn(() => session) } as any;
    const automationPolicy = { evaluateGuard: vi.fn() } as any;
    const handler = new AutomationGuardHandler({ sessionStore, automationPolicy });
    const processMessage = vi.fn(async () => {});

    await handler.scheduleRetry({
      sessionId: session.id,
      message: 'continue',
      profile: session.profileKey,
      processMessage,
      delayMs: 25,
    });
    await vi.runAllTimersAsync();

    expect(processMessage).not.toHaveBeenCalled();
    expect(session.flags).toEqual({});
  });

  it('durably schedules a quota-blocked worker after its owned loop has yielded', async () => {
    const session = {
      id: 'worker-session',
      mode: 'automated',
      profileKey: 'profile-1',
      blockedReason: 'provider_quota_exhausted',
      flags: {},
      coordination: {
        role: 'worker',
        workerType: 'recon_worker',
        parentSessionId: 'parent-session',
        parentTaskId: 'worker-task',
      },
      stateMachine: { isProcessing: () => false },
    } as any;
    const recordExecutionDeferredAsync = vi.fn(async () => true);
    const sessionStore = {
      get: vi.fn(() => session),
      recordExecutionDeferredAsync,
    } as any;
    const handler = new AutomationGuardHandler({
      sessionStore,
      automationPolicy: { evaluateGuard: vi.fn() } as any,
      sessionRepository: { setBlockedReason: vi.fn(async () => true) },
    });

    await handler.scheduleRetry({
      sessionId: session.id,
      message: 'continue',
      profile: session.profileKey,
      processMessage: vi.fn(async () => {}),
      reason: 'provider_quota_exhausted',
      delayMs: 15 * 60_000,
    });

    expect(recordExecutionDeferredAsync).toHaveBeenCalledWith(
      session.id,
      'provider_quota_exhausted',
      expect.any(Date),
      expect.stringContaining('automation:'),
      undefined,
    );
  });

  it('preserves an existing repair nudge when scheduling a generic continuation', async () => {
    vi.useFakeTimers();

    const session = {
      id: 'session-1',
      mode: 'automated',
      profileKey: 'profile-1',
      flags: { ephemeralNudge: 'DIMINISHING RETURNS REPAIR: repair now' },
      stateMachine: { isProcessing: () => false },
    } as any;

    const sessionStore = { get: vi.fn(() => session) } as any;
    const automationPolicy = { evaluateGuard: vi.fn() } as any;
    const handler = new AutomationGuardHandler({ sessionStore, automationPolicy });

    await handler.scheduleRetry({
      sessionId: session.id,
      message: 'continue',
      profile: session.profileKey,
      processMessage: vi.fn(async () => {}),
      delayMs: 25,
    });

    expect(session.flags.ephemeralNudge).toBe('DIMINISHING RETURNS REPAIR: repair now');
  });

  it('tracks bounded planner submit retry attempts when scheduling planner continuation', async () => {
    vi.useFakeTimers();

    const session = {
      id: 'session-1',
      mode: 'automated',
      profileKey: 'profile-1',
      flags: {},
      stateMachine: { isProcessing: () => false },
    } as any;

    const sessionStore = { get: vi.fn(() => session) } as any;
    const automationPolicy = { evaluateGuard: vi.fn() } as any;
    const handler = new AutomationGuardHandler({ sessionStore, automationPolicy });

    await handler.scheduleRetry({
      sessionId: session.id,
      message: 'Call submit_plan now.',
      profile: session.profileKey,
      processMessage: vi.fn(async () => {}),
      reason: 'planner_submit_required',
      delayMs: 25,
    });

    expect(session.flags.plannerSubmitRetry).toEqual(
      expect.objectContaining({
        count: 1,
        reason: 'planner_submit_required',
      }),
    );
  });

  it('does not start a process-local timer when durable recovery is enabled', async () => {
    vi.useFakeTimers();

    const session = {
      id: 'session-1',
      mode: 'automated',
      profileKey: 'profile-1',
      flags: {},
      stateMachine: { isProcessing: () => false },
    } as any;

    const recordExecutionDeferredAsync = vi.fn(async () => true);
    const sessionStore = {
      get: vi.fn(() => session),
      recordExecutionDeferredAsync,
    } as any;
    const automationPolicy = { evaluateGuard: vi.fn() } as any;
    const sessionRepository = {
      setBlockedReason: vi.fn(async () => true),
    };
    const handler = new AutomationGuardHandler({ sessionStore, automationPolicy, sessionRepository });

    const processMessage = vi.fn(async () => {});

    await handler.scheduleRetry({
      sessionId: session.id,
      message: 'continue',
      profile: session.profileKey,
      processMessage,
      delayMs: 25,
      reason: 'pending_steps:1',
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(recordExecutionDeferredAsync).toHaveBeenCalledWith(
      session.id,
      'pending_steps:1',
      expect.any(Date),
      expect.stringContaining('automation:'),
      undefined,
    );
    expect(processMessage).not.toHaveBeenCalled();
  });
});

describe('AutomationGuardHandler guard exhaustion flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a degraded guard recoverable with durable backoff', async () => {
    const sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await sessionStore.create({ mode: 'automated', modelName: 'test-model' });
    // Use stateMachine as source of truth for processing state
    session.stateMachine?.startProcessing('test', session.turn ?? 0, 'test');
    await sessionStore.setAsync(session.id, session);

    const handler = new AutomationGuardHandler({
      sessionStore: sessionStore as any,
      automationPolicy: new AutomationModePolicy({ maxGuardRetries: 3 }),
    });
    const turnStream = { raw: vi.fn(), done: vi.fn() };

    let guardResult: GuardHandlingResult | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      guardResult = await handler.handle({
        sessionId: session.id,
        turnNumber: attempt + 1,
        session: sessionStore.get(session.id)!,
        pendingPlanSteps: [{ id: `step-${attempt}` }],
        hasReport: false,
        toolCallCount: 0,
        turnStatus: 'completed',
        turnStream,
        recorder: undefined,
      });
    }

    expect(guardResult?.exhausted).toBe(true);
    expect(guardResult?.scheduleAutoRetry).toBe(true);
    expect(guardResult?.autoRetryDelayMs).toBe(30_000);
    expect(sessionStore.get(session.id)?.blockedReason).toBeUndefined();

    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);
    const continued = await handler.evaluateContinuation({
      sessionId: session.id,
      turnNumber: 5,
      turnStatus: 'completed',
      pendingPlanSteps: [{ id: 'step-final' }],
      hasReport: false,
      guardResult: guardResult as GuardHandlingResult,
      processMessage: vi.fn(),
    });

    expect(continued).toBe(false);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('does not force report-missing retries for worker sessions', async () => {
    const sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await sessionStore.create({
      mode: 'automated',
      agentType: 'executor',
      modelName: 'test-model',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
      },
    });
    session.stateMachine?.startProcessing('test', session.turn ?? 0, 'test');
    await sessionStore.setAsync(session.id, session);

    const handler = new AutomationGuardHandler({
      sessionStore: sessionStore as any,
      automationPolicy: new AutomationModePolicy(),
    });
    const turnStream = { raw: vi.fn(), done: vi.fn() };

    const result = await handler.handle({
      sessionId: session.id,
      turnNumber: 1,
      session: sessionStore.get(session.id)!,
      pendingPlanSteps: [],
      hasReport: false,
      toolCallCount: 1,
      turnStatus: 'completed',
      turnStream,
      recorder: undefined,
    });

    expect(result.scheduleAutoRetry).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.modeSwitchReason).toBe('automated.completed');
    expect(turnStream.raw).not.toHaveBeenCalledWith(
      'warning',
      expect.objectContaining({ code: 'automated_guard' }),
    );
  });

  it('does not switch phase sessions to automated.completed before phase handoff', async () => {
    const session = {
      id: 'session-1',
      mode: 'automated',
      agentType: 'executor',
      profileKey: 'profile-1',
      flags: {
        securityops: {
          runId: 'run-1',
          activePhaseId: 'phase-validation',
          activePhaseKey: 'validation',
          phaseHandoffSubmitted: false,
        },
      },
      stateMachine: { isProcessing: () => true },
    } as any;
    const sessionStore = { get: vi.fn(() => session) } as any;
    const automationPolicy = new AutomationModePolicy();
    const handler = new AutomationGuardHandler({ sessionStore, automationPolicy });
    const turnStream = { raw: vi.fn(), done: vi.fn() };

    const result = await handler.handle({
      sessionId: session.id,
      turnNumber: 1,
      session,
      pendingPlanSteps: [],
      hasReport: false,
      toolCallCount: 1,
      turnStatus: 'completed',
      turnStream,
      recorder: undefined,
    });

    expect(result.modeSwitchReason).toBeUndefined();
    expect(result.scheduleAutoRetry).toBe(false);
  });
});

describe('AutomationGuardHandler completion deferral', () => {
  it('does not switch to automated.completed while live sidecar workers are still active', async () => {
    const session = {
      id: 'session-1',
      mode: 'automated',
      agentType: 'executor',
      profileKey: 'profile-1',
      workerTasks: [
        {
          taskId: 'task-sidecar',
          status: 'running',
          executionMode: 'background',
          dependencyMode: 'sidecar',
        },
      ],
      stateMachine: { isProcessing: () => false },
    } as any;
    const sessionStore = { get: vi.fn(() => session) } as any;
    const automationPolicy = { evaluateGuard: vi.fn(() => ({ active: false, exhausted: false, nextRetryCount: 0, pendingStepIds: [], suppressDone: false })) } as any;
    const handler = new AutomationGuardHandler({ sessionStore, automationPolicy });
    const turnStream = { raw: vi.fn(), done: vi.fn() };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    const result = await handler.handle({
      sessionId: session.id,
      turnNumber: 1,
      session,
      pendingPlanSteps: [],
      hasReport: true,
      toolCallCount: 1,
      turnStatus: 'completed',
      turnStream,
      recorder: recorder as any,
    });

    expect(result.modeSwitchReason).toBeUndefined();
    expect(turnStream.raw).toHaveBeenCalledWith(
      'warning',
      expect.objectContaining({
        code: 'completion_deferred_live_workers',
        liveWorkerTaskIds: ['task-sidecar'],
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'automated.completion_deferred',
      }),
    );
  });
});
