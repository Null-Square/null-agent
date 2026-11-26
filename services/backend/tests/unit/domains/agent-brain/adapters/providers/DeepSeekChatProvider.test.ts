import { describe, expect, it } from 'vitest';
import { DeepSeekChatProvider } from '@/domains/agent-brain/adapters/providers';
import { attachProviderReasoning } from '@/domains/agent-brain/domain/reasoning/providerReasoning';

const makeConfig = () => ({
  runtime: {
    apiBaseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
  },
});

describe('DeepSeekChatProvider', () => {
  it('advertises DeepSeek V4 Pro context limits', () => {
    const provider = new DeepSeekChatProvider(makeConfig() as any);
    const capabilities = provider.getCapabilities();

    expect(capabilities.contextWindow).toBe(1_000_000);
    expect(capabilities.maxOutputTokens).toBe(384_000);
    expect(capabilities.automaticCaching).toBe(true);
    expect(capabilities.reasoning).toEqual({
      streamField: 'reasoning_content',
      replay: 'reasoning_content',
    });
  });

  it('replays captured DeepSeek reasoning_content on assistant messages', () => {
    const provider = new DeepSeekChatProvider(makeConfig() as any);
    const assistantMessage = attachProviderReasoning(
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: { name: 'file_read', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        format: 'reasoning_content',
        content: 'private reasoning',
        capturedAt: '2026-05-25T00:00:00.000Z',
      },
    );

    const result = provider.decorateRequest({
      model: 'deepseek-v4-pro',
      messages: [
        assistantMessage,
        { role: 'tool', tool_call_id: 'call-1', content: 'file content' },
      ],
      stream: true,
    } as any);

    expect((result as any).messages[0].reasoning_content).toBe('private reasoning');
  });

  it('does not replay reasoning captured from a different provider', () => {
    const provider = new DeepSeekChatProvider(makeConfig() as any);
    const assistantMessage = attachProviderReasoning(
      { role: 'assistant' as const, content: 'done' },
      {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        format: 'reasoning_content',
        content: 'private reasoning',
        capturedAt: '2026-05-25T00:00:00.000Z',
      },
    );

    const result = provider.decorateRequest({
      model: 'deepseek-v4-pro',
      messages: [assistantMessage],
      stream: true,
    } as any);

    expect((result as any).messages[0].reasoning_content).toBeUndefined();
  });

  it('normalizes DeepSeek cache-hit usage fields', () => {
    const provider = new DeepSeekChatProvider(makeConfig() as any);

    expect(provider.normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 250,
      total_tokens: 1250,
      prompt_cache_hit_tokens: 800,
    })).toEqual({
      promptTokens: 1000,
      promptTokensDetails: { cachedTokens: 800 },
      completionTokens: 250,
      totalTokens: 1250,
    });
  });

  it('preserves provider-reported reasoning tokens', () => {
    const provider = new DeepSeekChatProvider(makeConfig() as any);

    expect(provider.normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      completion_tokens_details: { reasoning_tokens: 30 },
    })).toEqual({
      promptTokens: 100,
      promptTokensDetails: undefined,
      completionTokens: 40,
      completionTokensDetails: { reasoningTokens: 30 },
      totalTokens: 140,
    });
  });

  it('translates the validated deployment request profile', () => {
    const provider = new DeepSeekChatProvider(makeConfig() as any, {
      thinking: 'enabled',
      reasoningEffort: 'high',
    });
    const request = provider.decorateRequest({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
    } as any);

    expect((request as any).thinking).toEqual({ type: 'enabled' });
    expect((request as any).reasoning_effort).toBe('high');
  });
});
