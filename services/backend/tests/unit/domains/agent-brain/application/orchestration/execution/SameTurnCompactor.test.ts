import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import {
  compactSameTurnMessages,
  DEFAULT_PREFIX_CACHE_TTL_MS,
  estimateChatMessagesTokens,
  readPrefixCacheState,
} from '@/domains/agent-brain/application/orchestration/execution/SameTurnCompactor';
import { buildContextMeasurement } from '@/domains/agent-brain/domain/context';

const makeToolPair = (
  index: number,
  toolName = 'query_inventory',
  filler = 'x'.repeat(4_000),
): OpenAI.Chat.ChatCompletionMessageParam[] => {
  const callId = `call-${index}`;
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: toolName,
            arguments: '{}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      content: JSON.stringify({
        ok: true,
        data: {
          assets: Array.from({ length: 8 }, (_asset, assetIndex) => ({
            id: `asset-${assetIndex}`,
            value: `host-${assetIndex}.example.com`,
            filler,
          })),
          leadCount: 0,
        },
      }),
    },
  ];
};

const assertAssistantToolPairsRemain = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): void => {
  const toolResultIds = new Set(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => (message as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id),
  );
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const toolCalls = (message as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls ?? [];
    for (const call of toolCalls) {
      expect(toolResultIds.has(call.id)).toBe(true);
    }
  }
};

describe('SameTurnCompactor', () => {
  it('compacts older bulky tool results without dropping assistant/tool pairs', () => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system contract' },
      { role: 'user', content: 'start' },
      ...Array.from({ length: 8 }, (_item, index) => makeToolPair(index)).flat(),
    ];
    const beforeTokens = estimateChatMessagesTokens(messages);

    const result = compactSameTurnMessages(messages, [], {
      enabled: true,
      minPromptTokens: 1,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 2,
      maxResultTokens: 50,
      maxResultChars: 200,
    });

    const compactedToolMessages = result.messages.filter(
      (message) =>
        message.role === 'tool' &&
        typeof message.content === 'string' &&
        message.content.includes('tool_result_compacted'),
    );

    expect(result.stats.reason).toBe('compacted');
    expect(result.stats.compactedResults).toBeGreaterThan(0);
    expect(result.stats.savedTokens).toBeGreaterThan(0);
    expect(estimateChatMessagesTokens(result.messages)).toBeLessThan(beforeTokens);
    expect(compactedToolMessages.length).toBeGreaterThan(0);
    assertAssistantToolPairsRemain(result.messages);
  });

  it('keeps recent tool results and control-tool acknowledgements intact', () => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'start' },
      ...makeToolPair(0, 'report_note', 'control'.repeat(900)),
      ...Array.from({ length: 5 }, (_item, index) => makeToolPair(index + 1)).flat(),
    ];

    const result = compactSameTurnMessages(messages, [], {
      enabled: true,
      minPromptTokens: 1,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 2,
      maxResultTokens: 50,
      maxResultChars: 200,
    });

    const reportNoteResult = result.messages.find(
      (message) =>
        message.role === 'tool' &&
        (message as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id === 'call-0',
    );
    const recentResult = result.messages.find(
      (message) =>
        message.role === 'tool' &&
        (message as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id === 'call-5',
    );

    expect(reportNoteResult?.content).not.toContain('tool_result_compacted');
    expect(recentResult?.content).not.toContain('tool_result_compacted');
    assertAssistantToolPairsRemain(result.messages);
  });

  // E12 Slice B changed this contract: exceeding the budget once no longer forces an
  // immediate rewrite. Reduction waits until output is a full window behind the frontier,
  // so the fixture sets a window its six results are comfortably past.
  it('compacts http_payload once tool output is a full window behind the frontier', () => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'start' },
      ...Array.from({ length: 6 }, (_item, index) =>
        makeToolPair(index, 'http_payload', 'http-body'.repeat(120)),
      ).flat(),
    ];

    // A cold cache, so the rewrite destroys nothing and the economic gate is satisfied by
    // construction. This case is about the quantized boundary.
    const result = compactSameTurnMessages(messages, [], {
      enabled: true,
      minPromptTokens: 99_999,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultTokens: 99_999,
      maxResultChars: 99_999,
      aggregateToolResultBudgetTokens: 500,
    }, undefined, { expectedRemainingRequests: 20, cacheState: 'known_cold' });

    expect(result.stats.reason).toBe('compacted');
    expect(result.stats.compactedTools.http_payload).toBeGreaterThan(0);
    assertAssistantToolPairsRemain(result.messages);
  });

  it('will not rewrite a warm prefix that the reduction cannot pay for', () => {
    // The same history, but the provider is already serving this prefix from cache. This is
    // the shape of both production firings in run r1: a real saving, and nowhere near enough
    // remaining requests to earn back the cache reset.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'start' },
      ...Array.from({ length: 6 }, (_item, index) =>
        makeToolPair(index, 'http_payload', 'http-body'.repeat(120)),
      ).flat(),
    ];

    const result = compactSameTurnMessages(messages, [], {
      enabled: true,
      minPromptTokens: 99_999,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultTokens: 99_999,
      maxResultChars: 99_999,
      aggregateToolResultBudgetTokens: 500,
    }, undefined, { expectedRemainingRequests: 1 });

    expect(result.stats.compactedResults).toBe(0);
    // Not 'no_candidates': there were candidates and the gate declined them.
    expect(result.stats.reason).toBe('refused_uneconomic');
    expect(result.stats.decision?.reason).toBe('negative_economics');
    expect(result.stats.decision?.economics?.profitable).toBe(false);
  });

  it('refuses an ordinary reduction that nobody priced', () => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'start' },
      ...Array.from({ length: 6 }, (_item, index) =>
        makeToolPair(index, 'http_payload', 'http-body'.repeat(120)),
      ).flat(),
    ];

    const result = compactSameTurnMessages(messages, [], {
      enabled: true,
      minPromptTokens: 99_999,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultTokens: 99_999,
      maxResultChars: 99_999,
      aggregateToolResultBudgetTokens: 500,
    });

    expect(result.stats.compactedResults).toBe(0);
    expect(result.stats.reason).toBe('refused_uneconomic');
    expect(result.stats.decision?.reason).toBe('economics_unknown');
  });

  it('uses the routed measurement soft threshold instead of the legacy fixed prompt trigger', () => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'start' },
      ...Array.from({ length: 4 }, (_item, index) => makeToolPair(index)).flat(),
    ];
    const measurement = buildContextMeasurement({
      measurementId: 'same-turn-measurement',
      requestId: 'same-turn-request',
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      provider: 'fixture',
      model: 'million-context-model',
      routedCapacity: 1_000_000,
      capacitySource: 'model_config',
      reducerProfile: 'pentest',
      reducerReason: 'same_turn_tool_result_pressure',
      envelope: { messages, tools: [], max_tokens: 8_192 },
    });

    const result = compactSameTurnMessages(messages, [], {
      enabled: true,
      minPromptTokens: 1,
      aggregateToolResultTargetTokens: 0,
      keepLastToolResults: 1,
      maxResultTokens: 50,
      maxResultChars: 200,
      aggregateToolResultBudgetTokens: 999_999,
    }, measurement);

    expect(measurement.counts.totalWithReservedOutputTokens).toBeLessThan(
      measurement.thresholds.softTokens,
    );
    expect(result.stats.minPromptTokens).toBe(700_000);
    expect(result.stats.reason).toBe('below_threshold');
    expect(result.stats.compactedResults).toBe(0);
  });
});

