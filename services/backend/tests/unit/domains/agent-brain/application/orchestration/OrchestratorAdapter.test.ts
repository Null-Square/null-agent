import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';

const createStateMachine = (processing = false) => {
  let current = processing;
  return {
    isProcessing: () => current,
    startProcessing: vi.fn(() => {
      current = true;
      return true;
    }),
    stopProcessing: vi.fn(() => {
      current = false;
      return true;
    }),
    awaitUser: vi.fn(() => {
      current = false;
      return true;
    }),
    resumeProcessing: vi.fn(() => {
      current = true;
      return true;
    }),
    canStartProcessing: () => !current,
    getState: () => current ? 'processing' : 'idle',
  };
};
import { OrchestratorAdapter } from '@/domains/agent-brain/application/orchestration/OrchestratorAdapter';
import type { SessionState, Message } from '@/domains/agent-brain/domain/types';
import {
  getProviderReasoning,
  PROVIDER_REASONING_METADATA_KEY,
} from '@/domains/agent-brain/domain/reasoning/providerReasoning';
import { CompletionBlockedError } from '@/domains/agent-brain/domain/errors';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';
import { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';

vi.mock('@/domains/agent-brain/application/core/SessionStore');
vi.mock('@/domains/agent-brain/application/tools');
vi.mock('@/domains/agent-brain/application/orchestration/streaming/ModelStream');
vi.mock('@/domains/agent-brain/adapters/sandbox');

type SessionOverrides = Partial<SessionState> & { isProcessing?: boolean };

const createSession = (overrides: SessionOverrides = {}): SessionState => {
  const { isProcessing: overrideProcessing, ...rest } = overrides;
  return {
    id: 'session-1',
    userId: 'user-1',
    mode: 'interactive',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: '/tmp/workspace',
    modelName: 'mock-model',
    status: 'idle',
    createdAt: Date.now(),
    lastActive: Date.now(),
    turn: 0,
    pendingApproval: undefined,
    checkpoints: {},
    stateMachine: (rest.stateMachine ??
      (createStateMachine(Boolean(overrideProcessing)) as unknown as SessionState['stateMachine'])),
    ...rest,
  };
};

const defaultPromptProfile = {
  id: 'profile-default',
  name: 'Default',
  description: '',
  isDefault: true,
  mainSystemPrompt: 'You are a helpful assistant.',
  instructions: 'Use the provided tools to complete the task.',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const createSessionStore = (session: SessionState) => {
  const setCalls: SessionState[] = [];
  return {
    get: vi.fn((id: string) => session),
    setAsync: vi.fn(async (_id: string, next: SessionState, _reason?: string) => {
      setCalls.push({ ...next });
      Object.assign(session, next);
    }),
    startTurnAsync: vi.fn(async () => true),
    clearCurrentTurnAsync: vi.fn(async () => undefined),
    appendMessageAsync: vi.fn(async (_id: string, message: Message) => {
      session.messages.push(message);
    }),
    appendMessagesAsync: vi.fn(async (_id: string, messages: Message[]) => {
      session.messages.push(...messages);
    }),
    heartbeat: vi.fn(),
    __setCalls: setCalls,
  };
};

const createTurnStream = () => ({
  raw: vi.fn(),
  done: vi.fn(),
  messageStart: vi.fn(),
  message: vi.fn(),
});

type OrchestratorHotPath = {
  prepareSession: (...args: any[]) => any;
  buildPrompt: (...args: any[]) => any;
  executeTurn: (...args: any[]) => any;
  flushArtifacts: (...args: any[]) => any;
  reconcilePlan: (...args: any[]) => any;
};

const createPipeline = (
  sessionStore: ReturnType<typeof createSessionStore>,
  turnStream: ReturnType<typeof createTurnStream>,
  overrides: Partial<OrchestratorHotPath> = {},
): OrchestratorHotPath => ({
  prepareSession: vi.fn(async ({ sessionId }) => {
    const current = sessionStore.get(sessionId);
    current.stateMachine?.startProcessing('turn_start', current.turn ?? 0, 'test.prepareSession');
    await sessionStore.setAsync(sessionId, current);
    return {
      sessionState: { ...current },
      turnNumber: (current.turn ?? 0) + 1,
      turnController: new AbortController(),
      turnStream: turnStream as any,
      initialPendingPlanStepIds: new Set<string>(),
      recorder: undefined,
    } as any;
  }),
  buildPrompt: vi.fn(async () => ({
    contextEnvelope: {} as any,
    systemMessages: [],
    historyMessages: [],
    toolDefinitions: [],
    contextEstimate: {
      estimatedTokens: 1000,
      contextWindow: 10000,
      maxHistoryTokens: 5000,
      percentUsed: 10,
    },
  })),
  executeTurn: vi.fn(async () => ({
    status: 'completed' as const,
    toolCallCount: 0,
    messagesLength: 0,
    doneEmitted: false,
  } as any)),
  flushArtifacts: vi.fn(async () => ({ hasReport: true, hasSummary: true } as any)),
  reconcilePlan: vi.fn(async () => ({ pendingSteps: [] })),
  ...overrides,
});

const baseEvents = { emit: vi.fn() };
const baseToolsRegistry = {
  execute: vi.fn(),
  executeWithReceipt: vi.fn(),
  getToolSchemas: vi.fn(),
  listManifests: vi.fn(),
  getManifest: vi.fn(),
  handleApprovalDecision: vi.fn(),
};
const baseContextProvider = { getContext: vi.fn(async () => ({})) };
const baseArtifactService = {
  flush: vi.fn(async () => ({ hasReport: true, hasSummary: true })),
  ensureReportForCompletion: vi.fn(async () => undefined),
};

const createAdapter = (options: {
  session?: SessionState;
  pipelineOverrides?: Partial<OrchestratorHotPath>;
  maxToolCallsPerTurn?: number;
  sessionRepository?: any;
  turnExecutor?: any;
  providerFactory?: any;
  artifactService?: any;
  automationPolicy?: any;
  promptProfileService?: any;
}) => {
  const session = options.session ?? createSession();
  const sessionStore = createSessionStore(session);
  const turnStream = createTurnStream();
  const pipeline = createPipeline(sessionStore, turnStream, options.pipelineOverrides);
  const provider = {
    name: 'test-provider',
    buildSystemMessages: vi.fn(),
    decorateRequest: vi.fn((body) => body),
    normalizeUsage: vi.fn(),
    supportsCacheControl: () => false,
    getClient: () => ({}),
  };
  const providerFactory = options.providerFactory ?? { create: vi.fn(async () => provider) };
  const promptProfileService =
    options.promptProfileService ??
    ({
      getById: vi.fn(async () => defaultPromptProfile),
      getDefault: vi.fn(async () => defaultPromptProfile),
    } as any);

  const adapter = new OrchestratorAdapter({
    events: baseEvents as any,
    sessionStore: sessionStore as any,
    toolsRegistry: baseToolsRegistry as any,
    contextProvider: baseContextProvider as any,
    artifactService: {
      ...(options.artifactService ?? baseArtifactService),
      flush: pipeline.flushArtifacts,
    } as any,
    tokenGuard: new TokenGuard(),
    prepareStage: { run: pipeline.prepareSession } as any,
    buildStage: { run: pipeline.buildPrompt } as any,
    reconcileStage: { run: pipeline.reconcilePlan } as any,
    maxToolCallsPerTurn: options.maxToolCallsPerTurn,
    providerFactory: providerFactory as any,
    sessionRepository: options.sessionRepository,
    turnExecutor:
      options.turnExecutor ??
      ({
        runTurn: pipeline.executeTurn,
        setModelName: vi.fn(),
        setModel: vi.fn(),
      } as any),
    automationPolicy: options.automationPolicy,
  });

  return { adapter, session, sessionStore, turnStream, pipeline };
};

describe('OrchestratorAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processMessage', () => {
    it('sets isProcessing true at start and false at end', async () => {
      const { adapter, session, sessionStore } = createAdapter({});

      await adapter.processMessage(session.id, 'hello');

      const stateMachine = session.stateMachine as unknown as ReturnType<typeof createStateMachine>;
      expect(stateMachine.startProcessing).toHaveBeenCalled();
      expect(stateMachine.stopProcessing).toHaveBeenCalled();
      expect(stateMachine.isProcessing()).toBe(false);
    });

    it('calls executeTurn and flushArtifacts then emits done on success', async () => {
      const session = createSession({ userId: undefined });
      const executeTurn = vi.fn(async () => ({
        status: 'completed' as const,
        toolCallCount: 0,
        toolCallsRequested: 0,
        messagesLength: 0,
        doneEmitted: false,
      }));
      const flushArtifacts = vi.fn(async () => ({ hasReport: true, hasSummary: true } as any));

      const { adapter, pipeline, turnStream } = createAdapter({
        session,
        pipelineOverrides: {
          executeTurn,
          flushArtifacts,
          reconcilePlan: vi.fn(async () => ({ pendingSteps: [] })),
        },
      });

      await adapter.processMessage(session.id, 'done');

      expect(pipeline.executeTurn).toHaveBeenCalled();
      expect(pipeline.flushArtifacts).toHaveBeenCalledWith(
        session.id,
        1,
        turnStream,
        undefined,
      );
      expect(turnStream.done).toHaveBeenCalled();
    });

    it('emits s3_unavailable warning when report is not durable', async () => {
      const session = createSession({ mode: 'automated', userId: undefined });
      const artifactService = {
        ensureReportForCompletion: vi.fn(async () => {
          throw new CompletionBlockedError({ reason: 's3_unavailable', sessionId: session.id });
        }),
      };
      const automationPolicy = {
        evaluateGuard: () => ({
          active: true,
          exhausted: false,
          nextRetryCount: 1,
          pendingStepIds: [],
          reason: 'report_missing',
          suppressDone: true,
        }),
        isReportRequired: () => true,
      };

      const { adapter, turnStream } = createAdapter({
        session,
        artifactService,
        automationPolicy,
        pipelineOverrides: {
          flushArtifacts: vi.fn(async () => ({ hasReport: true, hasSummary: true } as any)),
          reconcilePlan: vi.fn(async () => ({ pendingSteps: [] })),
        },
      });

      await adapter.processMessage(session.id, 'validate');

      expect(artifactService.ensureReportForCompletion).toHaveBeenCalledWith(session.id);
      expect(turnStream.raw).toHaveBeenCalledWith(
        'warning',
        expect.objectContaining({ code: 's3_unavailable' }),
      );
      expect(turnStream.done).not.toHaveBeenCalled();
    });

    it('emits report_missing_s3 warning when S3 report is missing', async () => {
      const session = createSession({ mode: 'automated', userId: undefined });
      const artifactService = {
        ensureReportForCompletion: vi.fn(async () => {
          throw new CompletionBlockedError({ reason: 'report_missing_in_s3', sessionId: session.id });
        }),
      };
      const automationPolicy = {
        evaluateGuard: () => ({
          active: true,
          exhausted: false,
          nextRetryCount: 1,
          pendingStepIds: [],
          reason: 'report_missing',
          suppressDone: true,
        }),
        isReportRequired: () => true,
      };

      const { adapter, turnStream } = createAdapter({
        session,
        artifactService,
        automationPolicy,
        pipelineOverrides: {
          flushArtifacts: vi.fn(async () => ({ hasReport: true, hasSummary: true } as any)),
          reconcilePlan: vi.fn(async () => ({ pendingSteps: [] })),
        },
      });

      await adapter.processMessage(session.id, 'validate');

      expect(artifactService.ensureReportForCompletion).toHaveBeenCalledWith(session.id);
      expect(turnStream.raw).toHaveBeenCalledWith(
        'warning',
        expect.objectContaining({ code: 'report_missing_s3' }),
      );
      expect(turnStream.done).not.toHaveBeenCalled();
    });

    it('emits context_warning and context_compacted events', async () => {
      const { adapter, session } = createAdapter({
        pipelineOverrides: {
          buildPrompt: vi.fn(async () => ({
            contextEnvelope: {} as any,
            systemMessages: [],
            historyMessages: [],
            toolDefinitions: [],
            contextEstimate: {
              estimatedTokens: 9000,
              contextWindow: 10000,
              maxHistoryTokens: 5000,
              percentUsed: 90,
            },
            compactionResult: {
              beforeTokens: 8000,
              afterTokens: 3000,
              messagesSummarized: 5,
              findingsPreserved: 1,
              techniquesPreserved: 2,
              approachesPreserved: 1,
              credentialsPreserved: 0,
              openStepsPreserved: 1,
              discoveriesPreserved: 3,
              constraintsPreserved: 1,
              compactionVersion: 1,
            },
          })),
        },
      });

      await adapter.processMessage(session.id, 'warn');

      expect(baseEvents.emit).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ type: 'context_warning' }),
      );
      expect(baseEvents.emit).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ type: 'context_compacted' }),
      );
    });

    it('does not let a message clear a credits prerequisite', async () => {
      const sessionRepository = {
        getBlockedReason: vi.fn().mockResolvedValue('credits_exhausted'),
        clearBlockedReason: vi.fn().mockResolvedValue(true),
      };
      const { adapter, session } = createAdapter({ sessionRepository });

      await adapter.processMessage(session.id, 'resume');

      expect(sessionRepository.clearBlockedReason).not.toHaveBeenCalled();
    });

    it('does not let a message bypass the explicit user-pause resume path', async () => {
      const sessionRepository = {
        getBlockedReason: vi.fn().mockResolvedValue('user_paused'),
        clearBlockedReason: vi.fn().mockResolvedValue(true),
      };
      const { adapter, session } = createAdapter({ sessionRepository });

      await adapter.processMessage(session.id, 'continue with revised instructions');

      expect(sessionRepository.clearBlockedReason).not.toHaveBeenCalled();
    });
  });

  describe('approval flow', () => {
    it('resumes after approval is granted', async () => {
      const session = createSession({
        pendingApproval: {
          actionId: 'call-1',
          toolCallId: 'call-1',
          modelRequestId: '10000000-0000-4000-8000-000000000004',
          tool: 'write',
          reason: 'approve',
          requestedAt: Date.now(),
        },
      });
      const { adapter, sessionStore } = createAdapter({ session });
      const processSpy = vi.spyOn(adapter, 'processMessage').mockResolvedValue(undefined);
      (baseToolsRegistry.executeWithReceipt as Mock).mockResolvedValue({
        result: { ok: true },
        receipt: {
          schema: 'tool-execution-receipt/v1',
          toolName: 'write',
          toolCallId: 'call-1',
          outcome: 'succeeded',
        },
      });

      await adapter.handleApprovalResume(session.id, {
        actionId: 'action-1',
        toolCallId: 'call-1',
        modelRequestId: '10000000-0000-4000-8000-000000000004',
        toolName: 'write',
        args: { path: 'a' },
      });

      expect(baseToolsRegistry.executeWithReceipt).toHaveBeenCalledWith(
        'write',
        { path: 'a' },
        {
          sessionId: session.id,
          abortSignal: expect.any(AbortSignal),
          toolCallId: 'call-1',
          modelRequestId: '10000000-0000-4000-8000-000000000004',
        },
      );
      expect(sessionStore.appendMessageAsync).toHaveBeenCalled();
      expect(baseEvents.emit).toHaveBeenCalledWith(session.id, {
        type: 'approval_granted',
        data: { actionId: 'action-1' },
      });
      expect(processSpy).toHaveBeenCalledWith(session.id, '', session.profileKey);
    });

    it('ignores approval resume when session is not awaiting approval', async () => {
      const session = createSession();
      const { adapter } = createAdapter({ session });
      const processSpy = vi.spyOn(adapter, 'processMessage').mockResolvedValue(undefined);

      await adapter.handleApprovalResume(session.id, {
        actionId: 'action-2',
        toolName: 'write',
      });

      expect(processSpy).not.toHaveBeenCalled();
      expect(baseToolsRegistry.execute).not.toHaveBeenCalled();
      expect(baseToolsRegistry.executeWithReceipt).not.toHaveBeenCalled();
    });

    it('records tool failures during approval resume', async () => {
      const session = createSession({
        pendingApproval: { actionId: 'call-2', toolCallId: 'call-2', tool: 'write', reason: 'approve', requestedAt: Date.now() },
      });
      const { adapter, sessionStore } = createAdapter({ session });
      const processSpy = vi.spyOn(adapter, 'processMessage').mockResolvedValue(undefined);
      (baseToolsRegistry.executeWithReceipt as Mock).mockRejectedValue(new Error('tool failed'));

      await adapter.handleApprovalResume(session.id, {
        actionId: 'action-3',
        toolCallId: 'call-2',
        toolName: 'write',
        args: { path: 'a' },
      });

      const message = (sessionStore.appendMessageAsync as Mock).mock.calls[0]?.[1] as Message;
      const payload = JSON.parse(message.content);
      expect(payload.error).toBe('tool failed');
      expect(processSpy).toHaveBeenCalledWith(session.id, '', session.profileKey);
    });
  });

  describe('utilities', () => {
    it('converts messages to OpenAI format, trimming tool output and deduping', () => {
      const { adapter } = createAdapter({});
      const largeContent = 'a'.repeat(6100);
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() },
        { id: 'u2', role: 'user', content: 'hi', timestamp: Date.now() },
        { id: 't1', role: 'tool', content: largeContent, timestamp: Date.now(), toolCallId: 'call-1' } as any,
      ];

      const converted = (adapter as any).convertToOpenAIMessages(messages) as any[];

      expect(converted).toHaveLength(2);
      expect(converted[1].tool_call_id).toBe('call-1');
      expect(converted[1].content).toContain('[trimmed 100 chars of tool output]');
    });

    it('carries provider reasoning through conversion as non-enumerable request metadata', () => {
      const { adapter } = createAdapter({});
      const reasoning = {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        format: 'reasoning_content' as const,
        content: 'private reasoning',
        capturedAt: '2026-05-19T00:00:00.000Z',
      };
      const messages: Message[] = [
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          metadata: {
            [PROVIDER_REASONING_METADATA_KEY]: reasoning,
          },
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'shell', arguments: '{}' },
            },
          ],
        },
      ];

      const converted = (adapter as any).convertToOpenAIMessages(messages) as any[];

      expect(getProviderReasoning(converted[0])).toEqual(reasoning);
      expect(JSON.stringify(converted[0])).not.toContain('private reasoning');
    });
  });
});











