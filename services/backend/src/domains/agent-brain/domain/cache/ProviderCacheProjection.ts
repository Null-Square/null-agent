// Domain layer stays pure: no @/shared, no node builtins. Uses the domain-local digest.
import { sha256Hex } from '../workers/sha256';

/**
 * E12 Slice A — the provider-visible cache surface.
 *
 * E4 records the decorated OpenAI-compatible envelope. For Anthropic the real wire
 * structure is produced later by `translateRequest()` inside the client shim, which hoists
 * system messages to a top-level `system` parameter and restructures tools and messages.
 * The E4 canonical digest is therefore an *integrity* digest, not a cache-prefix digest.
 *
 * A projection is what the provider actually caches on, in provider order. Producing it is
 * the provider adapter's job so the diagnostic and the dispatched request share one
 * translation implementation.
 */

export const PROVIDER_CACHE_PROJECTION_SCHEMA_VERSION = 1 as const;

/** Ordered segment kinds. Providers cache on a leading token sequence in this order. */
export type CacheSegmentKind = 'system' | 'tool' | 'message';

export interface CacheSegment {
  kind: CacheSegmentKind;
  /** Stable within a projection: tool name, message id, or ordinal-based key. */
  key: string;
  digest: string;
  estimatedTokens: number;
  /** Durable source references, when the caller can supply them. */
  sourceMessageId?: string;
  transformationId?: string;
}

/**
 * Cache namespace/compatibility inputs. These are not part of the token prefix — they
 * decide whether a cached prefix is *eligible* for reuse at all. A change here means the
 * whole prefix is unusable regardless of how similar the tokens are.
 */
export interface CacheIdentity {
  provider: string;
  model: string;
  /** Opaque digest of the credential/tenant namespace. Never a raw key. */
  tenantDigest: string;
  reasoningConfig?: string;
  betas?: string[];
  cacheControlMode?: string;
  /** Provider translation implementation version; a change can move token boundaries. */
  translationVersion: string;
}

export interface ProviderCacheProjection {
  schemaVersion: typeof PROVIDER_CACHE_PROJECTION_SCHEMA_VERSION;
  identity: CacheIdentity;
  identityDigest: string;
  segments: CacheSegment[];
  /** Digest of the ordered segment digests. Equal digests imply an identical prefix. */
  prefixDigest: string;
  estimatedTotalTokens: number;
}

export const digestOf = (value: unknown): string =>
  `sha256:${sha256Hex(typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined')}`;

/**
 * Rough token estimate. The provider's own accounting is the authority for cost; this only
 * has to be good enough to rank divergence impact.
 */
export const estimateSegmentTokens = (value: unknown): number => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return Math.ceil(text.length / 4);
};

export const buildCacheIdentityDigest = (identity: CacheIdentity): string =>
  digestOf([
    identity.provider,
    identity.model,
    identity.tenantDigest,
    identity.reasoningConfig ?? '',
    [...(identity.betas ?? [])].sort().join(','),
    identity.cacheControlMode ?? '',
    identity.translationVersion,
  ]);

export const buildProviderCacheProjection = (input: {
  identity: CacheIdentity;
  segments: CacheSegment[];
}): ProviderCacheProjection => ({
  schemaVersion: PROVIDER_CACHE_PROJECTION_SCHEMA_VERSION,
  identity: input.identity,
  identityDigest: buildCacheIdentityDigest(input.identity),
  segments: input.segments,
  prefixDigest: digestOf(input.segments.map((segment) => segment.digest)),
  estimatedTotalTokens: input.segments.reduce(
    (total, segment) => total + segment.estimatedTokens,
    0,
  ),
});

export interface ProjectionComparison {
  /** True when the cached prefix cannot be reused at all. */
  identityChanged: boolean;
  /** Index of the first differing segment; -1 when no segment differs. */
  firstDivergenceIndex: number;
  firstDivergence?: {
    component: 'system' | 'tool' | 'message';
    key: string;
    sourceMessageId?: string;
    transformationId?: string;
  };
  /** Tokens before the first divergence — the reusable ceiling. */
  estimatedReusableTokens: number;
  /** True when the candidate keeps every ancestor segment and only adds new ones. */
  isAppendExtension: boolean;
}

/**
 * Compares a candidate projection against its declared cache ancestor.
 *
 * Ancestor-relative, never previous-request-relative: an auxiliary call's ancestor is the
 * last warm main request, not the request immediately before it.
 */
export const compareProjections = (
  ancestor: ProviderCacheProjection,
  candidate: ProviderCacheProjection,
): ProjectionComparison => {
  if (ancestor.identityDigest !== candidate.identityDigest) {
    return {
      identityChanged: true,
      firstDivergenceIndex: 0,
      estimatedReusableTokens: 0,
      isAppendExtension: false,
    };
  }

  const shared = Math.min(ancestor.segments.length, candidate.segments.length);
  let reusableTokens = 0;
  for (let index = 0; index < shared; index += 1) {
    const ancestorSegment = ancestor.segments[index]!;
    const candidateSegment = candidate.segments[index]!;
    if (ancestorSegment.digest !== candidateSegment.digest) {
      return {
        identityChanged: false,
        firstDivergenceIndex: index,
        firstDivergence: {
          component: candidateSegment.kind,
          key: candidateSegment.key,
          ...(candidateSegment.sourceMessageId
            ? { sourceMessageId: candidateSegment.sourceMessageId }
            : {}),
          ...(candidateSegment.transformationId
            ? { transformationId: candidateSegment.transformationId }
            : {}),
        },
        estimatedReusableTokens: reusableTokens,
        isAppendExtension: false,
      };
    }
    reusableTokens += candidateSegment.estimatedTokens;
  }

  // Every shared segment matched. A shorter candidate dropped trailing segments, which is a
  // truncation rather than an append.
  const isAppendExtension = candidate.segments.length >= ancestor.segments.length;
  return {
    identityChanged: false,
    firstDivergenceIndex: isAppendExtension ? -1 : shared,
    ...(isAppendExtension
      ? {}
      : {
        firstDivergence: {
          component: ancestor.segments[shared]!.kind,
          key: ancestor.segments[shared]!.key,
        },
      }),
    estimatedReusableTokens: reusableTokens,
    isAppendExtension,
  };
};
