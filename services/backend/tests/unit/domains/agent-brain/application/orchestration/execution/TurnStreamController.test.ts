import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TurnStreamController } from '@/domains/agent-brain/application/orchestration/execution/TurnStreamController';
import { TurnMetricsAccumulator } from '@/domains/agent-brain/application/orchestration/execution/TurnMetricsAccumulator';
import { PROVIDER_REASONING_METADATA_KEY } from '@/domains/agent-brain/domain/reasoning/providerReasoning';

const modelStartMock = vi.fn();
const usageRecorderMock = {
  beginAttempt: vi.fn(),
  failAttempt: vi.fn(),
  recordUsage: vi.fn(),
  recordTurnLatency: vi.fn(),
  setModelName: vi.fn(),
};
const MAX_INPUT_CHARS = 250_000;

const createController = (
  sessionStoreOverrides: any = {},
  recorder?: any,
  controllerOverrides: any = {},
) => {
  if (recorder && typeof recorder.writeJsonArtifact !== 'function') {
    recorder.writeJsonArtifact = vi.fn((_sessionId: string, name: string) => `artifacts/${name}.json`);
  }

  const sessionStore = {
    get: vi.fn(() => ({
      id: 's1',
      messages: [],
      status: 'running',
    })),
    appendMessageAsync: vi.fn(),
    heartbeat: vi.fn(),
    ...sessionStoreOverrides,
  };

  const model = {
    start: modelStartMock,
    setModelName: vi.fn(),
    providerName: 'test-provider',
  } as any;

  const controller = new TurnStreamController({
    model,
    sessionStore: sessionStore as any,
    usageRecorder: usageRecorderMock as any,
    ...controllerOverrides,
  });

  const stream = {
    raw: vi.fn(),
    token: vi.fn(),
    message: vi.fn(),
    messageStart: vi.fn(),
    messageEnd: vi.fn(),
    done: vi.fn(),
  };

  const args: any = {
    sessionId: 's1',
    turnNumber: 1,
    abortSignal: new AbortController().signal,
    currentMessages: [],
    toolDefinitions: [],
    stream,
    recorder,
    modelName: undefined,
    configuredModelName: 'gpt-test',
  };

  return { controller, sessionStore, stream, args, model };
};

