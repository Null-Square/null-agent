import { describe, it, expect } from 'vitest';
import {
  buildProviderCacheProjection,
  compareProjections,
  digestOf,
  projectOpenAiCompatibleCacheSurface,
  type CacheIdentity,
} from '@/domains/agent-brain/domain/cache';
import { projectAnthropicCacheSurface } from '@/domains/agent-brain/adapters/providers/anthropic/projectAnthropicCacheSurface';

const identity: CacheIdentity = {
  provider: 'openai',
  model: 'gpt-test',
  tenantDigest: digestOf('tenant-1'),
  translationVersion: 'openai-compatible/v1',
};

const envelope = (messages: unknown[], tools: unknown[] = []) => ({
  model: 'gpt-test',
  messages,
  ...(tools.length > 0 ? { tools } : {}),
});

const sys = { role: 'system', content: 'you are a security agent' };
const user = { role: 'user', content: 'enumerate the target' };
const tool = { type: 'function', function: { name: 'http_request', description: 'send http' } };

describe('provider cache projection', () => {
  it('orders tools before messages for OpenAI-compatible transports', () => {
    const projection = projectOpenAiCompatibleCacheSurface({
      envelope: envelope([sys, user], [tool]),
      identity,
    });
    expect(projection.segments.map((s) => s.kind)).toEqual(['tool', 'system', 'message']);
    expect(projection.segments[0]!.key).toBe('http_request');
  });

  it('treats an appended message as an append extension', () => {
    const before = projectOpenAiCompatibleCacheSurface({ envelope: envelope([sys, user]), identity });
    const after = projectOpenAiCompatibleCacheSurface({
      envelope: envelope([sys, user, { role: 'assistant', content: 'ok' }]),
      identity,
    });
    const comparison = compareProjections(before, after);
    expect(comparison.isAppendExtension).toBe(true);
    expect(comparison.firstDivergenceIndex).toBe(-1);
    expect(comparison.estimatedReusableTokens).toBeGreaterThan(0);
  });

  it('names the first divergent segment when an early system block changes', () => {
    const before = projectOpenAiCompatibleCacheSurface({ envelope: envelope([sys, user]), identity });
    const after = projectOpenAiCompatibleCacheSurface({
      envelope: envelope([{ role: 'system', content: 'you are a DIFFERENT agent' }, user]),
      identity,
    });
    const comparison = compareProjections(before, after);
    expect(comparison.isAppendExtension).toBe(false);
    expect(comparison.firstDivergenceIndex).toBe(0);
    expect(comparison.firstDivergence?.component).toBe('system');
    // Nothing before the change is reusable.
    expect(comparison.estimatedReusableTokens).toBe(0);
  });

  it('names the tool segment when only a tool description changes', () => {
    const before = projectOpenAiCompatibleCacheSurface({
      envelope: envelope([sys, user], [tool]),
      identity,
    });
    const after = projectOpenAiCompatibleCacheSurface({
      envelope: envelope([sys, user], [
        { type: 'function', function: { name: 'http_request', description: 'CHANGED' } },
      ]),
      identity,
    });
    const comparison = compareProjections(before, after);
    expect(comparison.firstDivergence?.component).toBe('tool');
    expect(comparison.firstDivergence?.key).toBe('http_request');
  });

  it('reports an identity change as total loss regardless of prefix similarity', () => {
    const before = projectOpenAiCompatibleCacheSurface({ envelope: envelope([sys, user]), identity });
    const after = projectOpenAiCompatibleCacheSurface({
      envelope: envelope([sys, user]),
      identity: { ...identity, model: 'gpt-other' },
    });
    const comparison = compareProjections(before, after);
    expect(comparison.identityChanged).toBe(true);
    expect(comparison.estimatedReusableTokens).toBe(0);
  });

  it('does not treat a truncated prefix as an append extension', () => {
    const before = projectOpenAiCompatibleCacheSurface({ envelope: envelope([sys, user]), identity });
    const after = projectOpenAiCompatibleCacheSurface({ envelope: envelope([sys]), identity });
    const comparison = compareProjections(before, after);
    expect(comparison.isAppendExtension).toBe(false);
  });

  it('is stable: the same envelope produces the same prefix digest', () => {
    const a = projectOpenAiCompatibleCacheSurface({ envelope: envelope([sys, user], [tool]), identity });
    const b = projectOpenAiCompatibleCacheSurface({ envelope: envelope([sys, user], [tool]), identity });
    expect(a.prefixDigest).toBe(b.prefixDigest);
  });
});

describe('anthropic cache projection', () => {
  const anthropicIdentity: CacheIdentity = {
    provider: 'anthropic',
    model: 'claude-test',
    tenantDigest: digestOf('tenant-1'),
    translationVersion: 'placeholder',
  };

  /**
   * The defect that motivated the provider seam: Anthropic hoists every system message to a
   * top-level `system` parameter during translation. A projection built from the recorded
   * OpenAI envelope would place system content among the messages and compare the wrong
   * representation.
   */
  it('hoists system content out of messages, unlike the OpenAI-compatible projection', () => {
    const body = envelope([sys, user], [tool]);
    const anthropic = projectAnthropicCacheSurface({ envelope: body, identity: anthropicIdentity });
    const openai = projectOpenAiCompatibleCacheSurface({ envelope: body, identity: anthropicIdentity });

    // Anthropic order is tools -> system -> messages, and system is no longer a message.
    expect(anthropic.segments.map((s) => s.kind)).toEqual(['tool', 'system', 'message']);
    const anthropicMessages = anthropic.segments.filter((s) => s.kind === 'message');
    expect(anthropicMessages).toHaveLength(1);

    // The two projections disagree, which is exactly why the adapter must own this.
    expect(anthropic.prefixDigest).not.toBe(openai.prefixDigest);
  });

  it('stamps its own translation version into cache identity', () => {
    const projection = projectAnthropicCacheSurface({
      envelope: envelope([sys, user]),
      identity: anthropicIdentity,
    });
    expect(projection.identity.translationVersion).toBe('anthropic-request-translator/v1');
  });

  it('detects a changed system block after translation', () => {
    const before = projectAnthropicCacheSurface({
      envelope: envelope([sys, user]),
      identity: anthropicIdentity,
    });
    const after = projectAnthropicCacheSurface({
      envelope: envelope([{ role: 'system', content: 'changed' }, user]),
      identity: anthropicIdentity,
    });
    const comparison = compareProjections(before, after);
    expect(comparison.firstDivergence?.component).toBe('system');
  });
});

describe('projection construction', () => {
  it('sums estimated tokens across segments', () => {
    const projection = buildProviderCacheProjection({
      identity,
      segments: [
        { kind: 'system', key: 'a', digest: 'd1', estimatedTokens: 10 },
        { kind: 'message', key: 'b', digest: 'd2', estimatedTokens: 5 },
      ],
    });
    expect(projection.estimatedTotalTokens).toBe(15);
  });
});
