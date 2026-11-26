import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import {
  ProcessMessageCommand,
  shouldEmitGenericCompletionNotification,
} from '@/domains/agent-brain/application/orchestration/commands/ProcessMessageCommand';
import { AutomationGuardHandler } from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import { StreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import AutomationModePolicy from '@/domains/agent-brain/application/services/AutomationModePolicy';
import { startProcessing } from '@/domains/agent-brain/application/orchestration/utils/sessionProcessing';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const createHotPathDeps = (pipeline: {
  prepareSession: (...args: any[]) => any;
  buildPrompt: (...args: any[]) => any;
  executeTurn: (...args: any[]) => any;
  reconcilePlan: (...args: any[]) => any;
  flushArtifacts: (...args: any[]) => any;
}) => ({
  prepareStage: { run: pipeline.prepareSession } as any,
  buildStage: { run: pipeline.buildPrompt } as any,
  reconcileStage: { run: pipeline.reconcilePlan } as any,
  turnExecutor: {
    runTurn: pipeline.executeTurn,
    setModel: vi.fn(),
    setModelName: vi.fn(),
  } as any,
  artifactService: {
    flush: pipeline.flushArtifacts,
  } as any,
});

describe('ProcessMessageCommand completion contract', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  afterEach(() => {
    store.shutdown();
  });

  it('leaves Watch completion delivery to the Watch domain event', () => {
    const base = {
      id: 'session-1',
      flags: { securityops: { runTrigger: 'watch_scheduled' } },
    } as any;
    expect(shouldEmitGenericCompletionNotification(base)).toBe(false);
    expect(shouldEmitGenericCompletionNotification({
      ...base,
      flags: { securityops: { runTrigger: 'manual' } },
    })).toBe(true);
  });

  it('marks the live session completed before cleanup emits the final status event', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4' });
    startProcessing(session, { reason: 'test_completion', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing');

    const events: Array<{ type: string; data?: unknown }> = [];
    const turnStream = new StreamBroker((event) => events.push(event));
    const eventPublisher = {
      emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
      subscribe: () => () => undefined,
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };

    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 0,
        metrics: undefined,
        usage: undefined,
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: true }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: eventPublisher as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted: vi.fn().mockResolvedValue(true),
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'complete the run' });

    const updated = store.get(session.id);
    const completionEvent = events.find((event) => event.type === 'session.status');

    expect(updated?.completed).toBe(true);
    expect((updated?.flags?.session as Record<string, unknown> | undefined)?.completed).toBe(true);
    expect(updated?.stateMachine?.isProcessing()).toBe(false);
    expect(completionEvent).toEqual(
      expect.objectContaining({
        type: 'session.status',
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  it('injects token guard warnings as a one-turn prompt nudge before the model call', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4' });
    startProcessing(session, { reason: 'test_token_warning', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing');

    const events: Array<{ type: string; data?: unknown }> = [];
    const turnStream = new StreamBroker((event) => events.push(event));
    const eventPublisher = {
      emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
      subscribe: () => () => undefined,
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };

    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 0,
        metrics: undefined,
        usage: undefined,
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: false, hasReport: false }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: eventPublisher as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({
          proceed: true,
          warnings: [{
            code: 'tokens_high',
            message: 'Session token use is at 80% of the safety limit. Finish the smallest valid unit now.',
          }],
        }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted: vi.fn().mockResolvedValue(true),
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'continue' });

    expect(pipeline.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          flags: expect.objectContaining({
            ephemeralNudge: expect.stringContaining('TOKEN SAFETY WARNING'),
          }),
        }),
      }),
    );
    expect(store.get(session.id)?.flags.ephemeralNudge).toContain('Complete or hand off now');
  });

  it('synthesizes a partial worker artifact when the universal token guard halts a worker pre-turn', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-4',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
      },
    });
    session.messages.push({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Mapped the login and API entrypoints, but did not finish the secondary crawl.',
      timestamp: Date.now(),
    });
    startProcessing(session, { reason: 'test_worker_token_budget', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.worker_token_budget');

    const events: Array<{ type: string; data?: any }> = [];
    const turnStream = new StreamBroker((event) => events.push(event));
    const eventPublisher = {
      emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
      subscribe: () => () => undefined,
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };

    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 2,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: { write: vi.fn().mockResolvedValue(undefined) },
      }),
      buildPrompt: vi.fn(),
      executeTurn: vi.fn(),
      reconcilePlan: vi.fn(),
      flushArtifacts: vi.fn(),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: eventPublisher as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({
          proceed: false,
          haltReason: 'token_limit_exceeded',
          haltEventData: {
            sessionId: session.id,
            currentUsage: 10_010_000,
            limit: 10_000_000,
            usagePct: 100,
          },
          warnings: [],
        }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn(),
        applyModeSwitch: vi.fn(),
        evaluateContinuation: vi.fn(),
        scheduleRetry: vi.fn(),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted: vi.fn().mockResolvedValue(true),
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'continue worker' });

    const updated = store.get(session.id);
    expect(pipeline.buildPrompt).not.toHaveBeenCalled();
    expect(pipeline.executeTurn).not.toHaveBeenCalled();
    expect(updated?.completed).toBe(true);
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.workerResult).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        workerType: 'recon_worker',
        summary: expect.stringContaining('universal session token safety limit'),
        recommendedNextAction: expect.stringContaining('partial worker result'),
      }),
    );
    expect((updated?.flags?.session as Record<string, unknown> | undefined)?.workerTokenLimitPartialResult).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'warning',
          data: expect.objectContaining({ code: 'worker_token_limit_partial_result' }),
        }),
        expect.objectContaining({ type: 'done' }),
      ]),
    );
  });

  it('keeps non-reporting phase sessions out of full completion and continues until handoff', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-4',
      scopeId: 'scope-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
          activePhaseId: 'phase-validation',
          activePhaseKey: 'validation',
          phaseHandoffSubmitted: false,
        },
      },
    });
    startProcessing(session, { reason: 'test_phase_needs_handoff', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing.phase_needs_handoff');

    const events: Array<{ type: string; data?: any }> = [];
    const turnStream = new StreamBroker((event) => events.push(event));
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 1,
        toolCallsRequested: 1,
        messagesLength: 0,
        metrics: undefined,
        usage: undefined,
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: true }),
    };
    const automationGuardHandler = new AutomationGuardHandler({
      sessionStore: store as any,
      automationPolicy: new AutomationModePolicy(),
    });
    const scheduleRetry = vi.spyOn(automationGuardHandler, 'scheduleRetry').mockResolvedValue(undefined);
    const ensureReportForCompletion = vi.fn().mockResolvedValue(undefined);
    const setCompleted = vi.fn().mockResolvedValue(true);

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion,
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted,
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'validation phase is complete' });

    const updated = store.get(session.id);
    expect(ensureReportForCompletion).not.toHaveBeenCalled();
    expect(setCompleted).not.toHaveBeenCalled();
    expect(updated?.completed).not.toBe(true);
    expect((updated?.flags?.session as Record<string, unknown> | undefined)?.completed).not.toBe(true);
    expect(scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('submit_phase_handoff'),
        reason: expect.stringContaining('phase_handoff_missing'),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'session.status',
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  it('stops accepted non-reporting phase handoffs and marks the phase session completed', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-4',
      scopeId: 'scope-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
          activePhaseId: 'phase-validation',
          activePhaseKey: 'validation',
          phaseHandoffSubmitted: true,
          phaseHandoffStatus: 'completed',
        },
      },
    });
    startProcessing(session, { reason: 'test_phase_handoff_submitted', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing.phase_handoff_submitted');

    const events: Array<{ type: string; data?: any }> = [];
    const turnStream = new StreamBroker((event) => events.push(event));
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 1,
        toolCallsRequested: 1,
        messagesLength: 0,
        metrics: undefined,
        usage: undefined,
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: true }),
    };
    const automationGuardHandler = new AutomationGuardHandler({
      sessionStore: store as any,
      automationPolicy: new AutomationModePolicy(),
    });
    const scheduleRetry = vi.spyOn(automationGuardHandler, 'scheduleRetry').mockResolvedValue(undefined);
    const ensureReportForCompletion = vi.fn().mockResolvedValue(undefined);
    const setCompleted = vi.fn().mockResolvedValue(true);

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion,
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted,
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'handoff accepted' });

    const updated = store.get(session.id);
    expect(ensureReportForCompletion).not.toHaveBeenCalled();
    expect(setCompleted).toHaveBeenCalledWith(session.id, true);
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(updated?.completed).toBe(true);
    expect((updated?.flags?.session as Record<string, unknown> | undefined)?.completed).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.status',
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  it('pauses the run instead of marking completion when closeout reconciliation stays interim', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      modelName: 'gpt-4',
      scopeId: 'scope-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
    });
    startProcessing(session, { reason: 'test_closeout_pause', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing.closeout_pause');

    const events: Array<{ type: string; data?: any }> = [];
    const turnStream = new StreamBroker((event) => events.push(event));
    const setCompleted = vi.fn().mockResolvedValue(true);
    const setBlockedReasonIfClear = vi.fn().mockResolvedValue(true);
    const recordCloseoutRequested = vi.spyOn(store, 'recordCloseoutRequestedAsync');
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 0,
        metrics: undefined,
        usage: undefined,
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: true }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setBlockedReasonIfClear,
        setCompleted,
      },
      runCloseoutReconciler: {
        reconcileAutomatedRunCloseout: vi.fn().mockResolvedValue({
          outcome: 'paused',
          mode: 'interim',
          reason: '1 plan step is not completed',
          runCompletion: {
            state: 'not_ready',
            ready: false,
            reasons: ['1 plan step is not completed'],
            incompletePlanSteps: [{ id: 'task-1', title: 'Finish evidence', status: 'running' }],
            unresolvedPromotableFindings: [],
            finalized: false,
          },
        }),
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'complete the run' });

    const updated = store.get(session.id);
    expect(setCompleted).not.toHaveBeenCalled();
    expect(recordCloseoutRequested).toHaveBeenCalledWith(
      session.id,
      '1 plan step is not completed',
      expect.any(Date),
      'turn-1',
    );
    expect(setBlockedReasonIfClear).toHaveBeenCalledWith(
      session.id,
      'system_paused',
      expect.objectContaining({ code: 'closeout_pending', reason: 'system_paused' }),
    );
    expect(updated?.completed).toBe(false);
    expect(updated?.blockedReason).toBe('system_paused');
    expect((updated?.flags?.securityops as Record<string, unknown> | undefined)?.finalizedMode).toBe('interim');
  });

  it('does not mark the session completed while live background sidecars still exist', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4', agentType: 'executor' });
    session.workerTasks = [
      {
        taskId: 'task-sidecar',
        parentSessionId: session.id,
        workerSessionId: 'worker-1',
        workerType: 'recon_worker',
        status: 'running',
        reason: 'Parallel recon branch',
        task: 'Map the surface',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
        continuationMode: 'spawn',
        createdAt: Date.now(),
      } as any,
    ];
    startProcessing(session, { reason: 'test_completion_live_sidecars', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing.live_sidecars');

    const turnStream = new StreamBroker(() => undefined);
    const setCompleted = vi.fn().mockResolvedValue(true);
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 0,
        metrics: undefined,
        usage: undefined,
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: true }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: vi.fn(),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted,
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'complete the run' });

    const updated = store.get(session.id);
    expect(updated?.completed).not.toBe(true);
    expect((updated?.flags?.session as Record<string, unknown> | undefined)?.completed).not.toBe(true);
    expect(setCompleted).not.toHaveBeenCalled();
  });

  it('cleans up a finalized run workspace only after closeout artifacts are flushed', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4', agentType: 'executor' });
    session.flags = {
      ...(session.flags ?? {}),
      securityops: {
        runId: 'run-finalized-1',
        activePhaseKey: 'reporting',
      },
    };
    startProcessing(session, { reason: 'test_finalized_cleanup', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing.finalized_cleanup');

    const cleanupRunWorkspaceAsync = vi.spyOn(store, 'cleanupRunWorkspaceAsync').mockResolvedValue({
      cleaned: true,
      workspaceDirs: ['/tmp/ns-run-run-finalized-1'],
      activeSessionIds: [],
      errors: 0,
    });
    const turnStream = new StreamBroker(() => undefined);
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockImplementation(async () => {
        const liveSession = store.get(session.id) ?? session;
        liveSession.completed = true;
        liveSession.flags = {
          ...(liveSession.flags ?? {}),
          session: {
            ...((liveSession.flags?.session as Record<string, unknown> | undefined) ?? {}),
            completed: true,
          },
          securityops: {
            ...((liveSession.flags?.securityops as Record<string, unknown> | undefined) ?? {}),
            runId: 'run-finalized-1',
            activePhaseKey: 'reporting',
            artifactsFinalizedAt: '2026-06-02T17:20:30.000Z',
            finalizedMode: 'interim',
            runCompletion: { state: 'completed' },
          },
        };
        await store.setAsync(session.id, liveSession, 'test.finalize_run_during_turn');
        return {
          status: 'completed',
          doneEmitted: false,
          toolCallCount: 0,
          toolCallsRequested: 0,
          messagesLength: 0,
          metrics: undefined,
          usage: undefined,
        };
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: true }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: vi.fn(),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted: vi.fn().mockResolvedValue(true),
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'finish report' });

    expect(pipeline.flushArtifacts).toHaveBeenCalled();
    expect(cleanupRunWorkspaceAsync).toHaveBeenCalledWith('run-finalized-1', {
      reason: 'run_finalized_artifacts_persisted',
    });
    expect(cleanupRunWorkspaceAsync.mock.invocationCallOrder[0]).toBeGreaterThan(
      pipeline.flushArtifacts.mock.invocationCallOrder[0],
    );
  });

  it('writes aggregated billing metrics into turn.complete', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-5.4' });
    startProcessing(session, { reason: 'test_completion', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing');

    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const turnStream = new StreamBroker(() => undefined);
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 2,
        usage: {
          promptTokens: 5,
          completionTokens: 2,
          totalTokens: 7,
        },
        metrics: {
          llmInputTokens: 25,
          llmOutputTokens: 10,
          llmCachedTokens: 5,
          llmLatencyMs: 123,
          llmCallCount: 2,
          tools: [],
          skippedToolCalls: 0,
          totalToolLatencyMs: 0,
          costUsd: 0.02,
          nativeCostUsd: 0.01,
          overheadUsd: 0.0015,
          platformCostUsd: 0.0115,
          platformPriceUsd: 0.023,
          creditsUsed: 2.3,
          currency: 'usd',
        },
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: false }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: vi.fn(),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted: vi.fn().mockResolvedValue(true),
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'complete the run' });

    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'turn.complete',
        payload: expect.objectContaining({
          tokens: {
            input: 25,
            output: 10,
            cached: 5,
            total: 35,
          },
          costUsd: 0.02,
          nativeCostUsd: 0.01,
          overheadUsd: 0.0015,
          platformCostUsd: 0.0115,
          platformPriceUsd: 0.023,
          creditsUsed: 2.3,
          currency: 'usd',
        }),
      }),
    );
  });

  it('passes the worker-specific tool budget into prompt building and turn execution', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-5.4' });
    session.coordination = {
      role: 'worker',
      maxToolCalls: 2,
    };
    startProcessing(session, { reason: 'test_worker_budget', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing');

    const turnStream = new StreamBroker(() => undefined);
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockResolvedValue({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 0,
        metrics: undefined,
        usage: undefined,
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: false, hasReport: false }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: vi.fn(),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted: vi.fn().mockResolvedValue(true),
      },
    });

    await command.execute({ sessionId: session.id, userInput: 'continue worker task' });

    expect(pipeline.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolCalls: 2 }),
    );
    expect(pipeline.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolCalls: 2 }),
    );
  });

  it('skips report completion enforcement for worker sessions', async () => {
    const session = await store.create({
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
      },
    });
    startProcessing(session, { reason: 'test_worker_completion', turnNumber: 0, caller: 'test' });
    await store.setAsync(session.id, session, 'test.start_processing');

    const turnStream = new StreamBroker(() => undefined);
    const artifactService = {
      ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
    };
    const sessionRepository = {
      clearBlockedReason: vi.fn().mockResolvedValue(true),
      getBlockedReason: vi.fn().mockResolvedValue(null),
      setBlockedReason: vi.fn().mockResolvedValue(true),
      setCompleted: vi.fn().mockResolvedValue(true),
    };
    const pipeline = {
      prepareSession: vi.fn().mockResolvedValue({
        sessionState: session,
        turnNumber: 1,
        turnController: new AbortController(),
        turnStream,
        initialPendingPlanStepIds: new Set<string>(),
        recorder: undefined,
      }),
      buildPrompt: vi.fn().mockResolvedValue({
        contextEnvelope: { hard: '', soft: '' },
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 0,
          contextWindow: 1000,
          maxHistoryTokens: 100,
          percentUsed: 0,
        },
      }),
      executeTurn: vi.fn().mockImplementation(async () => {
        const live = store.get(session.id)!;
        live.workerResult = {
          taskId: 'task-1',
          workerType: 'recon_worker',
          summary: 'Worker gathered the requested surface map.',
          findings: ['Mapped target routes'],
          evidenceRefs: ['http://target.local/login'],
          touchedTargets: ['/login'],
          confidence: 0.8,
        };
        live.completed = true;
        live.flags = {
          ...(live.flags ?? {}),
          session: { completed: true },
        };
        await store.setAsync(live.id, live, 'test.worker.completed');
        return {
          status: 'completed',
          doneEmitted: false,
          toolCallCount: 1,
          toolCallsRequested: 1,
          messagesLength: 0,
          metrics: undefined,
          usage: undefined,
        };
      }),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasSummary: false, hasReport: false }),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: vi.fn(),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      traceRecorder: undefined,
      ...createHotPathDeps(pipeline),
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      preTurnChecks: {
        execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
      } as any,
      turnErrorHandler: {
        handleAbort: vi.fn(),
        handleError: vi.fn(),
      } as any,
      automationGuardHandler: {
        handle: vi.fn().mockResolvedValue({
          suppressDone: false,
          scheduleAutoRetry: false,
          exhausted: false,
        }),
        applyModeSwitch: vi.fn().mockResolvedValue(undefined),
        evaluateContinuation: vi.fn().mockResolvedValue(false),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
      } as any,
      turnFailurePolicy: {
        handleError: vi.fn(),
        clearRetryState: vi.fn(),
      } as any,
      artifactService: {
        flush: pipeline.flushArtifacts,
        ...artifactService,
      } as any,
      sandboxHealthChecker: undefined,
      notificationPort: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository,
    });

    await command.execute({ sessionId: session.id, userInput: 'finish the delegated task' });

    expect(artifactService.ensureReportForCompletion).not.toHaveBeenCalled();
    expect(sessionRepository.setCompleted).not.toHaveBeenCalled();
    const updated = store.get(session.id);
    expect(updated?.workerResult?.summary).toBe('Worker gathered the requested surface map.');
    expect(updated?.completed).toBe(true);
  });
});
