import { describe, expect, it, vi } from 'vitest';
import { TurnStreamController } from '@/domains/agent-brain/application/orchestration/execution/TurnStreamController';
import { TurnMetricsAccumulator } from '@/domains/agent-brain/application/orchestration/execution/TurnMetricsAccumulator';

describe('TurnStreamController trace cleanup', () => {
  it('emits compact model start and finish events with artifact links instead of debug spam', async () => {
    const recorder = {
      write: vi.fn().mockResolvedValue('event-id'),
      writeJsonArtifact: vi
        .fn()
        .mockReturnValueOnce('artifacts/messages.json')
        .mockReturnValueOnce('artifacts/tools.json'),
    };
    const sessionStore = {
      appendMessageAsync: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockReturnValue({ messages: [{ role: 'assistant', content: 'done' }] }),
    };
    const usageRecorder = {
      beginAttempt: vi.fn().mockResolvedValue({ id: 'attempt-1' }),
      failAttempt: vi.fn().mockResolvedValue(undefined),
      recordUsage: vi.fn().mockResolvedValue(undefined),
      recordTurnLatency: vi.fn(),
      setModelName: vi.fn(),
    };
    const model = {
      providerName: 'test-provider',
      setModelName: vi.fn(),
      start: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'done' },
        content: 'done',
        toolCalls: [],
        usage: {
          promptTokens: 10,
          promptTokensDetails: { cachedTokens: 2 },
          completionTokens: 3,
          totalTokens: 13,
        },
        finishReason: 'stop',
      }),
    };
    const stream = {
      token: vi.fn(),
      messageStart: vi.fn(),
      message: vi.fn(),
      messageEnd: vi.fn(),
    };

    const controller = new TurnStreamController({
      model: model as any,
      sessionStore: sessionStore as any,
      usageRecorder: usageRecorder as any,
    });

    await controller.run({
      sessionId: 'sess-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      currentMessages: [{ role: 'user', content: 'hello' }],
      toolDefinitions: [
        {
          type: 'function',
          function: {
            name: 'shell_run',
            description: 'run command',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      stream: stream as any,
      recorder: recorder as any,
      configuredModelName: 'gpt-test',
    });

    const eventNames = recorder.write.mock.calls.map(([, , event]) => event.event);
    expect(eventNames).toEqual(['model.call.start', 'model.call.finish']);
    expect(eventNames).not.toContain('model.call.request');
    expect(eventNames).not.toContain('model.call.messages');
    expect(eventNames).not.toContain('assistant.message.start');
    expect(eventNames).not.toContain('assistant.message.delta');
    expect(eventNames).not.toContain('assistant.message.finish');
    expect(eventNames).not.toContain('model.call.delta');

    const startEvent = recorder.write.mock.calls[0][2];
    expect(startEvent).toEqual(expect.objectContaining({
      event: 'model.call.start',
      links: {
        messages: 'artifacts/messages.json',
        tools: 'artifacts/tools.json',
      },
    }));
    expect(startEvent.payload).toEqual(expect.objectContaining({
      model: 'gpt-test',
      messages: 1,
      messageDigest: expect.stringMatching(/^sha256:/),
      messageShape: 'user',
      tools: ['shell_run'],
      toolCount: 1,
      toolDigest: expect.stringMatching(/^sha256:/),
    }));

    const finishEvent = recorder.write.mock.calls[1][2];
    expect(finishEvent.payload).toEqual(expect.objectContaining({
      toolCalls: 0,
      status: 'completed',
      assistantChars: 4,
      assistantPreview: 'done',
      tokens: {
        input: 10,
        output: 3,
        cached: 2,
        total: 13,
      },
    }));
  });

  it('writes first and final message snapshots while reusing unchanged tool snapshots', async () => {
    const recorder = {
      write: vi.fn().mockResolvedValue('event-id'),
      writeJsonArtifact: vi.fn((_sessionId: string, name: string) => `artifacts/${name}.json`),
    };
    const sessionStore = {
      appendMessageAsync: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockReturnValue({ messages: [{ role: 'assistant', content: 'done' }] }),
    };
    const usageRecorder = {
      beginAttempt: vi.fn()
        .mockResolvedValueOnce({ id: 'attempt-1' })
        .mockResolvedValueOnce({ id: 'attempt-2' })
        .mockResolvedValueOnce({ id: 'attempt-3' }),
      failAttempt: vi.fn().mockResolvedValue(undefined),
      recordUsage: vi.fn().mockResolvedValue(undefined),
      recordTurnLatency: vi.fn(),
      setModelName: vi.fn(),
    };
    const makeToolCallResult = (id: string) => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id,
          type: 'function',
          function: { name: 'shell_run', arguments: '{}' },
        }],
      },
      content: '',
      toolCalls: [{
        id,
        type: 'function',
        function: { name: 'shell_run', arguments: '{}' },
      }],
      usage: {
        promptTokens: 10,
        completionTokens: 3,
        totalTokens: 13,
      },
      finishReason: 'tool_calls',
    });
    const model = {
      providerName: 'test-provider',
      setModelName: vi.fn(),
      start: vi.fn()
        .mockResolvedValueOnce(makeToolCallResult('call-1'))
        .mockResolvedValueOnce(makeToolCallResult('call-2'))
        .mockResolvedValueOnce({
          message: { role: 'assistant', content: 'done' },
          content: 'done',
          toolCalls: [],
          usage: {
            promptTokens: 10,
            completionTokens: 3,
            totalTokens: 13,
          },
          finishReason: 'stop',
        }),
    };
    const stream = {
      token: vi.fn(),
      messageStart: vi.fn(),
      message: vi.fn(),
      messageEnd: vi.fn(),
    };
    const toolDefinitions = [
      {
        type: 'function' as const,
        function: {
          name: 'shell_run',
          description: 'run command',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];

    const controller = new TurnStreamController({
      model: model as any,
      sessionStore: sessionStore as any,
      usageRecorder: usageRecorder as any,
    });
    const baseArgs = {
      sessionId: 'sess-1',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      toolDefinitions,
      stream: stream as any,
      recorder: recorder as any,
      configuredModelName: 'gpt-test',
    };

    await controller.run({
      ...baseArgs,
      currentMessages: [{ role: 'user', content: 'hello' }],
    } as any);
    await controller.run({
      ...baseArgs,
      currentMessages: [{ role: 'user', content: 'hello again' }],
    } as any);
    await controller.run({
      ...baseArgs,
      currentMessages: [{ role: 'user', content: 'final answer now' }],
    } as any);

    const artifactNames = recorder.writeJsonArtifact.mock.calls.map(([, name]) => name as string);
    expect(artifactNames.filter((name) => name.includes('-messages'))).toHaveLength(2);
    expect(artifactNames.filter((name) => name.includes('-tools'))).toHaveLength(1);

    const startEvents = recorder.write.mock.calls
      .map(([, , event]) => event)
      .filter((event) => event.event === 'model.call.start');
    expect(startEvents).toHaveLength(3);
    expect(startEvents[0].links.messages).toBeDefined();
    expect(startEvents[1].links.messages).toBeUndefined();
    expect(startEvents[2].links.messages).toBeUndefined();
    expect(startEvents[0].links.tools).toBe(startEvents[1].links.tools);
    expect(startEvents[0].links.tools).toBe(startEvents[2].links.tools);
  });

  const buildDeps = (streamedText: string | null) => {
    const recorder = {
      write: vi.fn().mockResolvedValue('event-id'),
      writeJsonArtifact: vi.fn().mockReturnValue('artifacts/x.json'),
    };
    const sessionStore = {
      appendMessageAsync: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockReturnValue({ messages: [{ role: 'assistant', content: 'done' }] }),
    };
    const usageRecorder = {
      beginAttempt: vi.fn().mockResolvedValue({ id: 'attempt-1' }),
      failAttempt: vi.fn().mockResolvedValue(undefined),
      recordUsage: vi.fn().mockResolvedValue(undefined),
      recordTurnLatency: vi.fn(),
      setModelName: vi.fn(),
    };
    const model = {
      providerName: 'test-provider',
      setModelName: vi.fn(),
      start: vi.fn().mockImplementation(async (request: any) => {
        if (streamedText !== null) {
          // The provider's first chunk. This is the only place the elapsed time to
          // a first token is observable, which is why the measurement lives on it.
          for (const chunk of streamedText.split('')) request.onToken?.(chunk);
        }
        return {
          message: { role: 'assistant', content: streamedText ?? '' },
          content: streamedText ?? '',
          toolCalls: [],
          usage: {
            promptTokens: 10,
            promptTokensDetails: { cachedTokens: 0 },
            completionTokens: 3,
            totalTokens: 13,
          },
          finishReason: 'stop',
        };
      }),
    };
    const stream = { token: vi.fn(), messageStart: vi.fn(), message: vi.fn(), messageEnd: vi.fn() };
    return { recorder, sessionStore, usageRecorder, model, stream };
  };

  const runOnce = async (streamedText: string | null) => {
    const deps = buildDeps(streamedText);
    const metricsAccumulator = new TurnMetricsAccumulator();
    const controller = new TurnStreamController({
      model: deps.model as any,
      sessionStore: deps.sessionStore as any,
      usageRecorder: deps.usageRecorder as any,
    });
    await controller.run({
      sessionId: 'sess-ttft',
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      currentMessages: [{ role: 'user', content: 'hello' }],
      toolDefinitions: [],
      stream: deps.stream as any,
      recorder: deps.recorder as any,
      configuredModelName: 'gpt-test',
      metricsAccumulator,
    } as any);
    const finish = deps.recorder.write.mock.calls
      .map(([, , event]: any[]) => event)
      .find((event: any) => event.event === 'model.call.finish');
    return { finish, payload: metricsAccumulator.toPayload() };
  };

  it('measures the first streamed token and carries it into the trace and the turn metrics', async () => {
    const { finish, payload } = await runOnce('done');

    expect(typeof finish.payload.ttftMs).toBe('number');
    expect(finish.payload.ttftMs).toBeLessThanOrEqual(finish.payload.latencyMs);
    // Wired, not merely defined: the accumulator saw the same measurement.
    expect(payload.llmTtftSamples).toBe(1);
  });

  it('omits the first-token measurement when the response streamed no text', async () => {
    const { finish, payload } = await runOnce(null);

    // Absent, not zero. Zero would read as a first token that arrived instantly.
    expect(finish.payload).not.toHaveProperty('ttftMs');
    expect(payload.llmTtftSamples).toBe(0);
    expect(typeof finish.payload.latencyMs).toBe('number');
  });
});
