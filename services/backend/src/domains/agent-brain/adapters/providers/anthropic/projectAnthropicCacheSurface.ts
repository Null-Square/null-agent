import {
  buildProviderCacheProjection,
  digestOf,
  estimateSegmentTokens,
  type CacheIdentity,
  type CacheSegment,
  type ProviderCacheProjection,
} from '@/domains/agent-brain/domain/cache';
import { translateRequest, type OpenAIRequestBody } from './requestTranslator';

/**
 * Anthropic cache projection.
 *
 * E4 records the decorated OpenAI-compatible envelope, but the real wire structure is
 * produced later by `translateRequest()` inside `anthropicClientShim.create()`: system
 * messages are hoisted to a top-level `system` parameter, tools and messages are
 * restructured, and tool pairing is repaired.
 *
 * This projection calls the **same** `translateRequest` the transport uses. Two
 * implementations that merely aim to agree would drift, and the drift would be invisible
 * until it produced a wrong cache diagnosis.
 *
 * Anthropic caches in the documented order tools -> system -> messages, which is not the
 * envelope order, so the projection emits segments in that order rather than envelope order.
 */

export const ANTHROPIC_TRANSLATION_VERSION = 'anthropic-request-translator/v1';

export const projectAnthropicCacheSurface = (input: {
  envelope: Record<string, unknown>;
  identity: CacheIdentity;
}): ProviderCacheProjection => {
  const params = translateRequest(input.envelope as unknown as OpenAIRequestBody);
  const segments: CacheSegment[] = [];

  for (const [index, tool] of (params.tools ?? []).entries()) {
    const name = (tool as { name?: unknown }).name;
    segments.push({
      kind: 'tool',
      key: typeof name === 'string' ? name : `tool[${index}]`,
      digest: digestOf(tool),
      estimatedTokens: estimateSegmentTokens(tool),
    });
  }

  for (const [index, block] of (params.system ?? []).entries()) {
    segments.push({
      kind: 'system',
      key: `system[${index}]`,
      digest: digestOf(block),
      estimatedTokens: estimateSegmentTokens(block),
    });
  }

  for (const [index, message] of params.messages.entries()) {
    const role = (message as { role?: unknown }).role;
    segments.push({
      kind: 'message',
      key: `${typeof role === 'string' ? role : 'unknown'}[${index}]`,
      digest: digestOf(message),
      estimatedTokens: estimateSegmentTokens(message),
    });
  }

  return buildProviderCacheProjection({
    identity: { ...input.identity, translationVersion: ANTHROPIC_TRANSLATION_VERSION },
    segments,
  });
};
