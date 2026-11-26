import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOKEN_USAGE_FLAG,
  TOKEN_USAGE_HISTORY_FLAG,
  UsageRecorder,
} from '@/domains/agent-brain/infrastructure/usage/UsageRecorder';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { CompleteUsageAttemptInput, UsageStorePort } from '@/domains/agent-brain/ports';

describe('UsageRecorder', () => {
  let session: any;
  let sessionStore: SessionStore;
  let usageStore: UsageStorePort;
  let recorder: UsageRecorder;

  beforeEach(() => {
    session = {
      id: 'test-session',
      flags: {
        securityops: { organizationId: 'org-1' },
        model_selection: { resolvedModelId: 'model-1' },
      },
      usage: undefined,
    };
    sessionStore = { get: vi.fn(() => session), set: vi.fn() } as any;
    usageStore = {
      billingMode: 'billable',
      beginAttempt: vi.fn(async (input) => {
        return {
        id: 'attempt-1',
        logicalCallKey: input.logicalCallKey,
        attemptOrdinal: input.attemptOrdinal,
        modelId: 'model-1',
        modelName: input.modelName,
        provider: input.provider,
        requestStartedAt: input.requestStartedAt,
        executionBackend: input.executionBackend ?? 'api',
        rateCardId: 'rate-1',
        rateWindowId: null,
        currency: 'usd',
        cacheHitRatePer1m: 2,
        cacheMissRatePer1m: 10,
        outputRatePer1m: 30,
      };
      }),
      completeAttempt: vi.fn(async (input: CompleteUsageAttemptInput) => {
        const billing = { platformMargin: 0, overheadMultiplier: 0, creditRatePerUsd: 0 };
        const nativeCost = (input.promptTokens + (input.cacheWriteTokens ?? 0)) / 100_000
          + input.cachedPromptTokens / 500_000
          + input.completionTokens * 30 / 1_000_000;
        return {
          id: input.attemptId,
          status: 'completed' as const,
          debitStatus: 'not_applicable' as const,
          promptTokens: input.promptTokens,
          cachedPromptTokens: input.cachedPromptTokens,
          cacheWriteTokens: input.cacheWriteTokens ?? 0,
          completionTokens: input.completionTokens,
          totalTokens: input.totalTokens,
          nativeCost,
          overhead: 0,
          platformCost: nativeCost,
          platformPrice: nativeCost,
          credits: 0,
          debitedCredits: 0,
          currency: 'usd',
          model: 'test-model',
          reasoningTokens: input.reasoningTokens ?? 0,
          reasoningSource: input.reasoningSource ?? 'unavailable',
          billing,
          creditExempt: true,
        };
      }),
      failAttempt: vi.fn(),
      recordTurnUsage: vi.fn(),
      getSessionSummary: vi.fn(),
    };
    recorder = new UsageRecorder(
      sessionStore,
      undefined,
      usageStore,
      'test-model',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('persists the complete frozen route before dispatch', async () => {
    const handle = await recorder.beginAttempt('test-session', {
      turn: 2,
      logicalCallKey: 'test-session:2:1',
      attemptOrdinal: 1,
      callOrdinal: 1,
      provider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      requestedCategory: 'low',
      routeReason: 'session_pinned',
      fallbackOrdinal: 0,
      requestStartedAt: new Date('2026-08-20T02:00:00Z'),
    });

    expect(handle.id).toBe('attempt-1');
    expect(usageStore.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'test-session',
      logicalCallKey: 'test-session:2:1',
      modelId: 'model-1',
      modelName: 'deepseek-v4-pro',
    }));
  });

  it('keeps external backend identity separate from the pinned provider identity', async () => {
    session.flags = {
      securityops: { organizationId: 'org-1' },
      model_selection: { resolvedModelId: 'legacy-model-id' },
      execution_profile: {
        version: 1,
        routeId: 'codex-subscription',
        catalogueRevision: 'r1',
        providerIdentity: 'OPENAI',
        executionBackend: 'codex-app-server',
        authMode: 'external-subscription',
        accountingMode: 'external-subscription',
        consumesPlatformCredits: true,
        requiresPlatformCreditAdmission: true,
        requestedModel: 'gpt-5.6-sol',
        effectiveModel: 'gpt-5.6-sol',
        pricingModelId: 'pricing-gpt-sol',
        controls: { effort: 'xhigh' },
        faultDomain: 'external:codex-subscription:gpt-5.6-sol',
      },
    };

    await recorder.beginAttempt('test-session', {
      logicalCallKey: 'test-session:1:1',
      attemptOrdinal: 1,
      callOrdinal: 1,
      provider: 'codex-app-server',
      modelName: 'gpt-5.6-sol',
      executionBackend: 'codex-app-server',
      routeReason: 'session_pinned',
      fallbackOrdinal: 0,
      requestStartedAt: new Date('2026-08-28T13:03:29Z'),
    });

    expect(usageStore.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'pricing-gpt-sol',
      provider: 'OPENAI',
      modelName: 'gpt-5.6-sol',
      effectiveModelName: 'gpt-5.6-sol',
      executionBackend: 'codex-app-server',
    }));
  });

  it('finalizes cached and uncached tokens through the durable attempt', async () => {
    const summary = await recorder.recordUsage('test-session', {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      promptTokensDetails: { cachedTokens: 800 },
    }, { turn: 2, attemptId: 'attempt-1', reportedModel: 'deepseek-v4-pro' });

    expect(usageStore.completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      promptTokens: 200,
      cachedPromptTokens: 800,
      completionTokens: 500,
      totalTokens: 1500,
    }));
    expect(summary?.nativeCost).toBeCloseTo(0.0186);
    expect((session.flags[TOKEN_USAGE_FLAG] as any).cachedPromptTokens).toBe(800);
    expect((session.flags[TOKEN_USAGE_FLAG] as any).promptTokens).toBe(200);
  });

  it('persists the session requested category when a call path omits it', async () => {
    session.flags.model_selection.requestedCategory = 'low';

    await recorder.beginAttempt('test-session', {
      turn: 2,
      logicalCallKey: 'test-session:2:auxiliary:1',
      attemptOrdinal: 1,
      callOrdinal: 1,
      provider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      routeReason: 'duplicate_judge',
      fallbackOrdinal: 0,
      requestStartedAt: new Date('2026-08-20T02:00:00Z'),
    });

    expect(usageStore.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      requestedCategory: 'low',
      routeReason: 'duplicate_judge',
    }));
  });

  it('preserves cache reads, cache writes, and reasoning provenance separately', async () => {
    const summary = await recorder.recordUsage('test-session', {
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
      promptTokensDetails: { cachedTokens: 300, cacheWriteTokens: 200 },
    }, {
      turn: 2,
      attemptId: 'attempt-1',
      reasoningTokens: 20,
      reasoningSource: 'estimated',
    });

    expect(usageStore.completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: 500,
      cachedPromptTokens: 300,
      cacheWriteTokens: 200,
      completionTokens: 100,
      reasoningTokens: 20,
      reasoningSource: 'estimated',
      totalTokens: 1100,
    }));
    expect(summary).toMatchObject({
      promptTokens: 500,
      cachedPromptTokens: 300,
      cacheWriteTokens: 200,
    });
    expect(session.flags[TOKEN_USAGE_FLAG]).toMatchObject({
      promptTokens: 500,
      cachedPromptTokens: 300,
      cacheWriteTokens: 200,
    });
  });

  it('does not charge an impossible provider cache count', async () => {
    await expect(recorder.recordUsage('test-session', {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      promptTokensDetails: { cachedTokens: 101 },
    }, { turn: 2, attemptId: 'attempt-1' })).rejects.toThrow(
      'cache read and cache write tokens cannot exceed promptTokens',
    );

    expect(usageStore.completeAttempt).not.toHaveBeenCalled();
  });

  it('retains prompt-estimate telemetry after ledger finalization', async () => {
    session.flags = { context_budget_last: { totalPromptEstimate: 900, toolSchemaTokens: 30 } };
    await recorder.recordUsage('test-session', {
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
    }, { turn: 3, attemptId: 'attempt-1' });

    expect(session.flags[TOKEN_USAGE_HISTORY_FLAG]).toEqual(expect.objectContaining({
      entries: expect.arrayContaining([expect.objectContaining({
        estimatedPromptTokens: 900,
        promptEstimateDelta: 100,
      })]),
    }));
  });

  it('blocks provider dispatch when the durable store is absent', async () => {
    const unavailable = new UsageRecorder(sessionStore, undefined, undefined, 'test-model');
    await expect(unavailable.beginAttempt('test-session', {
      logicalCallKey: 'call',
      attemptOrdinal: 1,
      callOrdinal: 1,
      provider: 'openai',
      modelName: 'gpt-5.4',
      routeReason: 'session_pinned',
      fallbackOrdinal: 0,
      requestStartedAt: new Date(),
    })).rejects.toThrow('Durable usage store is unavailable');
  });

  it('records a call with no organization and never refuses it: usage is cost visibility, not a charge', async () => {
    session.flags = { model_selection: { resolvedModelId: 'model-1' } };
    await recorder.beginAttempt('test-session', {
      logicalCallKey: 'call',
      attemptOrdinal: 1,
      callOrdinal: 1,
      provider: 'openai',
      modelName: 'gpt-5.4',
      routeReason: 'session_pinned',
      fallbackOrdinal: 0,
      requestStartedAt: new Date(),
    });
    await recorder.recordUsage('test-session', {
      promptTokens: 1000,
      completionTokens: 0,
      totalTokens: 1000,
    }, { attemptId: 'attempt-1' });

    expect(usageStore.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({ organizationId: null }));
    expect((session.flags[TOKEN_USAGE_FLAG] as any).cost).toBeGreaterThan(0);
    expect((session.flags[TOKEN_USAGE_FLAG] as any).credits).toBe(0);
  });
});
