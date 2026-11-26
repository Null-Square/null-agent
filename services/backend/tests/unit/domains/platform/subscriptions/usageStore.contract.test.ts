import { describe, expect, it, vi } from 'vitest';
import { DbUsageStore, InMemoryUsageStore } from '@/domains/platform/subscriptions/infrastructure/usageStores';

const attemptInput = {
  sessionId: 's1',
  userId: null,
  organizationId: null,
  turn: 1,
  logicalCallKey: 's1:1:1',
  attemptOrdinal: 1,
  callOrdinal: 1,
  provider: 'research',
  modelName: 'test-model',
  requestedCategory: 'low',
  routeReason: 'session_pinned',
  fallbackOrdinal: 0,
  requestStartedAt: new Date(),
  billing: { platformMargin: 0.5, overheadMultiplier: 1, creditRatePerUsd: 100 },
  creditExempt: true,
};

describe('InMemoryUsageStore', () => {
  it('supports the attempt lifecycle only for non-billable research aggregation', async () => {
    const store = new InMemoryUsageStore();
    const attempt = await store.beginAttempt(attemptInput);
    const result = await store.completeAttempt({
      attemptId: attempt.id,
      requestCompletedAt: new Date(),
      promptTokens: 100,
      cachedPromptTokens: 60,
      completionTokens: 40,
      totalTokens: 140,
    });

    expect(result.debitStatus).toBe('not_applicable');
    expect(result.credits).toBe(0);
    expect(await store.getSessionSummary('s1')).toEqual(expect.objectContaining({
      promptTokens: 100,
      cachedPromptTokens: 60,
      totalTokens: 140,
      entries: 1,
    }));
  });

  it('truncates old research entries at the configured limit', async () => {
    const store = new InMemoryUsageStore(2);
    for (const promptTokens of [1, 2, 3]) {
      await store.recordTurnUsage({
        sessionId: 's1',
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        nativeCost: 0,
        overhead: 0,
        platformCost: 0,
        platformPrice: 0,
        credits: 0,
        recordedAt: Date.now(),
      });
    }
    expect((await store.getSessionSummary('s1'))?.promptTokens).toBe(5);
  });
});

describe('DbUsageStore', () => {
  it('delegates attempt lifecycle and never falls back to process memory', async () => {
    const handle = { id: 'a1' } as any;
    const finalized = { id: 'a1', status: 'completed' } as any;
    const repo = {
      beginAttempt: vi.fn(async () => handle),
      completeAttempt: vi.fn(async () => finalized),
      failAttempt: vi.fn(async () => undefined),
      summarizeSession: vi.fn(async () => undefined),
    };
    const store = new DbUsageStore(repo);
    await expect(store.beginAttempt(attemptInput)).resolves.toBe(handle);
    await expect(store.completeAttempt({ attemptId: 'a1' } as any)).resolves.toBe(finalized);
    await expect(store.recordTurnUsage({} as any)).rejects.toThrow('Billable usage requires');
  });

  it('propagates database failures', async () => {
    const repo = {
      beginAttempt: vi.fn(async () => { throw new Error('db down'); }),
      completeAttempt: vi.fn(),
      failAttempt: vi.fn(),
      summarizeSession: vi.fn(),
    };
    const store = new DbUsageStore(repo as any);
    await expect(store.beginAttempt(attemptInput)).rejects.toThrow('db down');
  });
});
