import { describe, it, expect } from 'vitest';
import { TurnMetricsAccumulator } from '@/domains/agent-brain/application/orchestration/execution/TurnMetricsAccumulator';

describe('TurnMetricsAccumulator', () => {
  it('starts with zero metrics', () => {
    const acc = new TurnMetricsAccumulator();
    const payload = acc.toPayload();

    expect(payload.llmInputTokens).toBe(0);
    expect(payload.llmOutputTokens).toBe(0);
    expect(payload.llmCachedTokens).toBe(0);
    expect(payload.llmLatencyMs).toBe(0);
    expect(payload.llmCallCount).toBe(0);
    expect(payload.tools).toEqual([]);
    expect(payload.totalToolLatencyMs).toBe(0);
    expect(payload.costUsd).toBeUndefined();
    expect(payload.platformPriceUsd).toBeUndefined();
    expect(payload.creditsUsed).toBeUndefined();
  });

  it('accumulates LLM call metrics', () => {
    const acc = new TurnMetricsAccumulator();

    acc.recordLlmCall({
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      latencyMs: 1500,
    });

    acc.recordLlmCall({
      inputTokens: 800,
      outputTokens: 300,
      latencyMs: 1200,
    });

    const payload = acc.toPayload();
    expect(payload.llmInputTokens).toBe(1800);
    expect(payload.llmOutputTokens).toBe(800);
    expect(payload.llmCachedTokens).toBe(200);
    expect(payload.llmLatencyMs).toBe(2700);
    expect(payload.llmCallCount).toBe(2);
  });

  it('accumulates tool call metrics', () => {
    const acc = new TurnMetricsAccumulator();

    acc.recordToolCall({ name: 'read_file', durationMs: 150, success: true });
    acc.recordToolCall({ name: 'write_file', durationMs: 250, success: true });
    acc.recordToolCall({ name: 'run_command', durationMs: 1000, success: false });

    const payload = acc.toPayload();
    expect(payload.tools).toHaveLength(3);
    expect(payload.tools[2]).toMatchObject({ name: 'run_command', outcome: 'failure' });
    expect(payload.totalToolLatencyMs).toBe(1400);
    expect(acc.toolCallCount).toBe(3);
    expect(acc.failedToolCount).toBe(1);
  });

  it('tracks blocked tool calls separately from failures', () => {
    const acc = new TurnMetricsAccumulator();

    acc.recordToolCall({ name: 'file_read', durationMs: 1, success: false, outcome: 'blocked' });
    acc.recordToolCall({ name: 'http_payload', durationMs: 100, success: false });

    expect(acc.failedToolCount).toBe(1);
    expect(acc.blockedToolCount).toBe(1);
    expect(acc.toPayload().tools).toEqual([
      { name: 'file_read', durationMs: 1, success: false, outcome: 'blocked' },
      { name: 'http_payload', durationMs: 100, success: false, outcome: 'failure' },
    ]);
  });

  it('sets legacy cost alias', () => {
    const acc = new TurnMetricsAccumulator();
    acc.setCost(0.0123);

    const payload = acc.toPayload();
    expect(payload.costUsd).toBe(0.0123);
  });

  it('accumulates billing metrics', () => {
    const acc = new TurnMetricsAccumulator();

    acc.recordBilling({
      nativeCostUsd: 0.01,
      overheadUsd: 0.002,
      platformCostUsd: 0.012,
      platformPriceUsd: 0.024,
      creditsUsed: 2.4,
      currency: 'usd',
    });
    acc.recordBilling({
      nativeCostUsd: 0.005,
      overheadUsd: 0.001,
      platformCostUsd: 0.006,
      platformPriceUsd: 0.012,
      creditsUsed: 1.2,
      currency: 'usd',
    });

    const payload = acc.toPayload();
    expect(payload.costUsd).toBeCloseTo(0.036);
    expect(payload.nativeCostUsd).toBeCloseTo(0.015);
    expect(payload.overheadUsd).toBeCloseTo(0.003);
    expect(payload.platformCostUsd).toBeCloseTo(0.018);
    expect(payload.platformPriceUsd).toBeCloseTo(0.036);
    expect(payload.creditsUsed).toBeCloseTo(3.6);
    expect(payload.currency).toBe('usd');
  });

  it('combines all metrics in toPayload', () => {
    const acc = new TurnMetricsAccumulator();

    acc.recordLlmCall({ inputTokens: 500, outputTokens: 200, latencyMs: 800 });
    acc.recordToolCall({ name: 'test_tool', durationMs: 100, success: true });
    acc.recordBilling({
      nativeCostUsd: 0.002,
      overheadUsd: 0.0003,
      platformCostUsd: 0.0023,
      platformPriceUsd: 0.0046,
      creditsUsed: 0.46,
      currency: 'usd',
    });

    const payload = acc.toPayload();
    expect(payload.llmInputTokens).toBe(500);
    expect(payload.llmOutputTokens).toBe(200);
    expect(payload.llmCachedTokens).toBe(0);
    expect(payload.llmLatencyMs).toBe(800);
    expect(payload.llmCallCount).toBe(1);
    expect(payload.skippedToolCalls).toBe(0);
    expect(payload.tools).toEqual([{ name: 'test_tool', durationMs: 100, success: true, outcome: 'success' }]);
    expect(payload.totalToolLatencyMs).toBe(100);
    expect(payload.costUsd).toBeCloseTo(0.0046);
    expect(payload.nativeCostUsd).toBeCloseTo(0.002);
    expect(payload.overheadUsd).toBeCloseTo(0.0003);
    expect(payload.platformCostUsd).toBeCloseTo(0.0023);
    expect(payload.platformPriceUsd).toBeCloseTo(0.0046);
    expect(payload.creditsUsed).toBeCloseTo(0.46);
    expect(payload.currency).toBe('usd');
  });

  describe('time to first token', () => {
    it('separates waiting for the first token from generating the rest', () => {
      const acc = new TurnMetricsAccumulator();
      acc.recordLlmCall({ inputTokens: 100, outputTokens: 400, latencyMs: 2_000, ttftMs: 400 });

      const payload = acc.toPayload();
      expect(payload.llmTtftMsTotal).toBe(400);
      expect(payload.llmTtftSamples).toBe(1);
      // 400 tokens over the 1,600 ms after the first one landed. Dividing by the
      // full 2,000 would charge generation for the provider's queue.
      expect(payload.llmStreamingMs).toBe(1_600);
      expect(payload.llmStreamedOutputTokens).toBe(400);
    });

    it('records no first token for a call that streamed no text', () => {
      const acc = new TurnMetricsAccumulator();
      // A response that is only tool calls never invokes the token callback.
      acc.recordLlmCall({ inputTokens: 100, outputTokens: 40, latencyMs: 900 });

      const payload = acc.toPayload();
      expect(payload.llmTtftSamples).toBe(0);
      expect(payload.llmTtftMsTotal).toBe(0);
      expect(payload.llmStreamedOutputTokens).toBe(0);
      expect(payload.llmStreamingMs).toBe(0);
      // The latency still counts — it is the first-token split that is unknown.
      expect(payload.llmLatencyMs).toBe(900);
    });

    it('averages over the calls that reported one, not over every call', () => {
      const acc = new TurnMetricsAccumulator();
      acc.recordLlmCall({ inputTokens: 10, outputTokens: 100, latencyMs: 1_000, ttftMs: 200 });
      acc.recordLlmCall({ inputTokens: 10, outputTokens: 50, latencyMs: 500 });
      acc.recordLlmCall({ inputTokens: 10, outputTokens: 300, latencyMs: 3_000, ttftMs: 600 });

      const payload = acc.toPayload();
      expect(payload.llmCallCount).toBe(3);
      expect(payload.llmTtftSamples).toBe(2);
      expect(payload.llmTtftMsTotal / payload.llmTtftSamples).toBe(400);
      expect(payload.llmStreamedOutputTokens).toBe(400);
      expect(payload.llmStreamingMs).toBe(3_200);
    });

    it('contributes no tokens to throughput when the whole response arrived at once', () => {
      const acc = new TurnMetricsAccumulator();
      // First token and last token in the same instant: there is a first-token
      // measurement but no generation window, and dividing by it would be infinite.
      acc.recordLlmCall({ inputTokens: 10, outputTokens: 120, latencyMs: 700, ttftMs: 700 });

      const payload = acc.toPayload();
      expect(payload.llmTtftSamples).toBe(1);
      expect(payload.llmStreamingMs).toBe(0);
      expect(payload.llmStreamedOutputTokens).toBe(0);
    });
  });
});
