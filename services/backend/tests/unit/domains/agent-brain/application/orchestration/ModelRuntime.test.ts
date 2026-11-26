import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@/domains/agent-brain/application/orchestration/ModelRuntime';
import {
  cacheLineage,
  resetCacheLineageForTests,
} from '@/domains/agent-brain/application/orchestration/cacheLineageRegistry';
import {
  buildProviderCacheProjection,
  digestOf,
} from '@/domains/agent-brain/domain/cache';
import { canonicalizeModelRequestEnvelope } from '@/domains/agent-brain/domain/modelRequests/canonicalModelRequest';
import { getLLMCircuitBreaker } from '@/domains/agent-brain/application/services/CircuitBreaker';

const request = {
  sessionId: 'session-1',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
  signal: new AbortController().signal,
  maxTokens: 100,
};

const result = {
  message: { role: 'assistant' as const, content: 'done' },
  content: 'done',
  toolCalls: [],
  totalChars: 4,
  preview: 'done',
  chunks: [{ type: 'done' as const }],
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  providerRequestId: 'provider-request-1',
  reportedModel: 'deepseek-v4-pro',
};

const createUsageRecorder = () => ({
  beginAttempt: vi.fn(async (_sessionId, input) => ({ id: `attempt-${input.attemptOrdinal}` })),
  failAttempt: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => ({
    promptTokens: 10,
    cachedPromptTokens: 0,
    completionTokens: 2,
    totalTokens: 12,
    nativeCost: 0.001,
    overhead: 0,
    platformCost: 0.001,
    platformPrice: 0.001,
    credits: 0.1,
    currency: 'usd',
    model: 'deepseek-v4-pro',
  })),
});

