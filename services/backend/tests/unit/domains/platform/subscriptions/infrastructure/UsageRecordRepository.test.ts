import { describe, it, expect, vi } from 'vitest';
import { UsageRecordRepository } from '@/domains/platform/subscriptions/infrastructure/UsageRecordRepository';

const createSelectMock = (queue: any[]) => {
  return vi.fn(() => {
    const chain: any = {
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: (resolve: (rows: any[]) => void) => resolve(queue.shift() ?? []),
    };
    return chain;
  });
};

describe('UsageRecordRepository', () => {
  it('throws when insert returns no rows', async () => {
    const database = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
    };
    const repo = new UsageRecordRepository(database as any);

    await expect(
      repo.create({
        sessionId: 'session-1',
        logicalCallKey: 'session-1:1:1',
        attemptOrdinal: 1,
        callOrdinal: 1,
        provider: 'openai',
        modelId: '00000000-0000-0000-0000-000000000001',
        routeReason: 'session_pinned',
        fallbackOrdinal: 0,
        requestStartedAt: new Date(),
        status: 'started',
        rateCardId: '00000000-0000-0000-0000-000000000002',
        cacheHitRatePer1m: 1,
        cacheMissRatePer1m: 2,
        outputRatePer1m: 3,
        quotedPlatformMargin: 0,
        quotedOverheadMultiplier: 0,
        quotedCreditRatePerUsd: 100,
        debitStatus: 'pending',
        userId: null,
        turn: 1,
        promptTokens: 1,
        cachedPromptTokens: 0,
        completionTokens: 1,
        totalTokens: 2,
        cost: 0,
        overhead: 0,
        platformCost: 0,
        platformPrice: 0,
        credits: 0,
        currency: 'usd',
        recordedAt: new Date(),
      }),
    ).rejects.toThrow('Failed to insert usage record');
  });

  it('reports whether a session has usage records', async () => {
    const selectQueue = [[{ count: 2 }], [{ count: 0 }]];
    const database = {
      select: createSelectMock(selectQueue),
    };
    const repo = new UsageRecordRepository(database as any);

    await expect(repo.hasRecordsForSession('session-1')).resolves.toBe(true);
    await expect(repo.hasRecordsForSession('session-2')).resolves.toBe(false);
  });
});
