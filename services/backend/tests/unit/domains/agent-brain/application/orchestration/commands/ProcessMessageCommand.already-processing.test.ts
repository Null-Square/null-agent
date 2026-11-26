import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { ProcessMessageCommand } from '@/domains/agent-brain/application/orchestration/commands/ProcessMessageCommand';
import { startProcessing, stopProcessing } from '@/domains/agent-brain/application/orchestration/utils/sessionProcessing';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

describe('ProcessMessageCommand session_already_processing', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  afterEach(() => {
    store.shutdown();
  });

  it('treats session_already_processing as a benign no-op and does not stop the in-flight turn', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4' });

    // Simulate an already-in-flight turn: this is the turn we must not disrupt.
    startProcessing(session, { reason: 'test_in_flight', turnNumber: 0, caller: 'test' });

    const events: Array<{ type: string; data?: unknown }> = [];
    const eventPublisher = {
      emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
      subscribe: () => () => undefined,
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };

    const pipeline = {
      prepareSession: vi.fn().mockRejectedValue(new Error('session_already_processing')),
    };

    const turnErrorHandler = {
      handleAbort: vi.fn(),
      handleError: vi.fn(),
    };

    const turnFailurePolicy = {
      handleError: vi.fn(),
      clearRetryState: vi.fn(),
    };

    const clearCurrentTurnSpy = vi.spyOn(store, 'clearCurrentTurnAsync');

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: eventPublisher as any,
      traceRecorder: undefined,
      prepareStage: { run: pipeline.prepareSession } as any,
      buildStage: { run: vi.fn() } as any,
      reconcileStage: { run: vi.fn() } as any,
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      turnExecutor: {} as any,
      preTurnChecks: {} as any,
      turnErrorHandler: turnErrorHandler as any,
      automationGuardHandler: {} as any,
      turnFailurePolicy: turnFailurePolicy as any,
      artifactService: { flush: vi.fn() } as any,
      sandboxHealthChecker: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: undefined,
    });

    await expect(command.execute({ sessionId: session.id, userInput: 'hi' })).resolves.toBeUndefined();

    // Should not treat this as an error path.
    expect(turnErrorHandler.handleError).not.toHaveBeenCalled();
    expect(turnFailurePolicy.handleError).not.toHaveBeenCalled();

    // Critically: should skip cleanup so we don't stop the real in-flight turn.
    expect(clearCurrentTurnSpy).not.toHaveBeenCalled();
    expect(store.get(session.id)?.stateMachine?.isProcessing()).toBe(true);

    // But we do want UI feedback when a user spam-clicks.
    const warning = events.find((event) => event.type === 'warning');
    expect(warning).toEqual(
      expect.objectContaining({
        type: 'warning',
        data: expect.objectContaining({ code: 'session_already_processing' }),
      }),
    );
  });

  it('does not emit warning when userInput is empty (automation/resume)', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4' });

    startProcessing(session, { reason: 'test_in_flight', turnNumber: 0, caller: 'test' });

    const events: Array<{ type: string; data?: unknown }> = [];
    const eventPublisher = {
      emit: (_sessionId: string, event: { type: string; data?: unknown }) => events.push(event),
      subscribe: () => () => undefined,
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };

    const pipeline = {
      prepareSession: vi.fn().mockRejectedValue(new Error('session_already_processing')),
    };

    const clearCurrentTurnSpy = vi.spyOn(store, 'clearCurrentTurnAsync');

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: eventPublisher as any,
      traceRecorder: undefined,
      prepareStage: { run: pipeline.prepareSession } as any,
      buildStage: { run: vi.fn() } as any,
      reconcileStage: { run: vi.fn() } as any,
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      turnExecutor: {} as any,
      preTurnChecks: {} as any,
      turnErrorHandler: {} as any,
      automationGuardHandler: {} as any,
      turnFailurePolicy: { handleError: vi.fn(), clearRetryState: vi.fn() } as any,
      artifactService: {} as any,
      sandboxHealthChecker: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: undefined,
    });

    await expect(command.execute({ sessionId: session.id, userInput: '' })).resolves.toBeUndefined();

    expect(clearCurrentTurnSpy).not.toHaveBeenCalled();
    expect(store.get(session.id)?.stateMachine?.isProcessing()).toBe(true);
    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
  });

  it('propagates a busy local turn so a claimed durable continuation is retried', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4' });
    startProcessing(session, { reason: 'test_in_flight', turnNumber: 0, caller: 'test' });

    const clearCurrentTurnSpy = vi.spyOn(store, 'clearCurrentTurnAsync');
    const sessionRepository = {
      acquireExecutionClaim: vi.fn(async () => true),
      renewExecutionClaim: vi.fn(async () => true),
      ownsExecutionClaim: vi.fn(async () => true),
      releaseExecutionClaim: vi.fn(async () => true),
      getBlockedReason: vi.fn(async () => null),
      clearBlockedReason: vi.fn(async () => true),
      setBlockedReason: vi.fn(async () => true),
      setCompleted: vi.fn(async () => true),
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
      prepareStage: { run: vi.fn().mockRejectedValue(new Error('session_already_processing')) } as any,
      buildStage: { run: vi.fn() } as any,
      reconcileStage: { run: vi.fn() } as any,
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      turnExecutor: {} as any,
      preTurnChecks: {} as any,
      turnErrorHandler: {} as any,
      automationGuardHandler: {} as any,
      turnFailurePolicy: { handleError: vi.fn(), clearRetryState: vi.fn() } as any,
      artifactService: {} as any,
      sandboxHealthChecker: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository,
    });

    await expect(command.execute({
      sessionId: session.id,
      userInput: '',
      executionClaimToken: 'recovery-claim',
      retainExecutionClaim: true,
    })).rejects.toThrow('session_already_processing');

    expect(clearCurrentTurnSpy).not.toHaveBeenCalled();
    expect(sessionRepository.releaseExecutionClaim).not.toHaveBeenCalled();
  });

  it('clears a resumable blocked reason without injecting a second recovery instruction', async () => {
    const session = await store.create({ mode: 'automated', modelName: 'gpt-4' });
    session.blockedReason = 'awaiting_user';
    await store.setAsync(session.id, session, 'test.awaiting_user');

    const sessionRepository = {
      getBlockedReason: vi.fn().mockResolvedValue('awaiting_user'),
      clearBlockedReason: vi.fn().mockResolvedValue(true),
      setBlockedReason: vi.fn(),
      setCompleted: vi.fn(),
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
      prepareStage: {
        run: vi.fn().mockRejectedValue(new Error('session_already_processing')),
      } as any,
      buildStage: { run: vi.fn() } as any,
      reconcileStage: { run: vi.fn() } as any,
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      turnExecutor: {} as any,
      preTurnChecks: {} as any,
      turnErrorHandler: {} as any,
      automationGuardHandler: {} as any,
      turnFailurePolicy: { handleError: vi.fn(), clearRetryState: vi.fn() } as any,
      artifactService: { flush: vi.fn() } as any,
      sandboxHealthChecker: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository,
    });

    await expect(command.execute({ sessionId: session.id, userInput: 'continue' })).resolves.toBeUndefined();

    const updated = store.get(session.id);
    expect(sessionRepository.clearBlockedReason).toHaveBeenCalledWith(session.id, 'awaiting_user');
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.flags.ephemeralNudge).toBeUndefined();
  });

  it('skips duplicate finally cleanup when the session was already paused externally', async () => {
    const session = await store.create({ mode: 'interactive', modelName: 'gpt-4' });
    startProcessing(session, { reason: 'test_in_flight', turnNumber: 0, caller: 'test' });
    stopProcessing(session, { reason: 'user_paused', turnNumber: 0, caller: 'test.abort' });
    session.blockedReason = 'user_paused';
    await store.setAsync(session.id, session, 'test.user_paused');

    const stopSpy = vi.spyOn(session.stateMachine!, 'stopProcessing');
    const eventPublisher = {
      emit: vi.fn(),
      subscribe: () => () => undefined,
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };

    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: eventPublisher as any,
      traceRecorder: undefined,
      prepareStage: { run: vi.fn() } as any,
      buildStage: { run: vi.fn() } as any,
      reconcileStage: { run: vi.fn() } as any,
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      turnExecutor: {} as any,
      preTurnChecks: {} as any,
      turnErrorHandler: {} as any,
      automationGuardHandler: {} as any,
      turnFailurePolicy: { clearRetryState: vi.fn(), handleError: vi.fn() } as any,
      artifactService: { flush: vi.fn() } as any,
      sandboxHealthChecker: undefined,
      getProvider: async () => ({ name: 'openai', supportsCacheControl: () => false } as any),
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: undefined,
    });

    await (command as any).cleanup(session.id, Date.now() - 10, 'abort');

    expect(stopSpy).not.toHaveBeenCalled();
    expect(eventPublisher.emit).not.toHaveBeenCalled();
    expect(store.get(session.id)?.blockedReason).toBe('user_paused');
    expect(store.get(session.id)?.stateMachine?.getState()).toBe('idle');
  });
});