/**
 * `known_cold` is the only state that removes the loss from the reduction arithmetic, so it
 * has to be earned. An earlier version of this read certified cold as soon as one request had
 * reported no cache read — but on a provider that caches implicitly, the request that missed
 * is usually the request that populated the entry, so the next one would have hit. That read
 * would have rewritten the prefix the previous request just paid to create.
 */
describe('reading what is known about the cached prefix', () => {
  const now = 1_700_000_000_000;

  it('will not call a prefix cold just because requests have missed', () => {
    // The misses may be what populated the cache.
    expect(readPrefixCacheState({ llmCallCount: 1, llmCachedTokens: 0, nowMs: now })).toBe('unknown');
    expect(readPrefixCacheState({ llmCallCount: 9, llmCachedTokens: 0, nowMs: now })).toBe('unknown');
  });

  it('knows nothing before any request has been made', () => {
    expect(readPrefixCacheState({ llmCallCount: 0, llmCachedTokens: 0, nowMs: now })).toBe('unknown');
    expect(readPrefixCacheState({})).toBe('unknown');
  });

  it('calls a recently served prefix warm', () => {
    expect(readPrefixCacheState({
      llmCallCount: 3,
      llmCachedTokens: 40_000,
      lastCacheReadAtMs: now - 30_000,
      nowMs: now,
    })).toBe('known_warm');
  });

  it('calls a prefix cold only once its entry has outlived the provider TTL', () => {
    expect(readPrefixCacheState({
      llmCallCount: 3,
      llmCachedTokens: 40_000,
      lastCacheReadAtMs: now - DEFAULT_PREFIX_CACHE_TTL_MS - 1,
      nowMs: now,
    })).toBe('known_cold');

    expect(readPrefixCacheState({
      llmCallCount: 3,
      llmCachedTokens: 40_000,
      lastCacheReadAtMs: now - DEFAULT_PREFIX_CACHE_TTL_MS + 1,
      nowMs: now,
    })).toBe('known_warm');
  });

  it('prices unknown as warm, so only known_cold removes the loss', () => {
    const messages = [
      { role: 'user' as const, content: 'x'.repeat(40_000) },
      ...makeToolPair(0).flat(),
      ...makeToolPair(1).flat(),
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

    const options = {
      enabled: true,
      // High enough that this call site claims no capacity pressure of its own, so the
      // economic gate is what decides rather than the forced path.
      minPromptTokens: 5_000_000,
      keepLastToolResults: 1,
      maxResultTokens: 200,
      maxResultChars: 800,
      aggregateToolResultBudgetTokens: 200,
      aggregateToolResultTargetTokens: 100,
    };

    const unknownState = compactSameTurnMessages(messages, [], options, undefined, {
      expectedRemainingRequests: 2,
      cacheState: 'unknown',
    });
    const coldState = compactSameTurnMessages(messages, [], options, undefined, {
      expectedRemainingRequests: 2,
      cacheState: 'known_cold',
    });

    expect(unknownState.stats.decision?.reason).toBe('negative_economics');
    expect(coldState.stats.compactedResults).toBeGreaterThan(0);
  });
});
