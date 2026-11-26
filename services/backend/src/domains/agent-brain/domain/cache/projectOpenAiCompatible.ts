import {
  buildProviderCacheProjection,
  digestOf,
  estimateSegmentTokens,
  type CacheIdentity,
  type CacheSegment,
  type ProviderCacheProjection,
} from './ProviderCacheProjection';

/**
 * Default cache projection for OpenAI-compatible transports (OpenAI, DeepSeek, Qwen,
 * Moonshot). These providers receive the decorated envelope essentially as-is, so the
 * envelope order is the cache order: tools, then messages (system messages are ordinary
 * leading messages in this protocol).
 *
 * Anthropic overrides this — its shim restructures the request after E4 records it.
 */

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const projectOpenAiCompatibleCacheSurface = (input: {
  envelope: Record<string, unknown>;
  identity: CacheIdentity;
}): ProviderCacheProjection => {
  const segments: CacheSegment[] = [];

  // Tool schemas precede messages in the cached sequence; a reordering or a description
  // edit invalidates everything after it.
  for (const [index, tool] of asArray(input.envelope.tools).entries()) {
    const name = (tool as { function?: { name?: unknown } })?.function?.name;
    segments.push({
      kind: 'tool',
      key: typeof name === 'string' ? name : `tool[${index}]`,
      digest: digestOf(tool),
      estimatedTokens: estimateSegmentTokens(tool),
    });
  }

  for (const [index, message] of asArray(input.envelope.messages).entries()) {
    const record = message as { role?: unknown; id?: unknown };
    const role = typeof record.role === 'string' ? record.role : 'unknown';
    const sourceMessageId = typeof record.id === 'string' ? record.id : undefined;
    segments.push({
      kind: role === 'system' ? 'system' : 'message',
      key: `${role}[${index}]`,
      digest: digestOf(message),
      estimatedTokens: estimateSegmentTokens(message),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
  }

  return buildProviderCacheProjection({ identity: input.identity, segments });
};
