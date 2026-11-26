import { describe, expect, it } from 'vitest';

import { SessionTurnViewService } from '@/domains/agent-brain/application/services/SessionTurnViewService';
import { PROVIDER_REASONING_METADATA_KEY } from '@/domains/agent-brain/domain/reasoning/providerReasoning';

describe('SessionTurnViewService', () => {
  it('builds turn groups with normalized tool calls, reasoning, costs, and errors', () => {
    const service = new SessionTurnViewService();

    const result = service.build({
      sessionId: 's1',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Run a check',
          metadata: {},
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '',
          metadata: {
            reasoning_content: 'I should inspect the URL first.',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'http_payload', arguments: '{"url":"https://example.test"}' },
              },
            ],
          },
          createdAt: '2024-01-01T00:00:01Z',
        },
        {
          id: 'm3',
          role: 'tool',
          content: '{"status":200,"body":"ok"}',
          toolName: 'http_payload',
          toolCallId: 'call-1',
          metadata: { status: 'success' },
          createdAt: '2024-01-01T00:00:02Z',
        },
      ],
      events: [
        {
          id: 'e1',
          sessionId: 's1',
          turn: 1,
          ts: '2024-01-01T00:00:03Z',
          event: 'model.call.finish',
          severity: 'info',
          payload: {
            latencyMs: 1200,
            finishReason: 'tool_calls',
            toolCalls: 1,
            tokens: { input: 10, output: 5, total: 15 },
          },
        },
        {
          id: 'e2',
          sessionId: 's1',
          turn: 1,
          ts: '2024-01-01T00:00:04Z',
          event: 'tool.finish',
          severity: 'error',
          payload: {
            toolName: 'http_payload',
            toolCallId: 'call-1',
            outcome: 'error',
            outcomeReason: 'Connection reset',
          },
        },
      ],
      costs: [
        {
          turn: 1,
          timestamp: '2024-01-01T00:00:03Z',
          promptTokens: 10,
          cachedPromptTokens: 0,
          completionTokens: 5,
          totalTokens: 15,
          nativeCost: 0.01,
          overhead: 0,
          platformCost: 0.01,
          platformPrice: 0.02,
          credits: 1,
          currency: 'usd',
          model: 'gpt-test',
        },
      ],
    });

    expect(result.summary.turns).toBe(1);
    expect(result.summary.toolCalls).toBe(1);
    expect(result.summary.errors).toBe(1);
    expect(result.turns[0].summary.model).toBe('gpt-test');
    expect(result.turns[0].reasoning[0].text).toContain('inspect the URL');
    expect(result.turns[0].toolCalls[0]).toMatchObject({
      id: 'call-1',
      name: 'http_payload',
      args: { url: 'https://example.test' },
      status: 'error',
      outcomeReason: 'Connection reset',
      source: 'message+trace',
    });
    expect(result.turns[0].toolCalls[0].result).toEqual({ status: 200, body: 'ok' });
    expect(result.turns[0].llmCalls[0].tokens?.totalTokens).toBe(15);
  });

  it('does not emit unknown tool names when a tool result lacks an assistant call', () => {
    const service = new SessionTurnViewService();

    const result = service.build({
      sessionId: 's1',
      messages: [
        {
          id: 'm1',
          role: 'tool',
          content: 'done',
          toolCallId: 'orphan-call',
          toolName: null,
          metadata: {},
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
      events: [],
      costs: [],
    });

    expect(result.turns[0].toolCalls[0].name).toBe('tool_result');
    expect(result.turns[0].toolCalls[0].args).toEqual({});
  });

  it('reads persisted provider reasoning metadata for Anthropic thinking blocks', () => {
    const service = new SessionTurnViewService();

    const result = service.build({
      sessionId: 's1',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Review the evidence',
          metadata: {},
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'The issue is reproducible.',
          metadata: {
            [PROVIDER_REASONING_METADATA_KEY]: {
              provider: 'anthropic',
              model: 'claude-opus-4-6',
              format: 'reasoning_content',
              content: 'I should correlate the request and response before answering.',
              capturedAt: '2024-01-01T00:00:01Z',
            },
          },
          createdAt: '2024-01-01T00:00:01Z',
        },
      ],
      events: [],
      costs: [],
    });

    expect(result.turns[0].reasoning).toHaveLength(1);
    expect(result.turns[0].reasoning[0]).toMatchObject({
      model: 'claude-opus-4-6',
      text: 'I should correlate the request and response before answering.',
      source: 'message',
    });
  });
});
