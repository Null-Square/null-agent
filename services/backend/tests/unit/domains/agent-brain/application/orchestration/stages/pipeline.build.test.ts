import { vi, describe, it, expect, beforeEach } from 'vitest';
import { DefaultStages } from '@/domains/agent-brain/application/orchestration/stages';
import type { Message, SessionState } from '@/domains/agent-brain/domain/types';
import { MessageValidator } from '@/domains/agent-brain/application/services/MessageValidator';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';

const Build = DefaultStages.Build;

const createStructuredCompactionSummary = (overrides: Partial<Record<string, string[]>> = {}) =>
  [
    '## Filed Findings',
    ...(overrides.findings ?? ['- F-101 | high | /admin exposed without auth']),
    '',
    '## Attempted Techniques',
    ...(overrides.techniques ?? ['- ffuf | https://app.example.com/admin | 200 responses mapped']),
    '',
    '## Failed Approaches and Blockers',
    ...(overrides.approaches ?? ['- sqlmap | https://app.example.com/login | blocked by anti-automation']),
    '',
    '## Confirmed Credentials or Tokens',
    ...(overrides.credentials ?? ['- session cookie abc123 | admin scope | confirmed valid']),
    '',
    '## Open Plan Steps',
    ...(overrides.openSteps ?? ['- Validate admin workflow with a dedicated validator worker']),
    '',
    '## High-Signal Discoveries',
    ...(overrides.discoveries ?? ['- admin.app.example.com exposes /admin, /login, and /openapi.json']),
    '',
    '## Constraints and Safety Limits',
    ...(overrides.constraints ?? ['- Keep the root focused on coordination and reporting only']),
  ].join('\n');

const createSession = (messages: Message[], overrides: Partial<SessionState> = {}): SessionState =>
  ({
    id: 's1',
    profileKey: 'default',
    extraContext: 'extra',
    messages,
    modelContextWindow: 8000,
    modelMaxOutputTokens: 1000,
    ...overrides,
  }) as SessionState;

const makeArgs = (overrides: Record<string, any> = {}) => {
  const contextProvider = {
    getContext: vi.fn().mockResolvedValue({ hard: 'hard', soft: 'soft' }),
  };
  const promptBuilder = {
    resolveProfile: vi.fn().mockResolvedValue({ id: 'profile' }),
    build: vi.fn().mockReturnValue({
      staticPrompt: 'static',
      dynamicPrompt: 'dynamic',
      softContext: 'soft',
      cacheablePrefix: 'prefix',
      dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      sections: { static: [], soft: [], dynamic: [] },
    }),
  };
  const cacheCoordinator = {
    build: vi.fn().mockReturnValue({
      cacheIntent: { action: 'hit', prefixHash: 'abc' },
      approxPrefixTokens: 10,
      prefixHash: 'abc',
    }),
  };
  const toolsRegistry = {
    getToolSchemas: vi.fn().mockReturnValue([]),
  };
  const provider = {
    name: 'mock-provider',
    getCapabilities: () => ({ contextWindow: 128_000 }),
    supportsCacheControl: () => false,
    buildSystemMessages: vi.fn().mockReturnValue([]),
    getClient: vi.fn(() => ({
      chat: { completions: { create: vi.fn() } },
    })),
    mapError: vi.fn((error: unknown) =>
      error instanceof AppError ? error : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))
    ),
  };

  return {
    session: createSession([]),
    turnNumber: 1,
    contextProvider,
    promptBuilder,
    cacheCoordinator,
    toolsRegistry,
    provider,
    traceRecorder: { write: vi.fn().mockResolvedValue(undefined) },
    convertMessages: (messages: Message[]) => messages as any,
    maxToolCalls: 4,
    modelName: 'test-model',
    ...overrides,
  };
};