describe('TurnStreamController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usageRecorderMock.beginAttempt.mockResolvedValue({ id: 'attempt-1' });
    usageRecorderMock.failAttempt.mockResolvedValue(undefined);
    usageRecorderMock.recordUsage.mockResolvedValue(undefined);
  });

  it('reorders tool results and drops orphans before calling the model', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args, model } = createController({}, recorder);

    const assistantWithCall = {
      role: 'assistant',
      content: 'use tool',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'tool_a', arguments: '{}' } }],
    };
    const orphanToolResult = { role: 'tool', content: 'orphan', tool_call_id: 'missing' };
    const validToolResult = { role: 'tool', content: 'ok', tool_call_id: 'tc1' };

    args.currentMessages = [assistantWithCall, orphanToolResult, validToolResult] as any;
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'done' },
      content: 'done',
      toolCalls: [],
      totalChars: 4,
      preview: 'done',
      chunks: [],
      usage: undefined,
    });

    const result = await controller.run(args as any);

    expect(model.start).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [assistantWithCall, validToolResult],
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'input.sanitized',
        payload: expect.objectContaining({ droppedToolMessages: 1 }),
      }),
    );
    expect(result.status).toBe('completed');
  });

  it('returns pendingAssistantMessage with tool calls for atomic persistence (not persisted yet)', async () => {
    const sessionStore = {
      get: vi.fn(() => ({ id: 's1', messages: [], status: 'running' })),
      appendMessageAsync: vi.fn(),
      heartbeat: vi.fn(),
    };
    const { controller, args } = createController(sessionStore);

    args.currentMessages = [];
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'calling', tool_calls: [{ id: 'tc', function: { name: 'write_file', arguments: '{}' } }] },
      content: 'calling',
      reasoning: {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        format: 'reasoning_content',
        content: 'private reasoning',
        capturedAt: '2026-05-19T00:00:00.000Z',
      },
      toolCalls: [{ id: 'tc', function: { name: 'write_file', arguments: '{}' } }],
      totalChars: 7,
      preview: 'calling',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await controller.run(args as any);

    // ATOMIC PERSISTENCE: appendMessageAsync should NOT be called here
    // The message is returned as pendingAssistantMessage for batch persistence by TurnRunner
    expect(sessionStore.appendMessageAsync).not.toHaveBeenCalled();

    // Instead, check that pendingAssistantMessage is returned
    expect(result.pendingAssistantMessage).toBeDefined();
    expect(result.pendingAssistantMessage?.role).toBe('assistant');
    expect((result.pendingAssistantMessage as any)?.tool_calls).toHaveLength(1);
    expect((result.pendingAssistantMessage as any)?.tool_calls[0].id).toBe('tc');
    expect((result.pendingAssistantMessage as any)?.metadata?.[PROVIDER_REASONING_METADATA_KEY]?.content)
      .toBe('private reasoning');

    expect(result.toolCalls).toHaveLength(1);
    expect(result.status).toBeUndefined();
  });

  it('sets model name overrides and records usage', async () => {
    const { controller, args, model } = createController();
    args.modelName = 'custom-model';
    usageRecorderMock.recordUsage.mockResolvedValueOnce({
      promptTokens: 10,
      cachedPromptTokens: 2,
      completionTokens: 3,
      totalTokens: 15,
      nativeCost: 0.004,
      overhead: 0,
      platformCost: 0.004,
      platformPrice: 0.004,
      credits: 0.4,
      currency: 'usd',
      model: 'custom-model',
    });
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'hi' },
      content: 'hi',
      toolCalls: [],
      totalChars: 2,
      preview: 'hi',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await controller.run(args as any);

    expect(model.setModelName).toHaveBeenCalledWith('custom-model');
    expect(usageRecorderMock.setModelName).toHaveBeenCalledWith('custom-model');
    expect(usageRecorderMock.recordUsage).toHaveBeenCalledWith(
      's1',
      expect.any(Object),
      expect.objectContaining({ turn: 1, attemptId: 'attempt-1' }),
    );
    expect(args.stream.raw).toHaveBeenCalledWith('usage.recorded', {
      turn: 1,
      promptTokens: 10,
      cachedPromptTokens: 2,
      completionTokens: 3,
      totalTokens: 15,
      nativeCost: 0.004,
      overhead: 0,
      platformCost: 0.004,
      platformPrice: 0.004,
      credits: 0.4,
      currency: 'usd',
      model: 'custom-model',
    });
    expect(result.status).toBe('completed');
  });

  it('persists assistant message and streams when there are no tool calls', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args, sessionStore, stream } = createController({}, recorder);

    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'hi' },
      content: 'hi',
      toolCalls: [],
      totalChars: 2,
      preview: 'hi',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await controller.run(args as any);

    expect(sessionStore.appendMessageAsync).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ role: 'assistant', content: 'hi' }),
    );
    expect(stream.messageStart).toHaveBeenCalledWith({ role: 'assistant' });
    expect(stream.message).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', content: 'hi' }));
    expect(stream.messageEnd).toHaveBeenCalledWith(expect.objectContaining({ messageId: expect.any(String) }));
    expect(result.status).toBe('completed');
  });

  it('persists reasoning metadata without streaming it to the client', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args, sessionStore, stream } = createController({}, recorder);
    const reasoning = {
      provider: 'moonshot',
      model: 'kimi-k2.6',
      format: 'reasoning_content' as const,
      content: 'private reasoning',
      capturedAt: '2026-05-19T00:00:00.000Z',
    };

    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'hi' },
      content: 'hi',
      reasoning,
      toolCalls: [],
      totalChars: 2,
      preview: 'hi',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args as any);

    expect(sessionStore.appendMessageAsync).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          [PROVIDER_REASONING_METADATA_KEY]: reasoning,
        }),
      }),
    );
    expect(stream.message).toHaveBeenCalledWith(
      expect.not.objectContaining({
        metadata: expect.objectContaining({
          [PROVIDER_REASONING_METADATA_KEY]: expect.anything(),
        }),
      }),
    );
  });

  it('asks read-only chat models to repair invalid Mermaid before streaming or persisting', async () => {
    const recorder = { write: vi.fn() };
    const readonlyChatSession = {
      id: 's1',
      messages: [],
      status: 'running',
      flags: { securityops: { assistantMode: 'read_only_chat' } },
    };
    const { controller, args, sessionStore, stream } = createController({
      get: vi.fn(() => readonlyChatSession),
    }, recorder);
    const invalidMermaid = [
      'Here is the flow:',
      '',
      '```mermaid',
      'graph TD',
      'A--->>BROKEN[',
      '```',
    ].join('\n');

    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: invalidMermaid },
      content: invalidMermaid,
      toolCalls: [],
      totalChars: invalidMermaid.length,
      preview: invalidMermaid.slice(0, 20),
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await controller.run(args as any);

    expect(result.status).toBe('retry_mermaid_validation');
    expect(sessionStore.appendMessageAsync).not.toHaveBeenCalled();
    expect(stream.message).not.toHaveBeenCalled();
    expect(result.currentMessages.at(-2)).toMatchObject({ role: 'assistant', content: invalidMermaid });
    expect(String(result.currentMessages.at(-1)?.content)).toContain('NULLSQUARE_MERMAID_REPAIR_REQUEST');
    expect(String(result.currentMessages.at(-1)?.content)).toContain('Validation errors:');
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({ event: 'assistant.mermaid_validation_retry' }),
    );
  });

  it('downgrades invalid Mermaid to plain code after chat repair attempts are exhausted', async () => {
    const recorder = { write: vi.fn() };
    const readonlyChatSession = {
      id: 's1',
      messages: [],
      status: 'running',
      flags: { securityops: { assistantMode: 'read_only_chat' } },
    };
    const { controller, args, sessionStore, stream } = createController({
      get: vi.fn(() => readonlyChatSession),
    }, recorder);
    args.currentMessages = [
      { role: 'user', content: 'NULLSQUARE_MERMAID_REPAIR_REQUEST first' },
      { role: 'user', content: 'NULLSQUARE_MERMAID_REPAIR_REQUEST second' },
    ];
    const invalidMermaid = [
      'Still invalid:',
      '',
      '```mermaid',
      'graph TD',
      'A--->>BROKEN[',
      '```',
    ].join('\n');

    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: invalidMermaid },
      content: invalidMermaid,
      toolCalls: [],
      totalChars: invalidMermaid.length,
      preview: invalidMermaid.slice(0, 20),
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await controller.run(args as any);

    expect(result.status).toBe('completed');
    expect(sessionStore.appendMessageAsync).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('```text'),
      }),
    );
    expect(sessionStore.appendMessageAsync).toHaveBeenCalledWith(
      's1',
      expect.not.objectContaining({
        content: expect.stringContaining('```mermaid'),
      }),
    );
    expect(stream.message).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('```text'),
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({ event: 'assistant.mermaid_validation_downgraded' }),
    );
  });

  it('trims oversized input and records truncation', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);
    const longContent = 'a'.repeat(MAX_INPUT_CHARS + 10);

    args.currentMessages = [{ role: 'user', content: longContent }];
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      content: 'ok',
      toolCalls: [],
      totalChars: 2,
      preview: 'ok',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args as any);

    const callArgs = modelStartMock.mock.calls[0][0];
    expect(callArgs.messages[0].content.length).toBe(MAX_INPUT_CHARS);
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'input.truncated',
        payload: expect.objectContaining({ maxChars: MAX_INPUT_CHARS }),
      }),
    );
  });

  it('injects placeholder tool results for missing tool_calls', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);

    args.currentMessages = [
      {
        role: 'assistant',
        content: 'call tool',
        tool_calls: [{ id: 'tc-missing', type: 'function', function: { name: 'tool_a', arguments: '{}' } }],
      },
    ] as any;
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      content: 'ok',
      toolCalls: [],
      totalChars: 2,
      preview: 'ok',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args as any);

    const callArgs = modelStartMock.mock.calls[0][0];
    const toolMessage = callArgs.messages.find((msg: any) => msg.role === 'tool');
    expect(toolMessage).toEqual(
      expect.objectContaining({ role: 'tool', tool_call_id: 'tc-missing' }),
    );
    const payload = JSON.parse(toolMessage.content);
    expect(payload).toMatchObject({
      schema: 'interrupted-tool-result/v1',
      recovered: true,
      outcome: {
        kind: 'outcome_unknown',
        guidance: 'verify_before_retry',
      },
    });
    expect(toolMessage.content).not.toContain('Please retry the action');
    expect(callArgs.messages.filter(
      (msg: any) => msg.role === 'tool' && msg.tool_call_id === 'tc-missing',
    )).toHaveLength(1);
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'input.recovery.interrupted_tool_result',
        payload: expect.objectContaining({
          source: 'turn_stream_sanitizer',
          decision: 'outcome_unknown',
          compatibilityVersion: 'interrupted-tool-result/v1',
        }),
      }),
    );
  });

  it('emits may_retry only for explicit durable not_started evidence', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder, {
      resolveInterruptedToolEvidence: vi.fn(() => ({
        dispatchState: 'not_started',
        evidenceRef: 'ledger://s1/tc-not-started/dispatch',
      })),
    });
    args.currentMessages = [{
      role: 'assistant',
      content: 'call tool',
      tool_calls: [{
        id: 'tc-not-started',
        type: 'function',
        function: { name: 'tool_a', arguments: '{}' },
      }],
    }] as any;
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      content: 'ok',
      toolCalls: [],
      totalChars: 2,
      preview: 'ok',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args);

    const request = modelStartMock.mock.calls[0][0];
    const payload = JSON.parse(request.messages.find((msg: any) => msg.role === 'tool').content);
    expect(payload.outcome).toEqual({
      kind: 'not_started',
      guidance: 'may_retry',
      evidenceRef: 'ledger://s1/tc-not-started/dispatch',
    });
  });

  it('upgrades a legacy blind-retry result during provider request assembly', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);
    args.currentMessages = [
      {
        role: 'assistant',
        content: 'call tool',
        tool_calls: [{
          id: 'tc-legacy',
          type: 'function',
          function: { name: 'tool_a', arguments: '{}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'tc-legacy',
        content: JSON.stringify({
          error: 'Tool execution was interrupted (session recovered after timeout or crash). Please retry the action.',
          recovered: true,
        }),
      },
    ] as any;
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      content: 'ok',
      toolCalls: [],
      totalChars: 2,
      preview: 'ok',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args);

    const request = modelStartMock.mock.calls[0][0];
    const toolMessages = request.messages.filter(
      (message: any) => message.role === 'tool' && message.tool_call_id === 'tc-legacy',
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).not.toContain('Please retry the action');
    expect(JSON.parse(toolMessages[0].content).outcome).toEqual({
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
    });
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'input.recovery.interrupted_tool_result',
        payload: expect.objectContaining({ decision: 'outcome_unknown' }),
      }),
    );
  });

  it('filters corrupted tool_calls before calling the model', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);

    args.currentMessages = [
      {
        role: 'assistant',
        content: 'call tool',
        tool_calls: [
          { id: 'tc-good', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          { id: 'message[1].role', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'tc-good' },
    ] as any;
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      content: 'ok',
      toolCalls: [],
      totalChars: 2,
      preview: 'ok',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args as any);

    const callArgs = modelStartMock.mock.calls[0][0];
    expect(callArgs.messages[0].tool_calls).toEqual([
      expect.objectContaining({ id: 'tc-good' }),
    ]);
  });

  it('repairs malformed tool_call arguments before model call', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);

    args.currentMessages = [
      {
        role: 'assistant',
        content: 'call tool',
        tool_calls: [
          { id: 'tc-good', type: 'function', function: { name: 'tool_a', arguments: '{bad json' } },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'tc-good' },
    ] as any;
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      content: 'ok',
      toolCalls: [],
      totalChars: 2,
      preview: 'ok',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args as any);

    const callArgs = modelStartMock.mock.calls[0][0];
    expect(callArgs.messages[0].tool_calls[0].function.arguments).toBe('{}');
    expect(callArgs.messages[1]).toEqual({ role: 'tool', content: 'ok', tool_call_id: 'tc-good' });
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'input.sanitized.tool_call_args_repaired',
        payload: expect.objectContaining({ repairedToolCallArguments: 1 }),
      }),
    );
  });

  it('records finishReason in model.call.finish telemetry', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);

    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'done' },
      content: 'done',
      toolCalls: [],
      totalChars: 4,
      preview: 'done',
      finishReason: 'stop',
      chunks: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await controller.run(args as any);

    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'model.call.finish',
        payload: expect.objectContaining({
          finishReason: 'stop',
        }),
      }),
    );
  });

  it('records reasoning token telemetry on model.call.finish', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);

    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'done' },
      content: 'done',
      toolCalls: [],
      totalChars: 4,
      preview: 'done',
      finishReason: 'stop',
      chunks: [],
      usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
      reasoningStats: {
        chars: 48,
        estimatedTokens: 12,
        estimated: true,
      },
    });

    await controller.run(args as any);

    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'model.call.finish',
        payload: expect.objectContaining({
          reasoning: {
            chars: 48,
            estimatedTokens: 12,
            estimated: true,
          },
          tokens: expect.objectContaining({
            input: 10,
            output: 8,
            total: 18,
            reasoning: 12,
            reasoningEstimated: true,
          }),
        }),
      }),
    );
  });

  it('records model call errors and rethrows', async () => {
    const recorder = { write: vi.fn() };
    const { controller, args } = createController({}, recorder);

    modelStartMock.mockRejectedValue(new Error('boom'));

    await expect(controller.run(args as any)).rejects.toThrow('boom');
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'model.call.error',
        payload: expect.objectContaining({ message: 'boom' }),
      }),
    );
  });

  it('records billing metrics on the turn accumulator', async () => {
    const { controller, args } = createController();
    const metricsAccumulator = new TurnMetricsAccumulator();
    args.metricsAccumulator = metricsAccumulator;
    usageRecorderMock.recordUsage.mockResolvedValue({
      nativeCost: 0.003,
      overhead: 0.00045,
      platformCost: 0.00345,
      platformPrice: 0.0069,
      credits: 0.69,
      currency: 'usd',
    });
    modelStartMock.mockResolvedValue({
      message: { role: 'assistant', content: 'hi' },
      content: 'hi',
      toolCalls: [],
      totalChars: 2,
      preview: 'hi',
      chunks: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    await controller.run(args as any);

    expect(metricsAccumulator.toPayload()).toEqual(
      expect.objectContaining({
        llmInputTokens: 10,
        llmOutputTokens: 5,
        nativeCostUsd: 0.003,
        overheadUsd: 0.00045,
        platformCostUsd: 0.00345,
        platformPriceUsd: 0.0069,
        creditsUsed: 0.69,
        currency: 'usd',
        costUsd: 0.0069,
      }),
    );
  });
});







