/**
 * TurnMetricsAccumulator - Collects metrics during a turn for wide event emission.
 *
 * This class aggregates LLM and tool metrics during a turn, producing a single
 * "wide" summary payload for analytics without losing narrow events for debugging.
 *
 * Usage:
 *   const metrics = new TurnMetricsAccumulator();
 *   metrics.recordLlmCall({ inputTokens: 1234, outputTokens: 567, ... });
 *   metrics.recordToolCall({ name: 'readFile', durationMs: 450, success: true });
 *   const summary = metrics.toPayload();
 */

export interface ToolMetric {
  name: string;
  durationMs: number;
  success: boolean;
  outcome: 'success' | 'failure' | 'blocked';
}

export interface LlmCallInput {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  latencyMs: number;
  /**
   * Milliseconds from dispatching the call to the first streamed output token.
   *
   * Absent when the response streamed no text — a turn that is only tool calls
   * never invokes the token callback, so there is no first token to have waited
   * for. Absent means unknown, and an unknown is never filled in with the total
   * latency: the two measure different things and a reader cannot tell them apart
   * once they are mixed.
   */
  ttftMs?: number;
}

export interface ToolCallInput {
  name: string;
  durationMs: number;
  success: boolean;
  outcome?: 'success' | 'failure' | 'blocked';
}

export interface BillingMetricInput {
  nativeCostUsd: number;
  overheadUsd: number;
  platformCostUsd: number;
  platformPriceUsd: number;
  creditsUsed: number;
  currency?: string;
}

export interface TurnMetricsPayload {
  /** Total input tokens across all LLM calls in this turn */
  llmInputTokens: number;
  /** Total output tokens across all LLM calls in this turn */
  llmOutputTokens: number;
  /** Total cached tokens (prompt cache hits) */
  llmCachedTokens: number;
  /** When the provider last reported serving this prefix from cache, if it ever did. */
  lastCacheReadAtMs?: number;
  /** Total LLM latency in milliseconds */
  llmLatencyMs: number;
  /** Summed time-to-first-token over the calls that streamed text. */
  llmTtftMsTotal: number;
  /** How many calls contributed to `llmTtftMsTotal`. Zero means no figure exists. */
  llmTtftSamples: number;
  /** Output tokens from the calls that streamed text, for a throughput figure. */
  llmStreamedOutputTokens: number;
  /** Time those calls spent generating — latency after the first token arrived. */
  llmStreamingMs: number;
  /** Number of LLM calls in this turn */
  llmCallCount: number;
  /** Per-tool execution metrics */
  tools: ToolMetric[];
  /** Number of skipped tool calls */
  skippedToolCalls: number;
  /** Total tool execution latency */
  totalToolLatencyMs: number;
  /** Estimated cost in USD (set externally after usage recording) */
  costUsd?: number;
  /** Aggregated native model cost before overhead/margin */
  nativeCostUsd?: number;
  /** Aggregated overhead added on top of native cost */
  overheadUsd?: number;
  /** Aggregated platform cost after overhead, before margin */
  platformCostUsd?: number;
  /** Aggregated final platform price after margin */
  platformPriceUsd?: number;
  /** Aggregated credits charged for the turn */
  creditsUsed?: number;
  /** Currency used for the billing fields */
  currency?: string;
}

export class TurnMetricsAccumulator {
  private llmInputTokens = 0;
  private llmOutputTokens = 0;
  private llmCachedTokens = 0;
  private lastCacheReadAtMs?: number;
  private llmLatencyMs = 0;
  private llmTtftMsTotal = 0;
  private llmTtftSamples = 0;
  private llmStreamedOutputTokens = 0;
  private llmStreamingMs = 0;
  private llmCallCount = 0;
  private tools: ToolMetric[] = [];
  private skippedToolCalls = 0;
  private totalToolLatencyMs = 0;
  private costUsd?: number;
  private nativeCostUsd = 0;
  private overheadUsd = 0;
  private platformCostUsd = 0;
  private platformPriceUsd = 0;
  private creditsUsed = 0;
  private currency?: string;
  private hasBillingMetrics = false;