const createTransactionalHistoryPort = () => {
  const records = new Map<string, any>();
  return {
    records,
    port: {
      prepare: vi.fn(async (input: any) => {
        const existing = records.get(input.transactionId);
        if (existing) return structuredClone(existing);
        const record = {
          ...structuredClone(input),
          provenance: 'recorded',
          status: 'prepared',
          createdAt: input.createdAt ?? new Date().toISOString(),
        };
        records.set(input.transactionId, record);
        return structuredClone(record);
      }),
      persistReplacement: vi.fn(async (transactionId: string, input: any) => {
        const record = records.get(transactionId);
        if (!record) throw new Error(`missing:${transactionId}`);
        if (record.status === 'prepared') {
          Object.assign(record, structuredClone(input), {
            status: 'replacement_persisted',
            replacementPersistedAt: new Date().toISOString(),
          });
        }
        return structuredClone(record);
      }),
      activate: vi.fn(async (transactionId: string) => {
        const record = records.get(transactionId);
        if (!record) throw new Error(`missing:${transactionId}`);
        if (record.status !== 'activated') {
          for (const candidate of records.values()) {
            if (candidate.sessionId === record.sessionId && candidate.status === 'activated') {
              candidate.status = 'superseded';
            }
          }
          record.status = 'activated';
          record.activatedAt = new Date().toISOString();
        }
        return structuredClone(record);
      }),
      findById: vi.fn(async (transactionId: string) => {
        const record = records.get(transactionId);
        return record ? structuredClone(record) : undefined;
      }),
      findActiveBySession: vi.fn(async (sessionId: string) => {
        const record = [...records.values()].find(
          (candidate) => candidate.sessionId === sessionId && candidate.status === 'activated',
        );
        return record ? structuredClone(record) : undefined;
      }),
      findBySession: vi.fn(async (sessionId: string) => [...records.values()]
        .filter((record) => record.sessionId === sessionId)
        .map((record) => structuredClone(record))),
    },
  };
};

