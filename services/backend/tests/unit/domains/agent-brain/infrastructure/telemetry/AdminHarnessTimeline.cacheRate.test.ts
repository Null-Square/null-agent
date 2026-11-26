import { describe, expect, it } from 'vitest';
import {
  classifyTraceEvent,
  computeAdminHarnessStats,
} from '@/domains/agent-brain/infrastructure/telemetry/AdminHarnessTimeline';

/**
 * D7 — `promptTokens` meant total input in the `usage.recorded` trace payload and uncached
 * input in the summary of the same name and the database column.
 *
 * This timeline divided cache hits by that field, so production run r1 reported a **1,117%**
 * cache rate. A share of input cannot exceed 100%; when it does, the two numbers came from
 * different definitions.
 */
const at = (index: number): string => new Date(1_700_000_000_000 + index * 1_000).toISOString();

const usageEvent = (index: number, payload: Record<string, unknown>) => ({
  event: 'usage.recorded',
  severity: 'info',
  payload,
  ts: at(index),
  sessionId: 'session-1',
  turn: 1,
});

const statsOf = (events: unknown[]) => computeAdminHarnessStats(
  events as never,
  (events as never[]).map((event) => classifyTraceEvent(event)),
);

describe('admin harness cache rate', () => {
  it('reads the explicit input fields when the event carries them', () => {
    const stats = statsOf([
      usageEvent(0, {
        inputTokensTotal: 10_000,
        uncachedInputTokens: 2_000,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 0,
        outputTokens: 500,
        totalTokens: 10_500,
      }),
    ]);

    expect(stats.usage.promptTokens).toBe(10_000);
    expect(stats.usage.cachedTokens).toBe(8_000);
    expect(stats.usage.cachedTokenPercent).toBe(80);
  });

  it('reconstructs the total from an older event that only carried uncached input', () => {
    const stats = statsOf([
      usageEvent(0, {
        uncachedInputTokens: 2_000,
        cachedPromptTokens: 8_000,
        completionTokens: 500,
        totalTokens: 10_500,
      }),
    ]);

    expect(stats.usage.promptTokens).toBe(10_000);
    expect(stats.usage.cachedTokenPercent).toBe(80);
  });

  it('never reports a cache share above 100% from the r1 shape', () => {
    // The exact defect: promptTokens holding cache-miss input, cachedTokens holding hits.
    const stats = statsOf([
      usageEvent(0, {
        promptTokens: 1_000,
        cachedPromptTokens: 11_170,
        completionTokens: 200,
        totalTokens: 12_370,
      }),
    ]);

    expect(stats.usage.cachedTokenPercent).toBeLessThanOrEqual(100);
    expect(stats.usage.cachedTokenPercent).toBeGreaterThan(0);
  });

  it('reports zero rather than dividing by zero on an empty run', () => {
    expect(statsOf([]).usage.cachedTokenPercent).toBe(0);
  });

  it('aggregates several calls into one bounded share', () => {
    const stats = statsOf([
      usageEvent(0, { inputTokensTotal: 4_000, uncachedInputTokens: 4_000, cacheReadTokens: 0, outputTokens: 100, totalTokens: 4_100 }),
      usageEvent(1, { inputTokensTotal: 6_000, uncachedInputTokens: 1_000, cacheReadTokens: 5_000, outputTokens: 100, totalTokens: 6_100 }),
    ]);

    expect(stats.usage.promptTokens).toBe(10_000);
    expect(stats.usage.cachedTokens).toBe(5_000);
    expect(stats.usage.cachedTokenPercent).toBe(50);
  });
});
