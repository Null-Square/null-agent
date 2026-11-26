import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Message } from '@/domains/agent-brain/domain/types';

// Use vi.hoisted() to create mocks that will be available to vi.mock factories
const mocks = vi.hoisted(() => {
  return {
    mockStreamRun: vi.fn(),
    mockToolRun: vi.fn(),
    mockUsageSetModelName: vi.fn(),
    mockUsageRecordUsage: vi.fn(),
  };
});

// Mock the modules using class-based pattern for proper instance method binding
vi.mock('@/domains/agent-brain/application/orchestration/execution/TurnStreamController', () => {
  return {
    TurnStreamController: class MockTurnStreamController {
      run = mocks.mockStreamRun;
      setModel = vi.fn();
    },
  };
});

vi.mock('@/domains/agent-brain/application/orchestration/execution/TurnToolExecutor', () => {
  return {
    TurnToolExecutor: class MockTurnToolExecutor {
      run = mocks.mockToolRun;
    },
  };
});

vi.mock('@/domains/agent-brain/infrastructure/usage/UsageRecorder', () => {
  return {
    UsageRecorder: class MockUsageRecorder {
      setModelName = mocks.mockUsageSetModelName;
      recordUsage = mocks.mockUsageRecordUsage;
    },
  };
});

// Import AFTER mocks are set up
import { TurnRunner } from '@/domains/agent-brain/application/orchestration/execution/TurnRunner';

const createSessionStore = (
  session: {
    messages: Message[];
    plan?: Array<Record<string, unknown>>;
    currentPlanStepId?: string;
    checkpoints?: Record<string, unknown>;
    lastCheckpoint?: { id: string; ts?: string };
    stateMachine?: { isProcessing: () => boolean };
    pendingApproval?: unknown;
  },
) => ({
  get: vi.fn(() => session),
  setAsync: vi.fn(),
  appendMessagesAsync: vi.fn(),
  updatePlanAsync: vi.fn(async (_id: string, plan: any[]) => {
    session.plan = plan;
  }),
  updatePlanStepAsync: vi.fn(async (_id: string, stepId: string, updated: any) => {
    session.plan = (session.plan ?? []).map((step: any) => (step.id === stepId ? updated : step));
  }),
  updateCurrentPlanStepIdAsync: vi.fn(async (_id: string, stepId?: string) => {
    session.currentPlanStepId = stepId;
  }),
  heartbeat: vi.fn(),
  clearCurrentTurnAsync: vi.fn(),
  recordExecutionDeferredAsync: vi.fn(async () => false),
  recordSessionCompletedAsync: vi.fn(async () => false),
  queuePersistMetadata: vi.fn(),
});

const createStream = () => ({
  raw: vi.fn(),
  message: vi.fn(),
  token: vi.fn(),
  messageStart: vi.fn(),
  done: vi.fn(),
});

const testToolProgressKinds: Record<string, 'canonical' | 'evidence'> = {
  ingest_scan_artifact: 'canonical',
  promote_finding: 'canonical',
  report_asset: 'canonical',
  report_finding: 'canonical',
  report_note: 'canonical',
  report_service: 'canonical',
  submit_phase_checkpoint: 'canonical',
  submit_phase_handoff: 'canonical',
  submit_validation_lead_outcome: 'canonical',
  submit_validation_outcome: 'canonical',
  browser_action: 'evidence',
  http_differential: 'evidence',
  http_payload: 'evidence',
};

const createRunner = (options?: {
  maxToolCalls?: number;
  checkpointManager?: any;
  sessionRepository?: any;
  mode?: 'interactive' | 'automated';
}) => {
  // Mock stateMachine for state transitions
  const mockStateMachine = {
    isProcessing: vi.fn(() => true),
    startProcessing: vi.fn(() => true),
    stopProcessing: vi.fn(() => true),
    awaitUser: vi.fn(() => true),
    resumeProcessing: vi.fn(() => true),
    getState: vi.fn(() => 'processing' as const),
  };
  const session: any = {
    id: 'session-1',
    messages: [] as Message[],
    plan: [],
    checkpoints: {},
    currentPlanStepId: undefined,
    pendingApproval: undefined,
    mode: options?.mode ?? 'interactive',
    stateMachine: mockStateMachine,
  };
  const sessionStore = createSessionStore(session);
  const runner = new TurnRunner({
    model: {} as any,
    toolsRegistry: {
      getToolProgressKind: vi.fn((id: string) => testToolProgressKinds[id]),
    } as any,
    sessionStore: sessionStore as any,
    maxToolCalls: options?.maxToolCalls ?? 4,
    modelName: 'gpt-turn',
    checkpointManager: options?.checkpointManager,
    sessionRepository: options?.sessionRepository,
  });

  return { runner, session, sessionStore };
};

