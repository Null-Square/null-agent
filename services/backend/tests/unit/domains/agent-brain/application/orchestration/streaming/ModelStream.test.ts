import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import type OpenAI from 'openai';
import { ModelStream } from '@/domains/agent-brain/application/orchestration/streaming/ModelStream';
import type { ChatProvider } from '@/domains/agent-brain/adapters/providers';
import { getProviderReasoning } from '@/domains/agent-brain/domain/reasoning/providerReasoning';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';

const createStream = (...chunks: any[]) =>
  (async function* streamGenerator() {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

const baseProvider = (): ChatProvider & { __client: any } => {
  const client = {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  } as unknown as OpenAI;

  return {
    name: 'test-provider',
    __client: client,
    getCapabilities: () => ({
      explicitCacheControl: false,
      automaticCaching: false,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      toolCalling: true,
      streaming: true,
      rateLimitHeaders: false,
    }),
    getClient: () => client,
    buildSystemMessages: vi.fn(),
    decorateRequest: vi.fn((body) => body),
    normalizeUsage: vi.fn(),
    mapError: vi.fn((error: unknown) =>
      error instanceof AppError ? error : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))
    ),
    supportsCacheControl: () => false,
  };
};

describe('ModelStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams text content and emits token callbacks', async () => {
    const provider = baseProvider();
    const onToken = vi.fn();
    const stream = createStream(
      { choices: [{ delta: { content: 'Hel' } }] },
      {
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }],
      }
    );
    (provider.getClient().chat.completions.create as Mock).mockResolvedValue(stream);
    (provider.normalizeUsage as Mock).mockReturnValue({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });

    const modelStream = new ModelStream({ provider });
    modelStream.setModelName('gpt-test');

    const result = await modelStream.start({
      sessionId: 'session-123',
      agentType: 'planner',
      missionPhaseKey: 'planning',
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onToken,
    });

    expect(onToken).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('Hello');
    expect(result.totalChars).toBe(5);
    expect(result.preview).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.chunks.map((c) => c.type)).toEqual(['text', 'text', 'done']);
    expect(provider.decorateRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-test' }),
      expect.objectContaining({
        sessionId: 'session-123',
        agentType: 'planner',
        missionPhaseKey: 'planning',
      }),
    );
  });

  it('parses streamed tool calls and aggregates arguments', async () => {
    const provider = baseProvider();
    const stream = createStream(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-1', function: { name: 'write_file', arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"/tmp/a.txt","content":"hi"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }
    );
    (provider.getClient().chat.completions.create as Mock).mockResolvedValue(stream);

    const modelStream = new ModelStream({ provider });
    const result = await modelStream.start({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call-1',
      function: {
        name: 'write_file',
        arguments: '{"path":"/tmp/a.txt","content":"hi"}',
      },
    });
    expect(result.chunks.find((c) => c.type === 'tool_call')).toEqual({
      type: 'tool_call',
      name: 'write_file',
      args: '{"path":"/tmp/a.txt","content":"hi"}',
    });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('captures reasoning_content deltas without emitting them as visible text', async () => {
    const provider = baseProvider();
    const onToken = vi.fn();
    const stream = createStream(
      { choices: [{ delta: { reasoning_content: 'think ' } }] },
      { choices: [{ delta: { reasoning_content: 'privately' } }] },
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    );
    (provider.getClient().chat.completions.create as Mock).mockResolvedValue(stream);

    const modelStream = new ModelStream({ provider });
    modelStream.setModelName('kimi-k2.6');

    const result = await modelStream.start({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onToken,
    });

    expect(result.content).toBe('done');
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith('done');
    expect(result.reasoning).toEqual(
      expect.objectContaining({
        provider: 'test-provider',
        model: 'kimi-k2.6',
        format: 'reasoning_content',
        content: 'think privately',
      }),
    );
    expect(result.reasoningStats).toEqual({
      chars: 'think privately'.length,
      estimatedTokens: 4,
      tokens: undefined,
      estimated: true,
      source: 'estimated',
    });
    expect(getProviderReasoning(result.message)).toEqual(result.reasoning);
  });

  it('propagates aborts before stream creation', async () => {
    const provider = baseProvider();
    const abortController = new AbortController();
    abortController.abort();
    (provider.getClient().chat.completions.create as Mock).mockRejectedValue(new Error('Aborted'));

    const modelStream = new ModelStream({ provider });

    await expect(
      modelStream.start({ messages: [], tools: [], signal: abortController.signal })
    ).rejects.toThrow('Aborted');
  });

  it('passes the exact turn abort signal to the provider HTTP request', async () => {
    const provider = baseProvider();
    const abortController = new AbortController();
    (provider.getClient().chat.completions.create as Mock).mockResolvedValue(createStream());
    const modelStream = new ModelStream({ provider });
    modelStream.setModelName('deepseek-v4-pro');

    await modelStream.start({
      messages: [],
      tools: [],
      signal: abortController.signal,
    });

    expect(provider.getClient().chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-v4-pro', stream: true }),
      { signal: abortController.signal },
    );
  });

  it('rejects a prepared envelope mutated after persistence before provider dispatch', async () => {
    const provider = baseProvider();
    const modelStream = new ModelStream({ provider });
    modelStream.setModelName('deepseek-v4-pro');
    const prepared = modelStream.prepare({
      messages: [{ role: 'user', content: 'inspect the target' }],
      tools: [{
        type: 'function',
        function: {
          name: 'inspect',
          description: 'Inspect a target',
          parameters: { type: 'object', properties: { target: { type: 'string' } } },
        },
      }],
      signal: new AbortController().signal,
    });
    const tools = prepared.envelope.tools as Array<{
      function: { parameters: Record<string, unknown> };
    }>;
    tools[0].function.parameters = { type: 'object', additionalProperties: true };

    await expect(modelStream.startPrepared(prepared)).rejects.toMatchObject({
      code: 'model_request_digest_mismatch',
    });
    expect(provider.getClient().chat.completions.create).not.toHaveBeenCalled();
  });

  it('interrupts an in-flight provider stream when the turn is aborted', async () => {
    const provider = baseProvider();
    const abortController = new AbortController();
    (provider.getClient().chat.completions.create as Mock).mockImplementation(
      async (_body: unknown, options: { signal: AbortSignal }) =>
        (async function* abortAwareStream() {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          });
          yield { choices: [] };
        })(),
    );
    const modelStream = new ModelStream({ provider });

    const inFlight = modelStream.start({
      messages: [],
      tools: [],
      signal: abortController.signal,
    });
    await vi.waitFor(() => {
      expect(provider.getClient().chat.completions.create).toHaveBeenCalledTimes(1);
    });
    const rejected = expect(inFlight).rejects.toThrow('Aborted');
    abortController.abort('cancelled_by_operator');

    await rejected;
  });

  it('propagates provider errors during streaming', async () => {
    const provider = baseProvider();
    (provider.getClient().chat.completions.create as Mock).mockRejectedValue(
      Object.assign(new Error('Upstream failure'), { status: 500 })
    );
    const modelStream = new ModelStream({ provider });
    modelStream.setModelName('gpt-test');

    await expect(
      modelStream.start({ messages: [], tools: [], signal: new AbortController().signal })
    ).rejects.toThrow('Upstream failure');
    expect(provider.mapError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ model: 'gpt-test', provider: 'test-provider' })
    );
  });
});
