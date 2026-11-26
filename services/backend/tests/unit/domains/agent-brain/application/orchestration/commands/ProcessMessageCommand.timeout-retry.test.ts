import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { StreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import { ProcessMessageCommand } from '@/domains/agent-brain/application/orchestration/commands/ProcessMessageCommand';
import { TurnErrorHandler } from '@/domains/agent-brain/application/orchestration/services/TurnErrorHandler';
import { TurnFailurePolicy } from '@/domains/agent-brain/application/orchestration/services/TurnFailurePolicy';
import { ERROR_CODES } from '@null-ai/contracts';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import { SessionLifecycleService } from '@/domains/agent-brain/application/services/SessionLifecycleService';

describe('ProcessMessageCommand timeout retry', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  afterEach(() => {
    store.shutdown();
  });

  it('schedules retry and keeps session unblocked for timeout errors', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4' });
    const stopSpy = vi.spyOn(session.stateMachine!, 'stopProcessing');
    const events: Array<{ type: string; data?: unknown }> = [];
    const turnStream = new StreamBroker((event) => events.push(event));
    const eventPublisher = {
      emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
      subscribe: () => () => undefined,
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };

    const timeoutError = new AppError(ERROR_CODES.LLM_TIMEOUT, 'Request timed out.');

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
      executeTurn: vi.fn().mockRejectedValue(timeoutError),
      reconcilePlan: vi.fn().mockResolvedValue({ pendingSteps: [] }),
      flushArtifacts: vi.fn().mockResolvedValue({ hasReport: false }),
    };

    const preTurnChecks = {
      execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }),
    };

    const automationGuardHandler = {
      handle: vi.fn().mockResolvedValue({ suppressDone: false, scheduleAutoRetry: false, exhausted: false }),
      applyModeSwitch: vi.fn().mockResolvedValue(undefined),
      evaluateContinuation: vi.fn().mockResolvedValue(false),
      scheduleRetry: vi.fn().mockResolvedValue(undefined),
    };
    const retryScheduler = {
      scheduleRetry: vi.fn().mockResolvedValue(undefined),
    };

    const sessionRepository = {
      setBlockedReason: vi.fn().mockResolvedValue(true),
    };
    const sessionLifecycle = SessionLifecycleService.forOrchestration({
      sessionStore: store,
      sessionRepository,
    });

    const turnFailurePolicy = new TurnFailurePolicy({
      sessionStore: store,
      sessionLifecycle,
      retryScheduler: retryScheduler as any,
    });

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: eventPublisher,
      traceRecorder: undefined,
      prepareStage: { run: pipeline.prepareSession } as any,
      buildStage: { run: pipeline.buildPrompt } as any,
      reconcileStage: { run: pipeline.reconcilePlan } as any,
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      turnExecutor: {
        runTurn: pipeline.executeTurn,
        setModel: vi.fn(),
        setModelName: vi.fn(),
      } as any,
      preTurnChecks: preTurnChecks as any,
      turnErrorHandler: new TurnErrorHandler({ sessionStore: store }),
      automationGuardHandler: automationGuardHandler as any,
      turnFailurePolicy,
      artifactService: {
        flush: pipeline.flushArtifacts,
      } as any,
      sandboxHealthChecker: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: sessionRepository as any,
    });

    await command.execute({ sessionId: session.id, userInput: 'hello' });

    expect(retryScheduler.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `error_retry:${ERROR_CODES.LLM_TIMEOUT}`,
      }),
    );
    expect(sessionRepository.setBlockedReason).not.toHaveBeenCalled();

    const updated = store.get(session.id);
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.flags?.error_retry?.retryCount).toBe(1);
    expect(stopSpy).not.toHaveBeenCalled();

    const retryWarning = events.find(
      (event) => event.type === 'warning' && (event.data as { code?: string })?.code === 'llm_retry',
    );
    expect(retryWarning).toBeDefined();
  });
});