describe('DefaultBuildStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops empty assistant messages and merges consecutive assistant messages', async () => {
    const stage = new Build();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() },
      { id: 'a0', role: 'assistant', content: '', timestamp: Date.now() },
      { id: 'a1', role: 'assistant', content: 'first', timestamp: Date.now() },
      { id: 'a2', role: 'assistant', content: 'second', timestamp: Date.now() },
    ];

    const args = makeArgs({ session: createSession(messages) });
    const result = await stage.run(args as any);
    const history = result.historyMessages as Message[];

    expect(history).toHaveLength(2);
    expect(history[1].content).toBe('first\n\nsecond');
  });

  it('uses pre-prompt projection flush only as dirty-state recovery', async () => {
    const stage = new Build();
    const flushWorkspaceProjection = vi.fn().mockResolvedValue({ warning: null });
    const args = makeArgs({
      toolsRegistry: {
        getToolSchemas: vi.fn().mockReturnValue([]),
        flushWorkspaceProjection,
      },
    });

    await stage.run(args as any);

    expect(flushWorkspaceProjection).toHaveBeenCalledWith({
      sessionId: 's1',
      turnNumber: 1,
      reason: 'pre_prompt_dirty_recovery',
    });
  });

  it('rejects fixed prompt overhead before provider dispatch when no execution space remains', async () => {
    const stage = new Build();
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const promptBuilder = {
      resolveProfile: vi.fn().mockResolvedValue({ id: 'profile' }),
      build: vi.fn().mockReturnValue({
        staticPrompt: 'x'.repeat(24_000),
        dynamicPrompt: 'dynamic',
        softContext: 'soft',
        cacheablePrefix: 'prefix',
        dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
        sections: { static: [], soft: [], dynamic: [] },
      }),
    };

    await expect(stage.run(makeArgs({ promptBuilder, traceRecorder }) as any))
      .rejects.toThrow('Agent context is too large for the selected model before execution begins');
    expect(traceRecorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'context.fixed_prompt_rejected',
        payload: expect.objectContaining({ minimumExecutionSpace: 2_000 }),
      }),
    );
  });

  it('injects delegation activation guidance for executor turns and clears the transient flag', async () => {
    const stage = new Build();
    const session = createSession(
      [{ id: 'u1', role: 'user', content: 'start the run', timestamp: Date.now() }],
      {
        agentType: 'executor',
        mode: 'automated',
        executionMode: 'discovery',
        coordination: { role: 'direct' },
        workerTasks: [],
        flags: {},
        extraContext: '=== ASSIGNED METHODOLOGIES ===\n- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md\n',
        plan: [
          { id: 'task-1', title: 'Broad Surface Scan on app.example.com', status: 'pending' },
          { id: 'task-2', title: 'Broad Surface Scan on api.example.com', status: 'pending' },
        ],
      },
    );
    const promptBuilder = {
      build: vi.fn((input: any) => {
        const guidance = input.session.flags.delegationActivationGuidance ?? '';
        return {
          staticPrompt: 'static',
          dynamicPrompt: guidance,
          softContext: 'soft',
          cacheablePrefix: 'prefix',
          dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
          sections: {
            static: [],
            soft: [],
            dynamic: guidance
              ? [{ key: 'delegation_activation_guidance', kind: 'dynamic', order: 23, content: guidance }]
              : [],
          },
        };
      }),
    };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const args = makeArgs({
      session,
      promptBuilder,
      traceRecorder: recorder,
      toolsRegistry: {
        getToolSchemas: vi.fn().mockReturnValue([
          { name: 'spawn_worker', description: 'Spawn worker', parameters: { type: 'object', properties: {} } },
          { name: 'shell_run', description: 'Run shell', parameters: { type: 'object', properties: {} } },
        ]),
      },
      maxToolCalls: 8,
    });

    await stage.run(args as any);

    expect(promptBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([expect.objectContaining({ name: 'spawn_worker' })]),
      }),
    );
    expect((session.flags as any).delegationActivationGuidance).toBeUndefined();
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'delegation.guidance_injected',
        payload: expect.objectContaining({
          confidence: 'strong',
          openingWave: true,
          recommendationCount: 2,
          dynamicSection: 'delegation_activation_guidance',
        }),
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'system.prompt.full',
        payload: expect.objectContaining({
          dynamic: expect.stringContaining('spawn_worker(workerType="recon_worker"'),
          dynamicSections: ['delegation_activation_guidance'],
        }),
      }),
    );
  });

  it('repairs malformed tool_call args and strips orphaned tool_calls', async () => {
    const validator = new MessageValidator();
    const stage = new Build(validator);
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() },
      {
        id: 'a1',
        role: 'assistant',
        content: 'run tool',
        timestamp: Date.now(),
        tool_calls: [
          { id: 'call-1', function: { name: 'tool', arguments: '{bad' } },
          { id: 'call-2', function: { name: 'tool', arguments: '{}' } },
        ],
      } as any,
      { id: 't1', role: 'tool', content: 'ok', toolCallId: 'call-1', timestamp: Date.now() } as any,
      { id: 'u2', role: 'user', content: 'next', timestamp: Date.now() },
    ];

    const assertSpy = vi.spyOn(validator, 'assertValid');
    const args = makeArgs({ session: createSession(messages) });
    const result = await stage.run(args as any);
    const history = result.historyMessages as any[];
    const assistant = history.find((msg) => msg.id === 'a1');

    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe('call-1');
    expect(assistant.tool_calls[0].function.arguments).toBe('{}');
    expect(assertSpy).toHaveBeenCalled();
  });

  it('emits per-tool result budget metrics in context.budget', async () => {
    const stage = new Build();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'probe', timestamp: Date.now() },
      {
        id: 'a-http',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        tool_calls: [
          { id: 'call-http', type: 'function', function: { name: 'http_payload', arguments: '{}' } },
        ],
      } as Message,
      {
        id: 't-http',
        role: 'tool',
        tool_call_id: 'call-http',
        content: JSON.stringify({
          status: 'tool_result_persisted',
          ok: true,
          data: { url: 'https://example.com', body_preview: 'x'.repeat(500) },
          artifact: { path: '/workspace/.artifacts/tool-results/call-http.json' },
          policy: { savedApproxTokens: 120 },
        }),
        timestamp: Date.now(),
      } as Message,
      { id: 'u2', role: 'user', content: 'next', timestamp: Date.now() },
    ];
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    await stage.run(makeArgs({ session: createSession(messages), traceRecorder: recorder }) as any);

    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'context.budget',
        payload: expect.objectContaining({
          toolResultTokensByTool: expect.objectContaining({
            http_payload: expect.any(Number),
          }),
          toolResultsPersistedToDisk: 1,
          toolResultPersistedSavedTokens: 120,
          toolResultPolicyVersion: 'tool-result-policy/v1',
        }),
      }),
    );
  });

  it('adds a compaction summary when history crosses the threshold', async () => {
    const stage = new Build();
    const longText = 'word '.repeat(800);
    const messages: Message[] = Array.from({ length: 6 }, (_, idx) => ({
      id: `u${idx}`,
      role: 'user',
      content: `${longText}${idx}`,
      timestamp: Date.now() + idx,
    }));
    const executeModelCall = vi.fn().mockResolvedValue({
      content: createStructuredCompactionSummary(),
    });

    const provider = {
      name: 'mock-provider',
      supportsCacheControl: () => false,
      buildSystemMessages: vi.fn().mockReturnValue([]),
      mapError: vi.fn((error: unknown) =>
        error instanceof AppError ? error : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))
      ),
    };

    const session = createSession(messages, {
      flags: { securityops: { workflowDiscipline: 'compliance' } },
    });
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const args = makeArgs({ session, provider, traceRecorder: recorder, turnNumber: 5, executeModelCall });
    const result = await stage.run(args as any);

    expect(result.compactionResult).toEqual(
      expect.objectContaining({
        messagesSummarized: expect.any(Number),
        compactionVersion: 1,
        findingsPreserved: 1,
        techniquesPreserved: 1,
        approachesPreserved: 1,
        credentialsPreserved: 1,
        openStepsPreserved: 1,
        discoveriesPreserved: 1,
      }),
    );
    expect((result.historyMessages as Message[])[0].content).toContain('CONVERSATION CONTEXT SUMMARY');
    expect(session.compactionSummary).toContain('## Filed Findings');
    expect(session.compactionMessageCutoff).toBeGreaterThan(0);
    // E12 Slice C: the auxiliary request is a prefix extension, not a bespoke system prompt
    // over a flattened transcript. The directive is the final user message.
    const compactionCall = executeModelCall.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown[];
      cacheMode?: { kind: string };
    };
    const finalMessage = compactionCall.messages[compactionCall.messages.length - 1]!;
    expect(finalMessage.role).toBe('user');
    expect(finalMessage.content).toContain('control IDs, recorded verdicts, request IDs');
    expect(finalMessage.content).toContain('THE CONVERSATION ABOVE');
    expect(compactionCall.cacheMode).toEqual({ kind: 'reuse_ancestor' });
    expect(compactionCall.messages.some((message) => message.role === 'system'
      && message.content.includes('compaction engine'))).toBe(false);
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      5,
      expect.objectContaining({
        event: 'context.compacted',
        payload: expect.objectContaining({
          findingsPreserved: 1,
          techniquesPreserved: 1,
          approachesPreserved: 1,
          credentialsPreserved: 1,
          openStepsPreserved: 1,
          discoveriesPreserved: 1,
        }),
      }),
    );
  });

  it('updates an existing compaction summary using only unsummarized messages', async () => {
    const stage = new Build();
    const longText = 'delta '.repeat(350);
    const messages: Message[] = Array.from({ length: 10 }, (_, idx) => ({
      id: `u${idx}`,
      role: 'user',
      content: `message-${idx} ${longText}`,
      timestamp: Date.now() + idx,
    }));
    const executeModelCall = vi.fn().mockResolvedValue({
      content: createStructuredCompactionSummary(),
    });

    const provider = {
      name: 'mock-provider',
      supportsCacheControl: () => false,
      buildSystemMessages: vi.fn().mockReturnValue([]),
      mapError: vi.fn((error: unknown) =>
        error instanceof AppError ? error : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))
      ),
    };

    const session = createSession(messages, {
      compactionSummary: createStructuredCompactionSummary({
        discoveries: ['- baseline surface already summarized'],
      }),
      compactionCutoffTurn: 4,
      compactionMessageCutoff: 4,
      compactionVersion: 1,
    });

    const args = makeArgs({ session, provider, turnNumber: 8, executeModelCall });
    await stage.run(args as any);

    // E12 Slice C: the summarizer now receives real structured messages, so the selection
    // is asserted against the message array rather than a rendered transcript string.
    const promptMessages = executeModelCall.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    const instruction = promptMessages[promptMessages.length - 1]!;
    const conversation = promptMessages.slice(0, -1);
    const conversationText = conversation.map((message) => message.content ?? '').join(' ');

    // The prior checkpoint travels with the trailing directive, not as a separate prompt.
    expect(instruction.role).toBe('user');
    expect(instruction.content).toContain('An earlier checkpoint exists');

    // Only unsummarized messages are replayed.
    expect(conversationText).toContain('message-4');
    expect(conversationText).toContain('message-5');
    expect(conversationText).not.toContain('message-0');
    expect(conversationText).not.toContain('message-1');
    expect(session.compactionVersion).toBe(2);
  });

  it('keeps assistant/tool pairs intact when compaction lands on a tool boundary', async () => {
    const stage = new Build();
    const longText = 'token '.repeat(500);
    const messages: Message[] = [
      ...Array.from({ length: 6 }, (_, idx) => ({
        id: `u${idx}`,
        role: 'user' as const,
        content: `${longText}seed-${idx}`,
        timestamp: Date.now() + idx,
      })),
      {
        id: 'a-tool',
        role: 'assistant',
        content: 'run tool',
        timestamp: Date.now() + 7,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'shell_run', arguments: '{}' } }],
      } as Message,
      {
        id: 't-tool',
        role: 'tool',
        content: 'tool output',
        toolName: 'shell_run',
        toolCallId: 'call-1',
        timestamp: Date.now() + 8,
      } as Message,
      { id: 'u-tail-1', role: 'user', content: `${longText}tail-1`, timestamp: Date.now() + 9 },
      { id: 'u-tail-2', role: 'user', content: `${longText}tail-2`, timestamp: Date.now() + 10 },
    ];

    const provider = {
      name: 'mock-provider',
      supportsCacheControl: () => false,
      buildSystemMessages: vi.fn().mockReturnValue([]),
      getClient: vi.fn(() => ({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: createStructuredCompactionSummary() } }],
            }),
          },
        },
      })),
      mapError: vi.fn((error: unknown) =>
        error instanceof AppError ? error : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))
      ),
    };
    const executeModelCall = vi.fn().mockResolvedValue({
      content: createStructuredCompactionSummary(),
    });

    const result = await stage.run(makeArgs({
      session: createSession(messages),
      provider,
      turnNumber: 5,
      executeModelCall,
    }) as any);
    const history = result.historyMessages as Message[];

    expect(history[0].content).toContain('CONVERSATION CONTEXT SUMMARY');
    expect(history[1].role).toBe('assistant');
    expect((history[1] as any).tool_calls?.[0]?.id).toBe('call-1');
    expect(history[2].role).toBe('tool');
    expect((history[2] as any).toolCallId).toBe('call-1');
  });

  it('filters tool catalog by session.toolPolicy before building prompt + toolDefinitions', async () => {
    const stage = new Build();
    const promptBuilder = {
      resolveProfile: vi.fn().mockResolvedValue({ id: 'profile' }),
      build: vi.fn().mockReturnValue({
        staticPrompt: 'static',
        dynamicPrompt: 'dynamic',
        softContext: 'soft',
        cacheablePrefix: 'prefix',
        dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
        sections: { static: [], soft: [], dynamic: [] },
        profile: { id: 'profile' },
      }),
    };
    const toolsRegistry = {
      getToolSchemas: vi.fn().mockReturnValue([
        { name: 'shell_run', description: 'Shell', parameters: {} },
        { name: 'report_asset', description: 'SecurityOps write', parameters: {} },
        { name: 'query_inventory', description: 'SecurityOps read', parameters: {} },
      ]),
    };
    const session = createSession([], {
      toolPolicy: { deny: ['report_*', 'query_*'] } as any,
    });

    const args = makeArgs({ session, promptBuilder, toolsRegistry });
    const result = await stage.run(args as any);

    const calledTools = (promptBuilder.build as any).mock.calls[0][0].tools as Array<{ name: string }>;
    expect(calledTools.map((t) => t.name)).toEqual(['shell_run']);

    const toolNames = (result.toolDefinitions as any[]).map((t) => t.function?.name);
    expect(toolNames).toEqual(['shell_run']);
  });

  it('keeps hands-on tools available for direct executors when worker tools are present', async () => {
    const stage = new Build();
    const promptBuilder = {
      resolveProfile: vi.fn().mockResolvedValue({ id: 'profile' }),
      build: vi.fn().mockReturnValue({
        staticPrompt: 'static',
        dynamicPrompt: 'dynamic',
        softContext: 'soft',
        cacheablePrefix: 'prefix',
        dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
        sections: { static: [], soft: [], dynamic: [] },
        profile: { id: 'profile' },
      }),
    };
    const toolsRegistry = {
      getToolSchemas: vi.fn().mockReturnValue([
        { name: 'shell_run', description: 'Shell', parameters: {} },
        { name: 'http_payload', description: 'HTTP', parameters: {} },
        { name: 'browser_action', description: 'Browser', parameters: {} },
        { name: 'spawn_worker', description: 'Workers', parameters: {} },
        { name: 'file_write', description: 'File write', parameters: {} },
        { name: 'report_finding', description: 'Report', parameters: {} },
      ]),
    };
    const session = createSession([], {
      agentType: 'executor',
      mode: 'automated',
      coordination: { role: 'direct' },
      toolPolicy: { allow: ['*'] } as any,
    });

    const args = makeArgs({ session, promptBuilder, toolsRegistry });
    const result = await stage.run(args as any);

    const calledTools = (promptBuilder.build as any).mock.calls[0][0].tools as Array<{ name: string }>;
    expect(calledTools.map((t) => t.name)).toEqual([
      'shell_run',
      'http_payload',
      'browser_action',
      'spawn_worker',
      'file_write',
      'report_finding',
    ]);

    const toolNames = (result.toolDefinitions as any[]).map((t) => t.function?.name);
    expect(toolNames).toEqual([
      'shell_run',
      'http_payload',
      'browser_action',
      'spawn_worker',
      'file_write',
      'report_finding',
    ]);
  });

  it('removes worker-management tools when policy denies them', async () => {
    const stage = new Build();
    const promptBuilder = {
      resolveProfile: vi.fn().mockResolvedValue({ id: 'profile' }),
      build: vi.fn().mockReturnValue({
        staticPrompt: 'static',
        dynamicPrompt: 'dynamic',
        softContext: 'soft',
        cacheablePrefix: 'prefix',
        dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
        sections: { static: [], soft: [], dynamic: [] },
        profile: { id: 'profile' },
      }),
    };
    const toolsRegistry = {
      getToolSchemas: vi.fn().mockReturnValue([
        { name: 'shell_run', description: 'Shell', parameters: {} },
        { name: 'report_finding', description: 'Report', parameters: {} },
        { name: 'spawn_worker', description: 'Workers', parameters: {} },
        { name: 'wait_for_worker', description: 'Wait', parameters: {} },
        { name: 'submit_worker_result', description: 'Worker result', parameters: {} },
      ]),
    };
    const session = createSession([], {
      agentType: 'executor',
      mode: 'automated',
      toolPolicy: {
        deny: ['spawn_worker', 'wait_for_worker', 'submit_worker_result'],
      } as any,
    });

    const args = makeArgs({ session, promptBuilder, toolsRegistry });
    const result = await stage.run(args as any);

    const calledTools = (promptBuilder.build as any).mock.calls[0][0].tools as Array<{ name: string }>;
    expect(calledTools.map((t) => t.name)).toEqual(['shell_run', 'report_finding']);

    const toolNames = (result.toolDefinitions as any[]).map((t) => t.function?.name);
    expect(toolNames).toEqual(['shell_run', 'report_finding']);
  });

  it('logs assigned skills without injecting delegation nudges for broad-surface executor runs', async () => {
    const stage = new Build();
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const session = createSession([], {
      agentType: 'executor',
      mode: 'automated',
      executionMode: 'discovery',
      plan: [
        { id: 'task-1', title: 'Broad Surface Scan on app.example.com', status: 'pending' },
        { id: 'task-2', title: 'Broad Surface Scan on api.example.com', status: 'pending' },
      ],
      coordination: { role: 'direct' },
      workerTasks: [],
      extraContext: [
        '=== ASSIGNED METHODOLOGIES ===',
        '- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md',
      ].join('\n'),
      flags: {},
    });

    const args = makeArgs({ session, traceRecorder, maxToolCalls: 40 });
    const result = await stage.run(args as any);

    expect(traceRecorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'assigned_skills.injected',
        payload: expect.objectContaining({
          count: 1,
          slugs: ['broad-surface-scan'],
        }),
      }),
    );
    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'delegation.activation_suggested',
      }),
    );
    expect(result.systemMessages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Delegation activation:'),
        }),
      ]),
    );
  });

  it('does not run skill routing implicitly during prompt build', async () => {
    const stage = new Build();
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const session = createSession(
      [
        {
          id: 'u1',
          role: 'user',
          content: 'Observed ntype=http.endpoint and an OpenAPI document. nuclei -jsonl output is available.',
          timestamp: Date.now(),
        },
      ],
      {
        agentType: 'executor',
        mode: 'automated',
        promptProfile: 'phase-validation',
        extraContext: [
          '=== ASSIGNED METHODOLOGIES ===',
          '- api-enumeration: /workspace/.skills/api-enumeration/methodology.md',
        ].join('\n'),
        flags: {
          securityops: {
            activePhaseKey: 'validation',
          },
        },
      },
    );

    await stage.run(makeArgs({ session, traceRecorder }) as any);

    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: expect.stringMatching(/^skill\.(ranking_observed|router_suggested|router_miss)$/u),
      }),
    );
  });

  // E12 Slice E: the cross-turn owner cannot see how many further requests will reuse the
  // prefix it is about to rewrite, so it does not price the rewrite and does not perform an
  // ordinary reduction. Prompt pressure is answered at dispatch by the same-turn owner, whose
  // forced path bypasses the gate. Run r1 lost about $0.0929 to recover $0.0005 on exactly
  // this path, both firings unforced.
  it('does not perform a cross-turn reduction it cannot price, and leaves history intact', async () => {
    const stage = new Build();
    const now = Date.now();
    const messages: Message[] = [
      { id: 'u0', role: 'user', content: 'start', timestamp: now },
      ...Array.from({ length: 8 }, (_, idx): Message[] => {
        const callId = `call-${idx}`;
        return [
          {
            id: `a-${idx}`,
            role: 'assistant',
            content: '',
            timestamp: now + idx * 2 + 1,
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: { name: 'query_inventory', arguments: '{}' },
              },
            ],
          } as Message,
          {
            id: `t-${idx}`,
            role: 'tool',
            toolName: 'query_inventory',
            toolCallId: callId,
            content: JSON.stringify({
              ok: true,
              data: {
                assets: Array.from({ length: 44 }, (_asset, assetIdx) => ({
                  id: `asset-${assetIdx}`,
                  value: `host-${assetIdx}.example.com`,
                  filler: 'x'.repeat(450),
                })),
                leadCount: 0,
              },
            }),
            timestamp: now + idx * 2 + 2,
          } as Message,
        ];
      }).flat(),
      { id: 'u-tail', role: 'user', content: 'continue', timestamp: now + 99 },
    ];
    const session = createSession(messages, { modelContextWindow: 200_000, modelMaxOutputTokens: 4_000 });
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };

    const result = await stage.run(makeArgs({ session, traceRecorder }) as any);
    const history = result.historyMessages as Message[];
    const compacted = history.filter(
      (message) =>
        message.role === 'tool' &&
        typeof message.content === 'string' &&
        message.content.includes('tool_result_compacted'),
    );

    // Enough tool output to be well past the quantized boundary, and still not rewritten.
    expect(compacted.length).toBe(0);
    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({ event: 'tool_result_compacted' }),
    );
    expect((session.flags?.context_budget_last as Record<string, unknown>).microcompactedToolResults).toBe(0);
  });

  it('still reports the tool-result budget it measured even when it reduces nothing', async () => {
    const stage = new Build();
    const now = Date.now();
    const messages: Message[] = [
      { id: 'u0', role: 'user', content: 'start', timestamp: now },
      ...Array.from({ length: 8 }, (_, idx): Message[] => {
        const callId = `call-${idx}`;
        const toolName = idx === 0 ? 'report_note' : 'query_inventory';
        return [
          {
            id: `a-${idx}`,
            role: 'assistant',
            content: '',
            timestamp: now + idx * 2 + 1,
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: { name: toolName, arguments: '{}' },
              },
            ],
          } as Message,
          {
            id: `t-${idx}`,
            role: 'tool',
            toolName,
            toolCallId: callId,
            content: JSON.stringify({
              ok: true,
              data: {
                assets: Array.from({ length: 44 }, (_asset, assetIdx) => ({
                  id: `asset-${assetIdx}`,
                  value: `host-${assetIdx}.example.com`,
                  filler: 'x'.repeat(450),
                })),
                leadCount: 0,
              },
            }),
            timestamp: now + idx * 2 + 2,
          } as Message,
        ];
      }).flat(),
      { id: 'u-tail', role: 'user', content: 'continue', timestamp: now + 99 },
    ];
    const session = createSession(messages, { modelContextWindow: 200_000, modelMaxOutputTokens: 4_000 });
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };

    const result = await stage.run(makeArgs({ session, traceRecorder }) as any);
    const history = result.historyMessages as Message[];
    const controlAck = history.find((message) => message.id === 't-0');

    // Measurement is not the same thing as reduction: the budget is still observable.
    expect(traceRecorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'context.budget',
        payload: expect.objectContaining({
          microcompactedToolResults: expect.any(Number),
          toolResultTokens: expect.any(Number),
        }),
      }),
    );
    expect(controlAck?.content).not.toContain('tool_result_compacted');
  });

  it('derives a large-window history budget from routed capacity without the legacy 160k cap', async () => {
    const contextWindow = 1_000_000;
    const stage = new Build();
    const session = createSession(
      [{ id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() }],
      { modelContextWindow: contextWindow, modelMaxOutputTokens: 8_192 },
    );

    const result = await stage.run(makeArgs({ session }) as any);
    const budget = result.contextEstimate.maxHistoryTokens;

    // The subject of this test: the budget follows the routed capacity, not a fixed ceiling.
    expect(budget).toBeGreaterThan(600_000);
    expect(budget).toBeGreaterThan(160_000 * 3);

    // D18 - and it sits above compaction's soft threshold, so the summariser always gets its
    // chance before head-tail dropping. Four of five seeded routes used to fail this.
    const compactionSoftThreshold = Math.floor(contextWindow * 0.7);
    expect(budget).toBeGreaterThan(compactionSoftThreshold);

    // ...while still fitting the window it has to be dispatched into.
    expect(budget).toBeLessThan(contextWindow - 8_192);
  });

  it('disables auto-compaction after repeated compaction failures', async () => {
    const stage = new Build();
    const longText = 'word '.repeat(800);
    const messages: Message[] = Array.from({ length: 6 }, (_, idx) => ({
      id: `u${idx}`,
      role: 'user',
      content: `${longText}${idx}`,
      timestamp: Date.now() + idx,
    }));
    const executeModelCall = vi.fn().mockRejectedValue(new Error('summarizer down'));
    const provider = {
      name: 'mock-provider',
      supportsCacheControl: () => false,
      buildSystemMessages: vi.fn().mockReturnValue([]),
      mapError: vi.fn((error: unknown) =>
        error instanceof AppError ? error : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))
      ),
    };
    const session = createSession(messages, {
      flags: {
        compaction_failures: { consecutive: 2, disabled: false },
      },
    });
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };

    await stage.run(makeArgs({ session, provider, traceRecorder, turnNumber: 5, executeModelCall }) as any);

    expect(session.flags?.compaction_failures).toEqual(
      expect.objectContaining({
        consecutive: 3,
        disabled: true,
      }),
    );
    expect(traceRecorder.write).toHaveBeenCalledWith(
      session.id,
      5,
      expect.objectContaining({
        event: 'context.compaction_disabled',
        payload: expect.objectContaining({
          consecutiveFailures: 3,
          disabled: true,
        }),
      }),
    );
  });

  it('does not emit delegation guidance when worker tools are unavailable', async () => {
    const stage = new Build();
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const session = createSession([], {
      agentType: 'executor',
      mode: 'automated',
      executionMode: 'discovery',
      plan: [
        { id: 'task-1', title: 'Broad Surface Scan on app.example.com', status: 'pending' },
        { id: 'task-2', title: 'Broad Surface Scan on api.example.com', status: 'pending' },
      ],
      coordination: { role: 'direct' },
      workerTasks: [],
      flags: {
        token_usage_history: { entries: [{ credits: 10 }] },
      },
    });

    const args = makeArgs({ session, traceRecorder, maxToolCalls: 40 });
    const result = await stage.run(args as any);

    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({
        event: 'delegation.activation_suggested',
      }),
    );
    expect(result.systemMessages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Delegation activation:'),
        }),
      ]),
    );
  });

  it('keeps the prior history active across a crash before transaction activation', async () => {
    const stage = new Build();
    const history = createTransactionalHistoryPort();
    const longText = 'transaction '.repeat(700);
    const messages: Message[] = Array.from({ length: 8 }, (_, index) => ({
      id: `stable-${index}`,
      role: 'user',
      content: `${longText}${index}`,
      timestamp: index,
    }));
    const session = createSession(messages);
    const executeModelCall = vi.fn().mockResolvedValue({
      content: createStructuredCompactionSummary(),
    });
    let injected = false;

    await expect(stage.run(makeArgs({
      session,
      turnNumber: 5,
      executeModelCall,
      historyTransformationPort: history.port,
      historyTransformationFault: (point: string) => {
        if (point === 'after_replacement_persisted_before_activation' && !injected) {
          injected = true;
          throw new Error('deterministic crash');
        }
      },
    }) as any)).rejects.toThrow('history_transformation_fault:after_replacement_persisted_before_activation');

    expect(await history.port.findActiveBySession(session.id)).toBeUndefined();
    const prepared = [...history.records.values()][0];
    expect(prepared).toMatchObject({
      status: 'replacement_persisted',
      inputMessageIds: expect.arrayContaining(['stable-0']),
    });
    expect(session.compactionSummary).toBeUndefined();

    const recovered = await stage.run(makeArgs({
      session,
      turnNumber: 5,
      executeModelCall,
      historyTransformationPort: history.port,
    }) as any);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(await history.port.findActiveBySession(session.id)).toMatchObject({
      transactionId: prepared.transactionId,
      status: 'activated',
      inputEndMessageId: prepared.inputEndMessageId,
    });
    expect(recovered.transformationRefs).toEqual([prepared.transactionId]);
  });

  it('reuses the activated stable boundary after a crash at post-activation handoff', async () => {
    const stage = new Build();
    const history = createTransactionalHistoryPort();
    const longText = 'activation '.repeat(700);
    const messages: Message[] = Array.from({ length: 8 }, (_, index) => ({
      id: `activation-${index}`,
      role: 'user',
      content: `${longText}${index}`,
      timestamp: index,
    }));
    const session = createSession(messages);
    const executeModelCall = vi.fn().mockResolvedValue({
      content: createStructuredCompactionSummary(),
    });

    await expect(stage.run(makeArgs({
      session,
      turnNumber: 5,
      executeModelCall,
      historyTransformationPort: history.port,
      historyTransformationFault: (point: string) => {
        if (point === 'after_activation') throw new Error('deterministic crash');
      },
    }) as any)).rejects.toThrow('history_transformation_fault:after_activation');

    const activated = await history.port.findActiveBySession(session.id);
    expect(activated).toMatchObject({ status: 'activated' });
    expect(session.compactionSummary).toBeUndefined();

    const recovered = await stage.run(makeArgs({
      session,
      turnNumber: 5,
      executeModelCall,
      historyTransformationPort: history.port,
    }) as any);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(recovered.transformationRefs).toEqual([activated.transactionId]);
    expect((recovered.historyMessages as Message[])[0]).toMatchObject({
      id: activated.replacementMessageId,
    });
    expect([...history.records.values()]).toHaveLength(1);
  });
});