  /**
   * Record an LLM call's metrics.
   * Called by TurnStreamController after each model response.
   */
  recordLlmCall(input: LlmCallInput): void {
    this.llmInputTokens += input.inputTokens;
    this.llmOutputTokens += input.outputTokens;
    this.llmCachedTokens += input.cachedTokens ?? 0;
    if ((input.cachedTokens ?? 0) > 0) {
      // When the provider last served this prefix from cache. A cache decision needs to know
      // how long ago that was, because a provider entry expires on its own clock.
      this.lastCacheReadAtMs = Date.now();
    }
    this.llmLatencyMs += input.latencyMs;
    if (input.ttftMs !== undefined && Number.isFinite(input.ttftMs) && input.ttftMs >= 0) {
      this.llmTtftMsTotal += input.ttftMs;
      this.llmTtftSamples += 1;
      // Generation time is what is left of the call after the first token landed.
      // A response that arrived in a single chunk has none, and contributes tokens
      // to no throughput figure rather than an infinite one.
      const generationMs = input.latencyMs - input.ttftMs;
      if (generationMs > 0) {
        this.llmStreamingMs += generationMs;
        this.llmStreamedOutputTokens += input.outputTokens;
      }
    }
    this.llmCallCount += 1;
  }

  /**
   * Record a tool call's metrics.
   * Called by TurnToolExecutor after each tool execution.
   */
  recordToolCall(input: ToolCallInput): void {
    this.tools.push({
      name: input.name,
      durationMs: input.durationMs,
      success: input.success,
      outcome: input.outcome ?? (input.success ? 'success' : 'failure'),
    });
    this.totalToolLatencyMs += input.durationMs;
  }

  /**
   * Record a skipped tool call (no execution performed).
   */
  recordToolSkip(): void {
    this.skippedToolCalls += 1;
  }

  /**
   * Set the estimated cost for this turn.
   * Called after UsageRecorder calculates the cost.
   */
  setCost(costUsd: number): void {
    this.costUsd = costUsd;
  }

  /**
   * Record billing metrics for a model call.
   * Called after UsageRecorder calculates and persists billing data.
   */
  recordBilling(input: BillingMetricInput): void {
    this.nativeCostUsd += input.nativeCostUsd;
    this.overheadUsd += input.overheadUsd;
    this.platformCostUsd += input.platformCostUsd;
    this.platformPriceUsd += input.platformPriceUsd;
    this.creditsUsed += input.creditsUsed;
    this.costUsd = this.platformPriceUsd;
    this.currency = input.currency ?? this.currency;
    this.hasBillingMetrics = true;
  }

  /**
   * Convert accumulated metrics to a payload for the turn.complete event.
   */
  toPayload(): TurnMetricsPayload {
    return {
      llmInputTokens: this.llmInputTokens,
      llmOutputTokens: this.llmOutputTokens,
      llmCachedTokens: this.llmCachedTokens,
      lastCacheReadAtMs: this.lastCacheReadAtMs,
      llmLatencyMs: this.llmLatencyMs,
      llmTtftMsTotal: this.llmTtftMsTotal,
      llmTtftSamples: this.llmTtftSamples,
      llmStreamedOutputTokens: this.llmStreamedOutputTokens,
      llmStreamingMs: this.llmStreamingMs,
      llmCallCount: this.llmCallCount,
      tools: this.tools,
      skippedToolCalls: this.skippedToolCalls,
      totalToolLatencyMs: this.totalToolLatencyMs,
      costUsd: this.hasBillingMetrics ? this.platformPriceUsd : this.costUsd,
      nativeCostUsd: this.hasBillingMetrics ? this.nativeCostUsd : undefined,
      overheadUsd: this.hasBillingMetrics ? this.overheadUsd : undefined,
      platformCostUsd: this.hasBillingMetrics ? this.platformCostUsd : undefined,
      platformPriceUsd: this.hasBillingMetrics ? this.platformPriceUsd : undefined,
      creditsUsed: this.hasBillingMetrics ? this.creditsUsed : undefined,
      currency: this.hasBillingMetrics ? this.currency : undefined,
    };
  }

  /**
   * Get the number of tool calls recorded.
   */
  get toolCallCount(): number {
    return this.tools.length;
  }

  /**
   * Get the number of failed tool calls.
   */
  get failedToolCount(): number {
    return this.tools.filter(t => t.outcome === 'failure').length;
  }

  /**
   * Get the number of policy-blocked tool calls.
   */
  get blockedToolCount(): number {
    return this.tools.filter(t => t.outcome === 'blocked').length;
  }
}