describe('ModelRuntime', () => {
  it('does not escape the subscription category allowlist when no candidate exists', async () => {
    const port = {
      getModel: vi.fn(),
      getDefaultModel: vi.fn(async () => ({
        modelName: 'premium-model',
        provider: 'openai',
        selectionCategory: 'extra_high',
      })),
      listModelsForCategory: vi.fn(async () => []),
    } as any;

    await expect(new ModelRuntime().resolveSessionModel({
      modelConfigPort: port,
      allowedCategories: ['low'],
    })).resolves.toBeNull();
    await expect(new ModelRuntime().resolveSessionModel({
      modelConfigPort: port,
      requestedCategory: 'high',
      allowedCategories: ['low'],
    })).resolves.toBeNull();
  });

  it('skips an unconfigured automatic candidate instead of failing the whole lane', async () => {
    const configured = {
      modelName: 'configured-model',
      provider: 'openai',
      apiKey: 'secret',
      selectionCategory: 'high',
      isActive: true,
    };
    const port = {
      getModel: vi.fn(),
      getDefaultModel: vi.fn(async () => null),
      listModelsForCategory: vi.fn(async () => [
        { ...configured, modelName: 'missing-credential', apiKey: undefined },
        configured,
      ]),
    } as any;

    await expect(new ModelRuntime().resolveSessionModel({
      modelConfigPort: port,
      requestedCategory: 'high',
    })).resolves.toBe(configured);
  });

  it('writes the frozen attempt before the only remote dispatch', async () => {
    const order: string[] = [];
    const usageRecorder = createUsageRecorder();
    usageRecorder.beginAttempt.mockImplementation(async () => {
      order.push('ledger');
      return { id: 'attempt-1' } as any;
    });
    const model = {
      providerName: 'deepseek-success',
      start: vi.fn(async () => {
        order.push('provider');
        return result;
      }),
    };

    const executed = await new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    });

    expect(order).toEqual(['ledger', 'provider']);
    expect(executed.attempts).toBe(1);
    expect(usageRecorder.recordUsage).toHaveBeenCalledWith(
      'session-1',
      result.usage,
      expect.objectContaining({ attemptId: 'attempt-1', providerRequestId: 'provider-request-1' }),
    );
  });

  it('appends one canonical request before both retry attempts', async () => {
    const order: string[] = [];
    const retryable = Object.assign(new Error('transport unavailable'), {
      retryable: true,
      retryAfterMs: 0,
      modelAttemptStatus: 'failed' as const,
      modelOutputStarted: false,
    });
    const canonical = canonicalizeModelRequestEnvelope({
      model: 'deepseek-v4-pro',
      messages: request.messages,
      tools: request.tools,
      stream: true,
      max_tokens: request.maxTokens,
    });
    const model = {
      providerName: 'deepseek-atomic',
      getContextCapacity: vi.fn(() => 128_000),
      prepare: vi.fn(() => ({
        envelope: canonical.envelope,
        digest: canonical.digest,
        signal: request.signal,
      })),
      startPrepared: vi.fn()
        .mockImplementationOnce(async () => {
          order.push('provider-1');
          throw retryable;
        })
        .mockImplementationOnce(async () => {
          order.push('provider-2');
          return result;
        }),
    };
    const records: any[] = [];
    const modelRequestPort = {
      append: vi.fn(async (input) => {
        order.push('request');
        const record = { ...input, provenance: 'recorded', createdAt: new Date() };
        records.push(record);
        return record;
      }),
      findByRequestId: vi.fn(),
      findBySession: vi.fn(),
    };
    const usageRecorder = createUsageRecorder();
    usageRecorder.beginAttempt.mockImplementation(async (_sessionId, input) => {
      order.push(`attempt-${input.attemptOrdinal}`);
      return { id: `attempt-${input.attemptOrdinal}` } as any;
    });

    const executed = await new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 2,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
      modelRequestPort: modelRequestPort as any,
      modelRequestCapability: {
        owner: 'test.model-requests',
        durability: 'durable',
        schemaVersion: 3,
      },
      maxRetries: 1,
      routedContextCapacity: 196_608,
      contextMeasurementHints: {
        capacitySource: 'model_config',
        reducerProfile: 'code_review',
        reducerReason: 'request_measurement',
      },
      transformationRefs: ['messages:fixture', 'tools:fixture'],
    });

    expect(order).toEqual(['request', 'attempt-1', 'provider-1', 'attempt-2', 'provider-2']);
    expect(model.prepare).toHaveBeenCalledWith(expect.objectContaining({ turnNumber: 2 }));
    expect(modelRequestPort.append).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      requestId: executed.requestId,
      digest: canonical.digest,
      messages: request.messages,
      tools: request.tools,
      routedContextCapacity: 196_608,
      schemaVersion: 3,
      contextMeasurement: expect.objectContaining({
        requestId: executed.requestId,
        routedCapacity: 196_608,
        capacitySource: 'model_config',
        reducerProfile: 'code_review',
        countingMethod: 'conservative_json_chars_div_4_v1',
      }),
    });
    expect(records[0].contextMeasurementRefs).toContain(
      records[0].contextMeasurement.measurementId,
    );
    const attemptInputs = usageRecorder.beginAttempt.mock.calls.map((call) => call[1]);
    expect(attemptInputs[0].modelRequestId).toBe(executed.requestId);
    expect(attemptInputs[1].modelRequestId).toBe(executed.requestId);
    expect(usageRecorder.beginAttempt.mock.results).toHaveLength(2);
  });

  it('does not append partial provider output to the canonical request history', async () => {
    const originalMessages = structuredClone(request.messages);
    const canonical = canonicalizeModelRequestEnvelope({
      model: 'deepseek-v4-pro',
      messages: request.messages,
      stream: true,
    });
    const interrupted = Object.assign(new Error('partial stream'), {
      retryable: true,
      modelAttemptStatus: 'uncertain' as const,
      modelOutputStarted: true,
    });
    let recordedMessages: unknown;
    const modelRequestPort = {
      append: vi.fn(async (input) => {
        recordedMessages = structuredClone(input.messages);
        return { ...input, provenance: 'recorded', createdAt: new Date() };
      }),
      findByRequestId: vi.fn(),
      findBySession: vi.fn(),
    };
    const model = {
      providerName: 'deepseek-partial',
      getContextCapacity: () => 128_000,
      prepare: () => ({
        envelope: canonical.envelope,
        digest: canonical.digest,
        signal: request.signal,
      }),
      startPrepared: vi.fn(async () => { throw interrupted; }),
    };

    await expect(new ModelRuntime().execute({
      model: model as any,
      usageRecorder: createUsageRecorder() as any,
      request,
      sessionId: 'session-1',
      turn: 2,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
      modelRequestPort: modelRequestPort as any,
      modelRequestCapability: {
        owner: 'test.model-requests',
        durability: 'durable',
        schemaVersion: 2,
      },
    })).rejects.toThrow('partial stream');

    expect(recordedMessages).toEqual(originalMessages);
    expect(request.messages).toEqual(originalMessages);
    expect(model.startPrepared).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when the durable started attempt cannot be written', async () => {
    const usageRecorder = createUsageRecorder();
    usageRecorder.beginAttempt.mockRejectedValue(new Error('ledger unavailable'));
    const model = { providerName: 'deepseek-no-ledger', start: vi.fn() };

    await expect(new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    })).rejects.toThrow('ledger unavailable');
    expect(model.start).not.toHaveBeenCalled();
  });

  it('creates a separate durable row for every retry', async () => {
    const retryable = Object.assign(new Error('overloaded'), {
      code: 'network.connection_failed',
      retryable: true,
      retryAfterMs: 0,
      modelAttemptStatus: 'failed' as const,
      modelOutputStarted: false,
    });
    const model = {
      providerName: 'deepseek-retry',
      start: vi.fn()
        .mockRejectedValueOnce(retryable)
        .mockResolvedValueOnce(result),
    };
    const usageRecorder = createUsageRecorder();

    const executed = await new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    });

    expect(executed.attempts).toBe(2);
    expect(usageRecorder.beginAttempt.mock.calls.map((call) => call[1].attemptOrdinal)).toEqual([1, 2]);
    expect(usageRecorder.failAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      status: 'failed',
      errorClass: 'network.connection_failed',
      retryDecision: 'retry',
      backoffMs: 0,
    }));
  });

  it('records a non-retryable provider failure as one stopped attempt', async () => {
    const rejected = Object.assign(new Error('invalid authentication'), {
      code: 'auth.invalid_api_key',
      retryable: false,
      modelAttemptStatus: 'failed' as const,
      modelOutputStarted: false,
    });
    const model = {
      providerName: 'provider-non-retryable',
      start: vi.fn(async () => { throw rejected; }),
    };
    const usageRecorder = createUsageRecorder();

    await expect(new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'test-model',
      maxRetries: 3,
    })).rejects.toBe(rejected);

    expect(model.start).toHaveBeenCalledTimes(1);
    expect(usageRecorder.beginAttempt).toHaveBeenCalledTimes(1);
    expect(usageRecorder.failAttempt).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorClass: 'auth.invalid_api_key',
      retryDecision: 'stop',
      backoffMs: undefined,
    }));
    expect(getLLMCircuitBreaker('provider-non-retryable').getStats()).toMatchObject({
      failures: 0,
      totalFailures: 0,
    });
  });

  it('hands typed context overflow to E5 instead of retrying inside the provider loop', async () => {
    const overflow = Object.assign(new Error('context too long'), {
      code: 'llm.context_length_exceeded',
      retryable: true,
      modelAttemptStatus: 'failed' as const,
      modelOutputStarted: false,
    });
    const model = {
      providerName: 'provider-overflow',
      start: vi.fn(async () => { throw overflow; }),
    };
    const usageRecorder = createUsageRecorder();

    await expect(new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'test-model',
      maxRetries: 3,
    })).rejects.toBe(overflow);

    expect(model.start).toHaveBeenCalledTimes(1);
    expect(usageRecorder.failAttempt).toHaveBeenCalledWith(expect.objectContaining({
      retryDecision: 'overflow_recovery',
      backoffMs: undefined,
    }));
  });

  it('persists cancellation before rejecting a provider result that arrives late', async () => {
    const controller = new AbortController();
    let release: ((value: typeof result) => void) | undefined;
    const lateResult = new Promise<typeof result>((resolve) => { release = resolve; });
    const model = {
      providerName: 'provider-cancel-race',
      start: vi.fn(() => lateResult),
    };
    const usageRecorder = createUsageRecorder();
    const execution = new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request: { ...request, signal: controller.signal },
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'test-model',
    });
    await vi.waitFor(() => expect(usageRecorder.beginAttempt).toHaveBeenCalledTimes(1));
    controller.abort('cancelled-by-test');
    release?.(result);

    await expect(execution).rejects.toThrow(/cancellation/u);
    expect(usageRecorder.failAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      status: 'cancelled',
      errorClass: 'request_cancelled',
      retryDecision: 'stop',
    }));
    expect(usageRecorder.recordUsage).not.toHaveBeenCalled();
  });

  it('passes provider reasoning source into durable usage settlement', async () => {
    const model = {
      providerName: 'provider-reasoning',
      start: vi.fn(async () => ({
        ...result,
        reasoningStats: {
          chars: 120,
          estimatedTokens: 30,
          tokens: 2,
          estimated: false,
          source: 'reported' as const,
        },
      })),
    };
    const usageRecorder = createUsageRecorder();

    await new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'test-model',
    });

    expect(usageRecorder.recordUsage).toHaveBeenCalledWith(
      'session-1',
      result.usage,
      expect.objectContaining({ reasoningTokens: 2, reasoningSource: 'reported' }),
    );
  });

  it('does not retry after any provider output has started', async () => {
    const interrupted = Object.assign(new Error('stream interrupted'), {
      retryable: true,
      modelAttemptStatus: 'uncertain' as const,
      modelOutputStarted: true,
    });
    const model = { providerName: 'deepseek-output', start: vi.fn(async () => { throw interrupted; }) };
    const usageRecorder = createUsageRecorder();

    await expect(new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    })).rejects.toThrow('stream interrupted');
    expect(model.start).toHaveBeenCalledTimes(1);
    expect(usageRecorder.failAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: 'uncertain' }));
  });

  it('keeps a useful response while marking missing provider usage uncertain', async () => {
    const model = {
      providerName: 'deepseek-missing-usage',
      start: vi.fn(async () => ({ ...result, usage: undefined })),
    };
    const usageRecorder = createUsageRecorder();

    const executed = await new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    });

    expect(executed.result.content).toBe('done');
    expect(usageRecorder.failAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: 'uncertain' }));
    expect(usageRecorder.recordUsage).not.toHaveBeenCalled();
  });

  it('preserves a useful provider result when finalization remains pending', async () => {
    const model = { providerName: 'deepseek-finalization', start: vi.fn(async () => result) };
    const usageRecorder = createUsageRecorder();
    usageRecorder.recordUsage.mockRejectedValue(new Error('finalization unavailable'));

    const executed = await new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    });

    expect(executed.result.content).toBe('done');
    expect(executed.usageSummary).toBeUndefined();
    expect(usageRecorder.recordUsage).toHaveBeenCalledTimes(3);
    expect(usageRecorder.failAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      status: 'uncertain',
      providerRequestId: 'provider-request-1',
    }));
  });

  it('retries only finalization after a useful provider result', async () => {
    const model = { providerName: 'deepseek-finalization-retry', start: vi.fn(async () => result) };
    const usageRecorder = createUsageRecorder();
    usageRecorder.recordUsage
      .mockRejectedValueOnce(new Error('temporary finalization failure'))
      .mockResolvedValueOnce({
        promptTokens: 10,
        cachedPromptTokens: 0,
        completionTokens: 2,
        totalTokens: 12,
        nativeCost: 0.001,
        overhead: 0,
        platformCost: 0.001,
        platformPrice: 0.001,
        credits: 0.1,
        currency: 'usd',
        model: 'deepseek-v4-pro',
      });

    const executed = await new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    });

    expect(model.start).toHaveBeenCalledTimes(1);
    expect(usageRecorder.recordUsage).toHaveBeenCalledTimes(2);
    expect(executed.usageSummary?.totalTokens).toBe(12);
  });

  it('does not replace a provider error when failure finalization is unavailable', async () => {
    const providerError = Object.assign(new Error('provider unavailable'), {
      retryable: true,
      modelAttemptStatus: 'failed' as const,
      modelOutputStarted: false,
    });
    const model = {
      providerName: 'deepseek-failure-finalization',
      start: vi.fn(async () => { throw providerError; }),
    };
    const usageRecorder = createUsageRecorder();
    usageRecorder.failAttempt.mockRejectedValue(new Error('ledger update unavailable'));

    await expect(new ModelRuntime().execute({
      model: model as any,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
    })).rejects.toBe(providerError);
    expect(model.start).toHaveBeenCalledTimes(1);
  });
});

