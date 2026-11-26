import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@null-ai/contracts';

import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ProcessMessageCommand } from '@/domains/agent-brain/application/orchestration/commands/ProcessMessageCommand';
import { StreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const prompt = (transformationId?: string) => ({
  contextEnvelope: { hard: '', soft: '' },
  systemMessages: [],
  historyMessages: [],
  toolDefinitions: [],
  contextMeasurementHints: {
    capacitySource: 'model_config',
    reducerProfile: 'pentest',
    reducerReason: transformationId ? 'provider_context_overflow' : 'request_measurement',
    transformationId,
  },
  transformationRefs: transformationId ? [transformationId] : [],
  contextEstimate: {
    estimatedTokens: 70_000,
    contextWindow: 100_000,
    maxHistoryTokens: 60_000,
    percentUsed: 70,
  },
  ...(transformationId
    ? {
        compactionResult: {
          beforeTokens: 95_000,
          afterTokens: 45_000,
          messagesSummarized: 6,
          findingsPreserved: 1,
          techniquesPreserved: 1,
          approachesPreserved: 1,
          credentialsPreserved: 0,
          openStepsPreserved: 1,
          discoveriesPreserved: 1,
          constraintsPreserved: 1,
          compactionVersion: 1,
        },
      }
    : {}),
});

const overflow = (requestId: string) => Object.assign(
  new AppError(ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED, 'provider rejected context'),
  { modelRequestId: requestId },
);

describe('ProcessMessageCommand bounded context-overflow recovery', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  afterEach(() => {
    store.shutdown();
  });

  const createHarness = async (runTurn: ReturnType<typeof vi.fn>) => {
    const session = await store.create({ mode: 'automated', modelName: 'fixture-model' });
    session.modelContextWindow = 100_000;
    session.messages.push({
      id: 'user-stable-1',
      role: 'user',
      content: 'preserve this stable message',
      timestamp: 1,
    });
    const turnStream = new StreamBroker(() => undefined);
    const buildPrompt = vi.fn()
      .mockResolvedValueOnce(prompt())
      .mockResolvedValueOnce(prompt('history:overflow-transaction'));
    const handleError = vi.fn().mockResolvedValue(undefined);
    const command = new ProcessMessageCommand({
      sessionStore: store,
      events: {
        emit: vi.fn(),
        subscribe: () => () => undefined,
        emitPlan: vi.fn(),
        cleanup: vi.fn(),
      } as any,
      prepareStage: {
        run: vi.fn().mockResolvedValue({
          sessionState: session,
          turnNumber: 1,
          turnController: new AbortController(),
          turnStream,
          initialPendingPlanStepIds: new Set<string>(),
        }),
      } as any,
      buildStage: { run: buildPrompt } as any,
      reconcileStage: { run: vi.fn().mockResolvedValue({ pendingSteps: [] }) } as any,
      contextProvider: {} as any,
      cacheCoordinator: {} as any,
      toolsRegistry: { getToolSchemas: () => [] } as any,
      policyResolver: {} as any,
      promptBuilder: {} as any,
      turnExecutor: {
        runTurn,
        executeModelCall: vi.fn(),
        setModel: vi.fn(),
        setModelName: vi.fn(),
      } as any,
      preTurnChecks: { execute: vi.fn().mockResolvedValue({ proceed: true, warnings: [] }) } as any,
      turnErrorHandler: {
        handleAbort: vi.fn().mockResolvedValue({ status: 'abort', doneEmitted: false }),
        handleError: vi.fn().mockResolvedValue({ status: 'error' }),
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
      turnFailurePolicy: { handleError, clearRetryState: vi.fn() } as any,
      artifactService: {
        flush: vi.fn().mockResolvedValue({ hasSummary: true, hasReport: true }),
        ensureReportForCompletion: vi.fn().mockResolvedValue(undefined),
      } as any,
      getProvider: async () => ({ name: 'fixture-provider' }) as any,
      getModelStream: async () => ({}) as any,
      maxToolCalls: 5,
      convertMessages: (messages) => messages as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      sessionRepository: {
        clearBlockedReason: vi.fn().mockResolvedValue(true),
        getBlockedReason: vi.fn().mockResolvedValue(null),
        setBlockedReason: vi.fn().mockResolvedValue(true),
        setCompleted: vi.fn().mockResolvedValue(true),
      } as any,
      historyTransformationPort: {} as any,
    });
    return { command, session, buildPrompt, handleError };
  };

  it('commits one reduction and links exactly one redispatch to the failed request', async () => {
    const runTurn = vi.fn()
      .mockRejectedValueOnce(overflow('request-before-overflow'))
      .mockResolvedValueOnce({
        status: 'completed',
        doneEmitted: false,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 1,
      });
    const { command, session, buildPrompt, handleError } = await createHarness(runTurn);

    await command.execute({ sessionId: session.id, userInput: 'continue' });

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(buildPrompt).toHaveBeenCalledTimes(2);
    expect(buildPrompt.mock.calls[1]?.[0]).toMatchObject({
      compactionReason: 'provider_context_overflow',
      triggerRequestId: 'request-before-overflow',
    });
    expect(runTurn.mock.calls[1]?.[0]).toMatchObject({
      transformationRefs: ['history:overflow-transaction'],
      contextMeasurementHints: expect.objectContaining({
        transformationId: 'history:overflow-transaction',
      }),
    });
    expect(handleError).not.toHaveBeenCalled();
  });

  it('stops on a second typed overflow without measuring or dispatching a third time', async () => {
    const runTurn = vi.fn()
      .mockRejectedValueOnce(overflow('request-1'))
      .mockRejectedValueOnce(overflow('request-2'));
    const { command, session, buildPrompt, handleError } = await createHarness(runTurn);

    await command.execute({ sessionId: session.id, userInput: 'continue' });

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(buildPrompt).toHaveBeenCalledTimes(2);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[1]?.[0].transformationRefs).toEqual([
      'history:overflow-transaction',
    ]);
  });
});
