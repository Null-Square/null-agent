import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';
import { UsageTracker } from '@/domains/platform/subscriptions/infrastructure/usageTracker';

// Mock logger to capture debug emissions when log=true
vi.mock('@/shared/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('UsageTracker', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('aggregates usage per user per day and counts unique sessions', async () => {
    const tracker = new UsageTracker({ log: true });

    await tracker.recordChatUsage({
      userId: 'u1',
      sessionId: 's1',
      promptTokens: 100,
      completionTokens: 50,
      model: 'gpt',
    });

    await tracker.recordChatUsage({
      userId: 'u1',
      sessionId: 's2',
      promptTokens: 200,
      completionTokens: 25,
      model: 'gpt',
    });

    const summary = tracker.getUsageSummary('u1');
    expect(summary).toEqual(
      expect.objectContaining({
        promptTokens: 300,
        completionTokens: 75,
        totalTokens: 375,
        sessionCount: 2,
      }),
    );
  });

  it('returns undefined when no usage exists', () => {
    const tracker = new UsageTracker();
    expect(tracker.getUsageSummary('missing')).toBeUndefined();
  });

  it('resets user usage for a given day key', async () => {
    const tracker = new UsageTracker();
    const dayKey = new Date().toISOString().slice(0, 10);

    await tracker.recordChatUsage({
      userId: 'u2',
      sessionId: 's1',
      promptTokens: 10,
      completionTokens: 5,
      model: 'gpt',
    });
    expect(tracker.getUsageSummary('u2', dayKey)).toBeDefined();

    tracker.resetUserUsage('u2', dayKey);
    expect(tracker.getUsageSummary('u2', dayKey)).toBeUndefined();
  });

  it('purges expired usage based on retentionMs', async () => {
    vi.useFakeTimers();
    const tracker = new UsageTracker({ retentionMs: 100 });

    await tracker.recordChatUsage({
      userId: 'u3',
      sessionId: 's3',
      promptTokens: 10,
      completionTokens: 10,
      model: 'gpt',
    });
    expect(tracker.getUsageSummary('u3')).toBeDefined();

    // Advance beyond retention to trigger purge on next record
    vi.advanceTimersByTime(150);
    // Trigger purge by recording usage for a different user (so u3 entry is evaluated)
    await tracker.recordChatUsage({
      userId: 'u3-other',
      sessionId: 'sX',
      promptTokens: 1,
      completionTokens: 1,
      model: 'gpt',
    });

    expect(tracker.getUsageSummary('u3')).toBeUndefined();
  });

  it('logs debug entries when log option is enabled', async () => {
    const tracker = new UsageTracker({ log: true });
    const { logger } = await import('@/shared/logger');

    await tracker.recordChatUsage({
      userId: 'u4',
      sessionId: 's5',
      promptTokens: 1,
      completionTokens: 2,
      model: 'gpt',
    });

    expect((logger.debug as Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u4',
        sessionId: 's5',
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      }),
      '[UsageTracker] chat usage',
    );
  });
});