describe('TurnRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockStreamRun.mockResolvedValue({
      status: 'completed',
      toolCallCount: 0,
      messagesLength: 0,
      currentMessages: [],
      toolCalls: [],
      usage: undefined,
    });
  });

  it('calls ModelStream with combined system and history messages', async () => {
    const { runner } = createRunner();
    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 0,
      messagesLength: 2,
      currentMessages: [],
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });

    const stream = createStream();
    const systemMessages = [{ role: 'system', content: 'sys' } as any];
    const historyMessages = [{ role: 'user', content: 'hi' } as any];

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages,
      historyMessages,
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessages: [...systemMessages, ...historyMessages],
      }),
    );
  });

  it('emits active phase milestone names instead of hardcoded reporting completion', async () => {
    const { runner, session } = createRunner();
    session.flags = {
      securityops: {
        activePhaseId: 'phase-validation',
        activePhaseKey: 'validation',
      },
    };
    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'completed',
      assistantText: 'Validation turn complete.',
      toolCallCount: 0,
      messagesLength: 1,
      currentMessages: [],
      toolCalls: [],
      usage: undefined,
    });
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'milestone',
        payload: expect.objectContaining({ phase: 'validation', status: 'started' }),
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'milestone',
        payload: expect.objectContaining({ phase: 'validation', status: 'completed' }),
      }),
    );
  });

  it('retries an empty completion once before accepting a meaningful response', async () => {
    const { runner } = createRunner();
    const stream = createStream();

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: '',
        toolCallCount: 0,
        messagesLength: 0,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: 'All done.',
        toolCallCount: 0,
        messagesLength: 1,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    expect(result.toolCallCount).toBe(0);
    expect(result.toolCallsRequested).toBe(0);
  });

  it('retries chat responses that failed Mermaid validation before completing the turn', async () => {
    const { runner } = createRunner();
    const stream = createStream();
    const repairMessages = [
      { role: 'assistant', content: '```mermaid\nbroken\n```' },
      { role: 'user', content: 'NULLSQUARE_MERMAID_REPAIR_REQUEST fix it' },
    ];

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'retry_mermaid_validation',
        assistantText: '```mermaid\nbroken\n```',
        toolCallCount: 0,
        messagesLength: 0,
        currentMessages: repairMessages,
        toolCalls: [],
        usage: undefined,
        mermaidValidation: {
          attempts: 1,
          retryLimit: 2,
          blocks: 1,
          errors: 'block 1: invalid',
        },
      })
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: 'Fixed answer without a diagram.',
        toolCallCount: 0,
        messagesLength: 1,
        currentMessages: repairMessages,
        toolCalls: [],
        usage: undefined,
      });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(2);
    expect(mocks.mockStreamRun.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        currentMessages: repairMessages,
      }),
    );
    expect(result.status).toBe('completed');
  });

  it('nudges instead of deadlocking if Mermaid validation retries exceed the runner safety cap', async () => {
    const { runner, session } = createRunner();
    const stream = createStream();
    const repairMessages = [
      { role: 'assistant', content: '```mermaid\nbroken\n```' },
      { role: 'user', content: 'NULLSQUARE_MERMAID_REPAIR_REQUEST fix it' },
    ];

    mocks.mockStreamRun.mockResolvedValue({
      status: 'retry_mermaid_validation',
      assistantText: '```mermaid\nbroken\n```',
      toolCallCount: 0,
      messagesLength: 0,
      currentMessages: repairMessages,
      toolCalls: [],
      usage: undefined,
      mermaidValidation: {
        attempts: 1,
        retryLimit: 2,
        blocks: 1,
        errors: 'block 1: invalid',
      },
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('max_tool_calls');
    expect(session.blockedReason).toBeUndefined();
    expect(session.flags.recoverableGuard).toEqual(
      expect.objectContaining({
        nudgedAtTurn: 1,
        repairTurn: 2,
        triggerCount: 1,
        details: expect.objectContaining({
          reason: 'mermaid_validation_retry_exhausted',
        }),
      }),
    );
  });

  it('nudges instead of deadlocking after repeated empty completions hit the retry cap', async () => {
    const { runner, session } = createRunner();

    mocks.mockStreamRun.mockResolvedValue({
      status: 'completed',
      assistantText: '',
      toolCallCount: 0,
      messagesLength: 0,
      currentMessages: [],
      toolCalls: [],
      usage: undefined,
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('max_tool_calls');
    expect(result.toolCallCount).toBe(0);
    expect(session.blockedReason).toBeUndefined();
    expect(session.flags.recoverableGuard).toEqual(
      expect.objectContaining({
        nudgedAtTurn: 1,
        repairTurn: 2,
        triggerCount: 1,
        details: expect.objectContaining({
          reason: 'empty_completion_retry_exhausted',
        }),
      }),
    );
  });

  it('does not inject premature-stop correction after securityops artifacts are finalized', async () => {
    const { runner, session } = createRunner({ mode: 'automated' });
    session.flags = {
      securityops: {
        artifactsFinalizedAt: '2026-04-25T00:00:00.000Z',
      },
    } as any;

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'completed',
      assistantText: 'Interim artifacts already generated.',
      toolCallCount: 0,
      messagesLength: 1,
      currentMessages: [],
      toolCalls: [],
      usage: undefined,
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('does not inject premature-stop correction after a worker result was already submitted', async () => {
    const { runner, session } = createRunner({ mode: 'automated' });
    session.coordination = {
      role: 'worker',
      parentSessionId: 'parent-1',
      parentTaskId: 'task-1',
      workerType: 'recon_worker',
    };
    session.completed = true;
    session.workerResult = {
      taskId: 'task-1',
      workerType: 'recon_worker',
      summary: 'Done',
      findings: [],
      evidenceRefs: [],
      touchedTargets: [],
    };

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'completed',
      assistantText: 'RECON PHASE COMPLETE',
      toolCallCount: 0,
      messagesLength: 1,
      currentMessages: [],
      toolCalls: [],
      usage: undefined,
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('ends the turn immediately after submit_worker_result completes a worker', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 3, mode: 'automated' });
    session.coordination = {
      role: 'worker',
      parentSessionId: 'parent-1',
      parentTaskId: 'task-1',
      workerType: 'recon_worker',
    };
    const assistantMsg = { id: 'assistant-1', role: 'assistant', content: '' } as any;
    const toolMsg = { id: 'tool-1', role: 'tool', content: '{"success":true}' } as any;

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-1', function: { name: 'submit_worker_result', arguments: '{}' } }],
      pendingAssistantMessage: assistantMsg,
      currentMessages: [assistantMsg],
      toolCallCount: 1,
      usage: undefined,
    });

    mocks.mockToolRun.mockImplementationOnce(async () => {
      session.completed = true;
      session.workerResult = {
        taskId: 'task-1',
        workerType: 'recon_worker',
        summary: 'Done',
        findings: [],
        evidenceRefs: [],
        touchedTargets: [],
      };
      return {
        status: 'completed',
        toolCallCount: 1,
        collectedToolResults: [toolMsg],
        currentMessages: [toolMsg],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      };
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.toolCallCount).toBe(1);
  });

  it('ends the turn immediately after a non-reporting terminal phase handoff', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 3, mode: 'automated' });
    session.flags = {
      securityops: {
        activePhaseId: 'phase-recon',
        activePhaseKey: 'recon',
      },
    };
    const assistantMsg = { id: 'assistant-1', role: 'assistant', content: '' } as any;
    const toolMsg = { id: 'tool-1', role: 'tool', content: '{"success":true}' } as any;

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-1', function: { name: 'submit_phase_handoff', arguments: '{}' } }],
      pendingAssistantMessage: assistantMsg,
      currentMessages: [assistantMsg],
      toolCallCount: 1,
      usage: undefined,
    });

    mocks.mockToolRun.mockImplementationOnce(async () => {
      session.flags.securityops = {
        activePhaseId: 'phase-recon',
        activePhaseKey: 'recon',
        phaseHandoffSubmitted: true,
        phaseHandoffRef: '.artifacts/phase-handoffs/recon.json',
        phaseHandoffStatus: 'completed',
      };
      session.completed = true;
      session.flags.session = { completed: true };
      return {
        status: 'completed',
        toolCallCount: 1,
        collectedToolResults: [toolMsg],
        currentMessages: [toolMsg],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      };
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.toolCallCount).toBe(1);
  });

  it('processes tool calls and persists assistant + tool messages atomically', async () => {
    const { runner, sessionStore } = createRunner({ maxToolCalls: 3 });
    const assistantMsg = { id: 'assistant-1', role: 'assistant', content: 'use tool' } as any;
    const toolMsg = { id: 'tool-1', role: 'tool', content: 'result' } as any;

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [{ id: 'call-1', function: { name: 'file_read', arguments: '{}' } }],
        pendingAssistantMessage: assistantMsg,
        currentMessages: [assistantMsg],
        toolCallCount: 1,
        usage: undefined,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        toolCallCount: 0,
        messagesLength: 2,
        currentMessages: [assistantMsg, toolMsg],
        toolCalls: [],
        usage: undefined,
      });

    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 1,
      collectedToolResults: [toolMsg],
      currentMessages: [toolMsg],
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const stream = createStream();
    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(sessionStore.appendMessagesAsync).toHaveBeenCalledWith(
      'session-1',
      [assistantMsg, toolMsg],
    );
    expect(result.toolCallCount).toBe(1);
    expect(result.status).toBe('completed');
  });

  // E12 Slice E: reduction is reached through prompt pressure, not through the ordinary
  // quantized path. This fixture is deliberately large enough to cross the routed soft
  // threshold, which is the authority that bypasses the economic gate.
  it('compacts same-turn bulky tool results before the next model call', async () => {
    const { runner } = createRunner({ maxToolCalls: 12 });
    const toolCalls = Array.from({ length: 8 }, (_item, index) => ({
      id: `call-${index}`,
      function: { name: 'query_inventory', arguments: '{}' },
    }));
    const assistantWithToolCalls = {
      id: 'assistant-tools',
      role: 'assistant',
      content: '',
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: toolCall.function,
      })),
    } as any;
    const toolMessages = toolCalls.map((toolCall, index) => ({
      id: `tool-${index}`,
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        ok: true,
        data: {
          assets: Array.from({ length: 44 }, (_asset, assetIndex) => ({
            id: `asset-${index}-${assetIndex}`,
            value: `host-${assetIndex}.example.com`,
            filler: 'x'.repeat(1_500),
          })),
          leadCount: 0,
        },
      }),
    }));

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls,
        pendingAssistantMessage: assistantWithToolCalls,
        currentMessages: [{ role: 'user', content: 'start' }, assistantWithToolCalls],
        toolCallCount: toolCalls.length,
        usage: undefined,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: 'done',
        toolCallCount: 0,
        messagesLength: 9,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      });

    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: toolCalls.length,
      collectedToolResults: toolMessages,
      currentMessages: toolMessages,
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [{ role: 'user', content: 'start' } as any],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    const secondCallMessages = mocks.mockStreamRun.mock.calls[1]?.[0]?.currentMessages as any[];
    const compactedResults = secondCallMessages.filter(
      (message) =>
        message.role === 'tool' &&
        typeof message.content === 'string' &&
        message.content.includes('tool_result_compacted'),
    );
    const recentToolResult = secondCallMessages.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'call-7',
    );

    expect(compactedResults.length).toBeGreaterThan(0);
    expect(recentToolResult?.content).not.toContain('tool_result_compacted');
  });

  it('leaves a modest turn alone rather than rewriting a prefix it cannot pay for', async () => {
    // The shape of both production firings in run r1: real candidates, real saving, and
    // nowhere near enough remaining requests to earn back the cache reset. Under the routed
    // soft threshold there is no pressure authority, so the economic gate decides.
    const { runner } = createRunner({ maxToolCalls: 12 });
    const toolCalls = Array.from({ length: 8 }, (_item, index) => ({
      id: `call-${index}`,
      function: { name: 'query_inventory', arguments: '{}' },
    }));
    const assistantWithToolCalls = {
      id: 'assistant-tools',
      role: 'assistant',
      content: '',
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: toolCall.function,
      })),
    } as any;
    const toolMessages = toolCalls.map((toolCall, index) => ({
      id: `tool-${index}`,
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        ok: true,
        data: {
          assets: Array.from({ length: 44 }, (_asset, assetIndex) => ({
            id: `asset-${index}-${assetIndex}`,
            value: `host-${assetIndex}.example.com`,
            filler: 'x'.repeat(500),
          })),
          leadCount: 0,
        },
      }),
    }));

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls,
        pendingAssistantMessage: assistantWithToolCalls,
        currentMessages: [{ role: 'user', content: 'start' }, assistantWithToolCalls],
        toolCallCount: toolCalls.length,
        usage: undefined,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: 'done',
        toolCallCount: 0,
        messagesLength: 9,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      });

    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: toolCalls.length,
      collectedToolResults: toolMessages,
      currentMessages: toolMessages,
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [{ role: 'user', content: 'start' } as any],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    const secondCallMessages = mocks.mockStreamRun.mock.calls[1]?.[0]?.currentMessages as any[];
    const compactedResults = secondCallMessages.filter(
      (message) =>
        message.role === 'tool' &&
        typeof message.content === 'string' &&
        message.content.includes('tool_result_compacted'),
    );

    expect(compactedResults.length).toBe(0);
  });

  it('emits a per-phase tool invocation rollup from turn metrics', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 3, mode: 'automated' });
    session.flags = {
      securityops: {
        activePhaseKey: 'validation',
      },
    };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const pendingAssistantMessage = { id: 'assistant-1', role: 'assistant', content: 'validate' } as any;

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [
          { id: 'call-1', function: { name: 'file_read', arguments: '{}' } },
          { id: 'call-2', function: { name: 'http_payload', arguments: '{}' } },
        ],
        pendingAssistantMessage,
        currentMessages: [pendingAssistantMessage],
        toolCallCount: 2,
        usage: undefined,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: 'done',
        toolCallCount: 0,
        messagesLength: 3,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      });

    mocks.mockToolRun.mockImplementationOnce(async (args) => {
      args.metricsAccumulator.recordToolCall({ name: 'file_read', durationMs: 10, success: true });
      args.metricsAccumulator.recordToolCall({ name: 'http_payload', durationMs: 20, success: false });
      return {
        status: 'completed',
        toolCallCount: 2,
        collectedToolResults: [],
        currentMessages: [],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      };
    });

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'phase.tool_invocation_rollup',
        payload: expect.objectContaining({
          phase: 'validation',
          activePhaseKey: 'validation',
          status: 'completed',
          requestedToolCalls: 2,
          executedToolCalls: 2,
          successCount: 1,
          failureCount: 1,
          totalToolLatencyMs: 30,
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'file_read', calls: 1, success: 1 }),
            expect.objectContaining({ name: 'http_payload', calls: 1, failure: 1 }),
          ]),
        }),
      }),
    );
  });

  // D11/D12 - run r1 fired `phase_handoff_missing` six times and yielded reporting before
  // summary.md or report.md existed. A turn that owes an approved terminal call does not get
  // to stop for productivity reasons.
  it('holds the turn open when a completed plan still owes its phase handoff', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 20, mode: 'automated' });
    session.flags = { securityops: { activePhaseKey: 'validation' } };
    session.plan = [
      { id: 'task-1', status: 'completed' },
      { id: 'task-2', status: 'completed' },
    ] as never;
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    for (let index = 0; index < 4; index += 1) {
      const callId = `call-${index}`;
      const assistant = { id: `assistant-${index}`, role: 'assistant', content: 'next' } as any;
      mocks.mockStreamRun.mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [
          { id: `${callId}-1`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-2`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-3`, function: { name: 'query_notes', arguments: '{}' } },
        ],
        pendingAssistantMessage: assistant,
        currentMessages: [assistant],
        toolCallCount: 3,
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      });
      mocks.mockToolRun.mockResolvedValueOnce({
        status: 'completed',
        toolCallCount: 3,
        collectedToolResults: [],
        currentMessages: [],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      });
    }

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'context.terminal_obligation_outranks_yield',
        payload: expect.objectContaining({
          obligation: 'phase_handoff_missing',
          dischargeTool: 'submit_phase_handoff',
        }),
      }),
    );
    expect(String(session.flags.ephemeralNudge)).toContain('submit_phase_handoff');
  });

  it('yields anyway once the obligation grace is spent, so a stuck phase still ends', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 60, mode: 'automated' });
    session.flags = { securityops: { activePhaseKey: 'validation' } };
    session.plan = [{ id: 'task-1', status: 'completed' }] as never;
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    // Four model calls reach the low-yield stop (12 tool calls, three low-yield
    // continuations); the obligation then buys three more before the yield goes through.
    for (let index = 0; index < 10; index += 1) {
      const callId = `call-${index}`;
      const assistant = { id: `assistant-${index}`, role: 'assistant', content: 'next' } as any;
      mocks.mockStreamRun.mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [
          { id: `${callId}-1`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-2`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-3`, function: { name: 'query_notes', arguments: '{}' } },
        ],
        pendingAssistantMessage: assistant,
        currentMessages: [assistant],
        toolCallCount: 3,
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      });
      mocks.mockToolRun.mockResolvedValueOnce({
        status: 'completed',
        toolCallCount: 3,
        collectedToolResults: [],
        currentMessages: [],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      });
    }

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    // The obligation delays the yield; it never cancels it.
    expect(result.status).toBe('max_tool_calls');
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({ event: 'context.diminishing_returns_nudge' }),
    );
  });

  it('nudges automated low-yield continuations without deadlocking', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 20, mode: 'automated' });
    session.flags = {
      securityops: {
        activePhaseKey: 'validation',
      },
    };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    for (let index = 0; index < 4; index += 1) {
      const callId = `call-${index}`;
      const assistant = { id: `assistant-${index}`, role: 'assistant', content: 'next' } as any;
      mocks.mockStreamRun.mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [
          { id: `${callId}-1`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-2`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-3`, function: { name: 'query_notes', arguments: '{}' } },
        ],
        pendingAssistantMessage: assistant,
        currentMessages: [assistant],
        toolCallCount: 3,
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      });
      mocks.mockToolRun.mockResolvedValueOnce({
        status: 'completed',
        toolCallCount: 3,
        collectedToolResults: [],
        currentMessages: [],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      });
    }

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(result.toolCallCount).toBe(12);
    expect(session.flags.ephemeralNudge).toContain('DIMINISHING RETURNS REPAIR');
    expect(session.flags.diminishingReturns).toEqual(
      expect.objectContaining({
        nudgedAtTurn: 1,
        repairTurn: 2,
        triggerCount: 1,
      }),
    );
    expect(session.blockedReason).toBeUndefined();
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'context.diminishing_returns_nudge',
        payload: expect.objectContaining({
          action: 'repair_nudge',
          stopReason: 'low_yield_continuations',
          totalToolCalls: 12,
        }),
      }),
    );
  });

  it('does not classify missing provider usage as zero-token diminishing returns', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 12, mode: 'automated' });
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    for (let index = 0; index < 4; index += 1) {
      const assistant = { id: `assistant-${index}`, role: 'assistant', content: 'next' } as any;
      mocks.mockStreamRun.mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [
          { id: `call-${index}-1`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `call-${index}-2`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `call-${index}-3`, function: { name: 'query_notes', arguments: '{}' } },
        ],
        pendingAssistantMessage: assistant,
        currentMessages: [assistant],
        toolCallCount: 3,
        usage: undefined,
      });
      mocks.mockToolRun.mockResolvedValueOnce({
        status: 'completed',
        toolCallCount: 3,
        collectedToolResults: [],
        currentMessages: [],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      });
    }

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(result.toolCallCount).toBe(12);
    expect(session.flags?.diminishingReturns).toBeUndefined();
    expect(recorder.write).not.toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({ event: 'context.diminishing_returns_nudge' }),
    );
  });

  it('keeps low-yield repair escalation non-terminal even after the repair turn also stalls', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 20, mode: 'automated' });
    session.flags = {
      securityops: {
        activePhaseKey: 'validation',
      },
      diminishingReturns: {
        nudgedAtTurn: 0,
        repairTurn: 1,
        triggerCount: 1,
      },
    };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    for (let index = 0; index < 4; index += 1) {
      const callId = `call-${index}`;
      const assistant = { id: `assistant-${index}`, role: 'assistant', content: 'next' } as any;
      mocks.mockStreamRun.mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [
          { id: `${callId}-1`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-2`, function: { name: 'query_notes', arguments: '{}' } },
          { id: `${callId}-3`, function: { name: 'query_notes', arguments: '{}' } },
        ],
        pendingAssistantMessage: assistant,
        currentMessages: [assistant],
        toolCallCount: 3,
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      });
      mocks.mockToolRun.mockResolvedValueOnce({
        status: 'completed',
        toolCallCount: 3,
        collectedToolResults: [],
        currentMessages: [],
        skippedToolCalls: [],
        actionSummaries: [],
        discoveries: [],
        memoryUpdates: [],
      });
    }

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(result.toolCallCount).toBe(12);
    expect(session.blockedReason).toBeUndefined();
    expect(session.flags.ephemeralNudge).toContain('DIMINISHING RETURNS REPAIR');
    expect(session.flags.diminishingReturns).toEqual(
      expect.objectContaining({
        nudgedAtTurn: 1,
        repairTurn: 2,
        triggerCount: 2,
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'context.diminishing_returns_nudge',
        payload: expect.objectContaining({
          action: 'repair_nudge',
          stopReason: 'low_yield_continuations',
          totalToolCalls: 12,
        }),
      }),
    );
    expect(recorder.write).not.toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'context.diminishing_returns_stop',
      }),
    );
  });

  it('does not deadlock a repair turn after canonical progress is made', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 20, mode: 'automated' });
    session.flags = {
      securityops: {
        activePhaseKey: 'recon',
      },
      diminishingReturns: {
        nudgedAtTurn: 0,
        repairTurn: 1,
        triggerCount: 1,
      },
    };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    const batches = [
      {
        toolNames: ['report_finding', 'query_notes', 'query_notes'],
        actionSummaries: [
          {
            tool: 'report_finding',
            toolCallId: 'call-0-1',
            action: 'report_finding(title=OpenAPI exposed)',
            outcome: 'success',
            execution: 'succeeded',
            observation: 'not_applicable',
            durationMs: 10,
          },
        ],
      },
      { toolNames: ['query_notes', 'query_notes', 'query_notes'], actionSummaries: [] },
      { toolNames: ['query_notes', 'query_notes', 'query_notes'], actionSummaries: [] },
      { toolNames: ['query_notes', 'query_notes', 'query_notes'], actionSummaries: [] },
    ];

    batches.forEach((batch, index) => {
      const assistant = { id: `assistant-${index}`, role: 'assistant', content: 'next' } as any;
      mocks.mockStreamRun.mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: batch.toolNames.map((name, toolIndex) => ({
          id: `call-${index}-${toolIndex + 1}`,
          function: { name, arguments: '{}' },
        })),
        pendingAssistantMessage: assistant,
        currentMessages: [assistant],
        toolCallCount: 3,
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      });
      mocks.mockToolRun.mockResolvedValueOnce({
        status: 'completed',
        toolCallCount: 3,
        collectedToolResults: [],
        currentMessages: [],
        skippedToolCalls: [],
        actionSummaries: batch.actionSummaries,
        discoveries: [],
        memoryUpdates: [],
      });
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: recorder as any,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(result.toolCallCount).toBe(12);
    expect(session.blockedReason).toBeUndefined();
    expect(session.flags.diminishingReturns).toEqual(
      expect.objectContaining({
        nudgedAtTurn: 1,
        repairTurn: 2,
        triggerCount: 1,
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'context.diminishing_returns_repair_satisfied',
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'context.diminishing_returns_nudge',
        payload: expect.objectContaining({
          action: 'repair_nudge',
          totalToolCalls: 12,
        }),
      }),
    );
    expect(recorder.write).not.toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({
        event: 'context.diminishing_returns_stop',
      }),
    );
  });

  it('persists a lightweight heartbeat at turn start', async () => {
    const sessionRepository = {
      touches: [] as Array<{ id: string; timestamp: Date | undefined }>,
      touchLastActive: async function (this: { touches: Array<{ id: string; timestamp: Date | undefined }> }, id: string, timestamp?: Date) {
        this.touches.push({ id, timestamp });
      },
      setBlockedReason: vi.fn(async () => true),
    };
    const { runner } = createRunner({ sessionRepository });

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(sessionRepository.touches).toHaveLength(1);
    expect(sessionRepository.touches[0]).toEqual({
      id: 'session-1',
      timestamp: expect.any(Date),
    });
  });

  it('stops when maxToolCallsPerTurn is reached and emits summary message', async () => {
    const { runner } = createRunner({ maxToolCalls: 1, mode: 'interactive' });
    const stream = createStream();

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-1', function: { name: 'file_write', arguments: '{}' } }],
      pendingAssistantMessage: { id: 'assistant-1', role: 'assistant', content: 'doing work' },
      currentMessages: [],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(stream.message).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Tool call budget') }),
    );
  });

  it('skips summary message when maxToolCallsPerTurn is reached in automated mode', async () => {
    const { runner } = createRunner({ maxToolCalls: 1, mode: 'automated' });
    const stream = createStream();

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-1', function: { name: 'file_write', arguments: '{}' } }],
      pendingAssistantMessage: { id: 'assistant-1', role: 'assistant', content: 'doing work' },
      currentMessages: [],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(stream.message).not.toHaveBeenCalled();
  });

  it('uses the worker-specific tool budget instead of the runner default', async () => {
    const { runner, session } = createRunner({ maxToolCalls: 4, mode: 'interactive' });
    session.coordination = {
      role: 'worker',
      maxToolCalls: 1,
    } as any;
    const stream = createStream();

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-1', function: { name: 'file_write', arguments: '{}' } }],
      pendingAssistantMessage: { id: 'assistant-1', role: 'assistant', content: 'doing worker task' },
      currentMessages: [],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(result.toolCallCount).toBe(1);
    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(1);
    expect(stream.message).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Tool call budget reached') }),
    );
  });

  it('passes automated checkpoint context into the tool executor', async () => {
    const { runner } = createRunner({ maxToolCalls: 2, mode: 'automated' });

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [{ id: 'call-1', function: { name: 'file_write', arguments: '{}' } }],
        pendingAssistantMessage: { id: 'assistant-1', role: 'assistant', content: 'do work' },
        currentMessages: [],
        toolCallCount: 1,
        usage: undefined,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: 'done',
        toolCallCount: 0,
        messagesLength: 1,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(mocks.mockToolRun).toHaveBeenCalledWith(
      expect.objectContaining({
        isAutomated: true,
        maxToolCalls: 2,
        reservedToolCalls: 1,
        sessionToolCallCount: 0,
      }),
    );
  });

  it('returns aborted status when abort signal is triggered', async () => {
    const { runner, sessionStore } = createRunner();
    const abortController = new AbortController();
    abortController.abort();

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: abortController.signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('aborted');
    // stateMachine.stopProcessing() should be called and session persisted
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'session-1' }),
      'abort_request_processed',
    );
  });

  it('does not stop a newer turn when an old abort signal arrives late', async () => {
    const { runner, session, sessionStore } = createRunner();
    const oldTurnController = new AbortController();
    const newTurnController = new AbortController();
    oldTurnController.abort();
    session.currentTurn = { controller: newTurnController };

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: oldTurnController.signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('aborted');
    expect(session.stateMachine.stopProcessing).not.toHaveBeenCalled();
    expect(sessionStore.setAsync).not.toHaveBeenCalledWith(
      'session-1',
      expect.anything(),
      'abort_request_processed',
    );
  });

  it('converts legacy deadlock responses from tool executor into recoverable nudges', async () => {
    const { runner, session } = createRunner();
    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-1', function: { name: 'file_read', arguments: '{}' } }],
      pendingAssistantMessage: { id: 'assistant-1', role: 'assistant', content: 'looping' },
      currentMessages: [],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'deadlock',
      toolCallCount: 3,
      collectedToolResults: [],
      currentMessages: [],
      doneEmitted: false,
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(session.blockedReason).toBeUndefined();
    expect(session.flags.recoverableGuard).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'repeated_tool_call_loop',
        }),
      }),
    );
  });

  it('emits tokens through the stream when provided by the controller', async () => {
    const { runner } = createRunner();
    const stream = createStream();
    mocks.mockStreamRun.mockImplementationOnce(async (args) => {
      args.stream.token('H');
      return {
        status: 'completed',
        toolCallCount: 0,
        messagesLength: 1,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      };
    });

    await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(stream.token).toHaveBeenCalledWith('H');
  });

  it('propagates stream interruptions', async () => {
    const { runner } = createRunner();
    mocks.mockStreamRun.mockRejectedValueOnce(new Error('stream interrupted'));

    await expect(
      runner.runTurn({
        sessionId: 'session-1',
        turnNumber: 1,
        abortSignal: new AbortController().signal,
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        stream: createStream() as any,
        recorder: undefined,
        modelName: 'gpt-turn',
      }),
    ).rejects.toThrow('stream interrupted');
  });

  it('runs a multi-step turn to completion with no credit check: Null AI charges nothing', async () => {
    const checkpointManager = {
      create: vi.fn().mockResolvedValue({ id: 'cp-soft', ts: new Date().toISOString() }),
    };
    const { runner, session } = createRunner({ checkpointManager, mode: 'automated', maxToolCalls: 4 });
    session.plan = [
      { id: 'step-1', title: 'Validate auth bypass', status: 'running' },
      { id: 'step-2', title: 'Write report', status: 'pending' },
    ];
    session.currentPlanStepId = 'step-1';

    mocks.mockStreamRun
      .mockResolvedValueOnce({
        status: 'tool_calls',
        toolCalls: [{ id: 'call-1', function: { name: 'file_read', arguments: '{}' } }],
        pendingAssistantMessage: { id: 'assistant-1', role: 'assistant', content: 'work' },
        currentMessages: [],
        toolCallCount: 1,
        usage: undefined,
      })
      .mockResolvedValueOnce({
        status: 'completed',
        assistantText: 'done',
        toolCallCount: 0,
        messagesLength: 1,
        currentMessages: [],
        toolCalls: [],
        usage: undefined,
      });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const stream = createStream();
    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('completed');
    expect(checkpointManager.create).not.toHaveBeenCalled();
    expect((session.flags as Record<string, unknown> | undefined)?.resume_checkpoint).toBeUndefined();
    expect(mocks.mockStreamRun.mock.calls[1]?.[0]?.currentMessages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('LOW CREDIT CHECKPOINT SAVED') }),
      ]),
    );
  });

  it('returns awaiting_approval when tool execution requests approval', async () => {
    const { runner, sessionStore, session } = createRunner();
    const stream = createStream();
    const pendingAssistantMessage = { id: 'assistant-1', role: 'assistant', content: 'need approval' } as any;

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-approval', function: { name: 'shell', arguments: '{}' } }],
      pendingAssistantMessage,
      currentMessages: [pendingAssistantMessage],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'awaiting_approval',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      pendingApproval: {
        actionId: 'call-approval',
        toolCallId: 'call-approval',
        tool: 'shell',
        args: { command: 'rm -rf /tmp' },
        requestedAt: Date.now(),
        reason: 'Policy requires approval.',
      },
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('awaiting_approval');
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        blockedReason: undefined,
        pendingApproval: expect.objectContaining({
          actionId: 'call-approval',
          toolCallId: 'call-approval',
          tool: 'shell',
        }),
      }),
      'approval_pending',
    );
    expect(sessionStore.clearCurrentTurnAsync).toHaveBeenCalledWith('session-1');
    expect(session.pendingApproval).toEqual(
      expect.objectContaining({
        actionId: 'call-approval',
        toolCallId: 'call-approval',
        tool: 'shell',
      }),
    );
  });

  it('completes the planner session and exits immediately when submit_plan hands off to plan approval', async () => {
    const sessionRepository = {
      setCompleted: vi.fn().mockResolvedValue(true),
    };
    const { runner, sessionStore, session } = createRunner({ sessionRepository });
    const stream = createStream();
    const pendingAssistantMessage = { id: 'assistant-1', role: 'assistant', content: 'submit plan' } as any;

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-submit-plan', function: { name: 'submit_plan', arguments: '{}' } }],
      pendingAssistantMessage,
      currentMessages: [pendingAssistantMessage],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'awaiting_approval',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      awaitingApprovalContext: {
        kind: 'plan_submission',
        runId: 'run-1',
      },
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: stream as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('awaiting_approval');
    expect(mocks.mockStreamRun).toHaveBeenCalledTimes(1);
    expect(sessionRepository.setCompleted).toHaveBeenCalledWith('session-1', true);
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        completed: true,
        blockedReason: undefined,
        pendingApproval: undefined,
      }),
      'plan_approval_submitted',
    );
    expect(sessionStore.clearCurrentTurnAsync).toHaveBeenCalledWith('session-1');
    expect(session.completed).toBe(true);
    expect(session.pendingApproval).toBeUndefined();
  });

  it('does not materialize planner completion when its durable projection fails', async () => {
    const sessionRepository = {
      setCompleted: vi.fn().mockResolvedValue(false),
    };
    const { runner, sessionStore, session } = createRunner({ sessionRepository });
    const pendingAssistantMessage = { id: 'assistant-1', role: 'assistant', content: 'submit plan' } as any;
    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-submit-plan', function: { name: 'submit_plan', arguments: '{}' } }],
      pendingAssistantMessage,
      currentMessages: [pendingAssistantMessage],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'awaiting_approval',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      awaitingApprovalContext: { kind: 'plan_submission', runId: 'run-1' },
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    await expect(runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    })).rejects.toThrow('durable_planner_completion_failed');

    expect(session.completed).not.toBe(true);
    expect(sessionStore.setAsync).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ completed: true }),
      'plan_approval_submitted',
    );
  });

  it('reconciles plan state and creates an exit checkpoint when max tool calls is reached', async () => {
    const checkpointManager = {
      create: vi.fn().mockResolvedValue({ id: 'cp-budget', ts: new Date().toISOString() }),
    };
    const { runner, session } = createRunner({ maxToolCalls: 1, mode: 'automated', checkpointManager });
    session.plan = [
      { id: 'step-1', title: 'Enumerate target', status: 'running' },
      { id: 'step-2', title: 'Validate finding', status: 'pending' },
    ];
    session.currentPlanStepId = 'step-1';

    mocks.mockStreamRun.mockResolvedValueOnce({
      status: 'tool_calls',
      toolCalls: [{ id: 'call-1', function: { name: 'file_write', arguments: '{}' } }],
      pendingAssistantMessage: { id: 'assistant-1', role: 'assistant', content: 'working' },
      currentMessages: [],
      toolCallCount: 1,
      usage: undefined,
    });
    mocks.mockToolRun.mockResolvedValueOnce({
      status: 'completed',
      toolCallCount: 1,
      collectedToolResults: [],
      currentMessages: [],
      skippedToolCalls: [],
      actionSummaries: [],
      discoveries: [],
      memoryUpdates: [],
    });

    const result = await runner.runTurn({
      sessionId: 'session-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      systemMessages: [],
      historyMessages: [],
      toolDefinitions: [],
      stream: createStream() as any,
      recorder: undefined,
      modelName: 'gpt-turn',
    });

    expect(result.status).toBe('max_tool_calls');
    expect(checkpointManager.create).toHaveBeenCalledWith('session-1');
    expect(session.plan).toEqual([
      expect.objectContaining({
        id: 'step-1',
        status: 'blocked',
        blockedReason: expect.stringContaining('tool budget exhausted'),
        checkpointId: 'cp-budget',
      }),
      expect.objectContaining({
        id: 'step-2',
        status: 'pending',
      }),
    ]);
    expect((session.flags as Record<string, unknown> | undefined)?.resume_checkpoint).toBeUndefined();
  });
});
