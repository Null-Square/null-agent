import { describe, expect, it } from 'vitest';
import { MoonshotChatProvider } from '@/domains/agent-brain/adapters/providers';
import { attachProviderReasoning } from '@/domains/agent-brain/domain/reasoning/providerReasoning';
import type { ResolvedConfig } from '@/config/configTypes';

const makeConfig = (): ResolvedConfig => ({
  runtime: {
    apiBaseUrl: 'https://api.moonshot.ai/v1',
    apiKey: 'test-api-key',
  },
} as ResolvedConfig);

describe('MoonshotChatProvider', () => {
  it('advertises automatic caching without explicit cache control markers', () => {
    const provider = new MoonshotChatProvider(makeConfig());

    expect(provider.supportsCacheControl()).toBe(false);
    expect(provider.getCapabilities()).toMatchObject({
      explicitCacheControl: false,
      automaticCaching: true,
      toolCalling: true,
      streaming: true,
    });
  });

  it('builds a plain system message with stable content first', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const systemMessages = provider.buildSystemMessages({
      staticPrompt: 'STATIC',
      softContext: 'SOFT',
      dynamicPrompt: 'DYNAMIC',
      cacheIntent: { action: 'hit', prefixHash: 'abc' },
    });

    expect(systemMessages).toHaveLength(1);
    const content = (systemMessages[0] as any).content;
    expect(content).toBe('STATIC\n\nSOFT\n\nDYNAMIC');
  });

  it('decorates requests with prompt_cache_key from session id', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const result = provider.decorateRequest(
      {
        model: 'kimi-k2.6',
        messages: [],
        stream: true,
      } as any,
      { sessionId: ' session-123 ' },
    );

    expect((result as any).prompt_cache_key).toBe('session-123');
  });

  it('enables preserved thinking for Kimi models that support keep', () => {
    const provider = new MoonshotChatProvider(makeConfig(), { thinking: 'enabled', keep: 'all' });
    const result = provider.decorateRequest({
      model: 'kimi-k2.6',
      messages: [],
      stream: true,
    } as any);

    expect((result as any).thinking).toEqual({ type: 'enabled', keep: 'all' });
  });

  it('enables thinking without keep for Kimi models that do not support keep', () => {
    const provider = new MoonshotChatProvider(makeConfig(), { thinking: 'enabled' });
    const result = provider.decorateRequest({
      model: 'kimi-k2.5',
      messages: [],
      stream: true,
    } as any);

    expect((result as any).thinking).toEqual({ type: 'enabled' });
  });

  it('preserves explicit thinking configuration for Kimi models', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const result = provider.decorateRequest({
      model: 'kimi-k2.6',
      messages: [],
      stream: true,
      thinking: { type: 'enabled', keep: 'all' },
    } as any);

    expect((result as any).thinking).toEqual({ type: 'enabled', keep: 'all' });
  });

  it('replays captured Moonshot reasoning_content on assistant messages', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const assistantMessage = attachProviderReasoning(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: { name: 'shell', arguments: '{}' },
          },
        ],
      },
      {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        format: 'reasoning_content',
        content: 'private reasoning',
        capturedAt: '2026-05-19T00:00:00.000Z',
      },
    );
    const result = provider.decorateRequest({
      model: 'kimi-k2.6',
      messages: [assistantMessage],
      stream: true,
    } as any);

    expect((result as any).messages[0].reasoning_content).toBe('private reasoning');
  });

  it('does not replay reasoning captured from a different provider', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const assistantMessage = attachProviderReasoning(
      { role: 'assistant', content: 'done' },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        format: 'reasoning_content',
        content: 'private reasoning',
        capturedAt: '2026-05-19T00:00:00.000Z',
      },
    );
    const result = provider.decorateRequest({
      model: 'kimi-k2.6',
      messages: [assistantMessage],
      stream: true,
    } as any);

    expect((result as any).messages[0].reasoning_content).toBeUndefined();
  });

  it('does not add thinking configuration for moonshot-v1 models', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const result = provider.decorateRequest({
      model: 'moonshot-v1-128k',
      messages: [],
      stream: true,
    } as any);

    expect((result as any).thinking).toBeUndefined();
  });

  it('maps max_tokens to max_completion_tokens for Moonshot requests', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const result = provider.decorateRequest({
      model: 'kimi-k2.6',
      messages: [],
      stream: true,
      max_tokens: 2048,
    } as any);

    expect((result as any).max_completion_tokens).toBe(2048);
    expect((result as any).max_tokens).toBeUndefined();
  });

  it('preserves an explicit max_completion_tokens value', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const result = provider.decorateRequest({
      model: 'kimi-k2.6',
      messages: [],
      stream: true,
      max_tokens: 2048,
      max_completion_tokens: 1024,
    } as any);

    expect((result as any).max_completion_tokens).toBe(1024);
    expect((result as any).max_tokens).toBeUndefined();
  });

  it('normalizes usage including root-level cached_tokens', () => {
    const provider = new MoonshotChatProvider(makeConfig());
    const usage = provider.normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      cached_tokens: 600,
    });

    expect(usage).toEqual({
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
      promptTokensDetails: { cachedTokens: 600 },
    });
  });
});