describe('ModelRuntime cache lineage wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetCacheLineageForTests();
  });

  const projectionFor = (segmentDigest: string) => buildProviderCacheProjection({
    identity: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      tenantDigest: digestOf('t'),
      translationVersion: 'openai-compatible/v1',
    },
    segments: [
      { kind: 'system', key: 'system:0', digest: 'sha256:stable', estimatedTokens: 100 },
      { kind: 'message', key: 'message:1', digest: segmentDigest, estimatedTokens: 20 },
    ],
  });

  const atomicPort = () => ({
    append: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      provenance: 'recorded',
      createdAt: new Date(),
    })),
    findByRequestId: vi.fn(),
    findBySession: vi.fn(),
  });

  const atomicModel = (usage: Record<string, unknown>, segmentDigest: string) => {
    const canonical = canonicalizeModelRequestEnvelope({
      model: 'deepseek-v4-pro',
      messages: request.messages,
      tools: request.tools,
      stream: true,
      max_tokens: request.maxTokens,
    });
    return {
      providerName: 'deepseek',
      getContextCapacity: vi.fn(() => 128_000),
      prepare: vi.fn(() => ({
        envelope: canonical.envelope,
        digest: canonical.digest,
        signal: request.signal,
      })),
      projectCacheSurface: vi.fn(() => projectionFor(segmentDigest)),
      startPrepared: vi.fn(async () => ({ ...result, usage })),
    };
  };

  const execute = (model: unknown, port: unknown, turn: number) =>
    new ModelRuntime().execute({
      model: model as never,
      usageRecorder: createUsageRecorder() as never,
      request,
      sessionId: 'lineage-session',
      turn,
      callOrdinal: 1,
      configuredModelName: 'deepseek-v4-pro',
      modelRequestPort: port as never,
      modelRequestCapability: {
        owner: 'test.model-requests',
        durability: 'durable',
        schemaVersion: 3,
      },
    });

  it('records an expectation from the verified request and an observation from the attempt', async () => {
    const expectations = vi.spyOn(cacheLineage.observe(), 'recordExpectation');
    const observations = vi.spyOn(cacheLineage.observe(), 'recordObservation');
    const port = atomicPort();
    const usage = {
      promptTokens: 120,
      completionTokens: 2,
      totalTokens: 122,
      promptTokensDetails: { cachedTokens: 100 },
    };

    await execute(atomicModel(usage, 'sha256:first'), port, 1);

    expect(expectations).toHaveBeenCalledTimes(1);
    expect(observations).toHaveBeenCalledTimes(1);
    // The expectation is recorded only after the durable record's digest is verified.
    expect(port.append).toHaveBeenCalledTimes(1);
    expect(observations.mock.calls[0]![0]).toMatchObject({
      telemetryState: 'reported',
      cacheReadTokens: 100,
      uncachedInputTokens: 20,
      attemptOrdinal: 1,
    });
  });

  it('never turns absent provider cache telemetry into a zero-token miss', async () => {
    const observations = vi.spyOn(cacheLineage.observe(), 'recordObservation');
    const usage = { promptTokens: 120, completionTokens: 2, totalTokens: 122 };

    await execute(atomicModel(usage, 'sha256:first'), atomicPort(), 1);

    const recorded = observations.mock.calls[0]![0];
    expect(recorded.telemetryState).toBe('not_reported');
    expect(recorded.cacheReadTokens).toBeUndefined();
  });

  it('compares the second request against the first rather than against itself', async () => {
    const expectations = vi.spyOn(cacheLineage.observe(), 'recordExpectation');
    const usage = {
      promptTokens: 120,
      completionTokens: 2,
      totalTokens: 122,
      promptTokensDetails: { cachedTokens: 100 },
    };

    const first = await execute(atomicModel(usage, 'sha256:first'), atomicPort(), 1);
    const second = await execute(atomicModel(usage, 'sha256:changed'), atomicPort(), 2);

    expect(first.requestId).not.toBe(second.requestId);
    const relations = expectations.mock.results.map((entry) => (entry.value as { structuralRelation: string }).structuralRelation);
    expect(relations[0]).toBe('first_request');
    // The stable system segment is reusable; the changed message segment is not.
    expect(relations[1]).toBe('unexplained_divergence');
    expect((expectations.mock.results[1]!.value as { estimatedReusableTokens: number }).estimatedReusableTokens).toBe(100);
  });

  it('does not fail a model call when the projection throws', async () => {
    const model = atomicModel(
      { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      'sha256:first',
    );
    model.projectCacheSurface = vi.fn(() => {
      throw new Error('projection unavailable');
    }) as never;

    await expect(execute(model, atomicPort(), 1)).resolves.toMatchObject({ attempts: 1 });
  });
});
