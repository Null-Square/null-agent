import type { ProjectionComparison, ProviderCacheProjection } from './ProviderCacheProjection';

/**
 * E12 Slice A — three layers, deliberately not one record.
 *
 * `CacheExpectation` is an E4 fact: immutable, known before dispatch.
 * `CacheObservation` is an E7 fact: one per provider attempt, since a retry can have a
 * different cache outcome than the attempt it replaced.
 * `CacheAssessment` is derived at read time by joining the two.
 *
 * Combining them would break E4 immutability and could not represent retries.
 */

export const CACHE_LINEAGE_SCHEMA_VERSION = 1 as const;

/**
 * Structural relation is a *client-side* fact, computed before dispatch. It is deliberately
 * separate from the provider outcome: a perfect append extension can still miss on TTL
 * expiry or eviction, and a declared rewrite can still hide an earlier undeclared change.
 */
export type CacheStructuralRelation =
  | 'first_request'
  | 'append_extension'
  | 'auxiliary_extension'
  | 'declared_rewrite'
  | 'unexplained_divergence'
  | 'detached_auxiliary'
  | 'route_or_cache_identity_change';

export type CacheBranch = 'main' | 'auxiliary';

/**
 * Auxiliary calls declare their intent rather than all inheriting the parent. Compaction is
 * cache-affine; a semantically isolated call (a duplicate-finding judge, say) should stay
 * isolated — inheriting the session would add irrelevant context, alter behavior, widen
 * privacy exposure, and can cost more than it saves.
 */
export type CacheMode =
  | { kind: 'reuse_ancestor'; ancestorRequestId: string }
  | { kind: 'isolated'; reason: string };

export interface CacheExpectation {
  schemaVersion: typeof CACHE_LINEAGE_SCHEMA_VERSION;
  requestId: string;
  lineageRootId: string;
  cacheAncestorRequestId: string | null;
  branch: CacheBranch;
  structuralRelation: CacheStructuralRelation;
  identityDigest: string;
  prefixDigest: string;
  firstChangedSegmentIndex: number | null;
  firstDivergence?: ProjectionComparison['firstDivergence'];
  estimatedReusableTokens: number;
  estimatedTotalTokens: number;
  estimationMethod: string;
  declaredTransformationIds: string[];
  /**
   * Set when a declared rewrite diverged *earlier* than the boundary it declared. Declaring
   * a rewrite must never suppress diagnostics — an earlier change is still a defect.
   */
  undeclaredEarlierDivergence?: boolean;
}

export type CacheTelemetryState = 'reported' | 'not_reported' | 'unsupported';

export interface CacheObservation {
  schemaVersion: typeof CACHE_LINEAGE_SCHEMA_VERSION;
  requestId: string;
  attemptId: string;
  attemptOrdinal: number;
  telemetryState: CacheTelemetryState;
  /** Only meaningful when telemetryState is 'reported'. Never defaulted to zero. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  uncachedInputTokens?: number;
  providerRequestId?: string | null;
}

export type CacheAssessmentOutcome =
  | 'hit_as_expected'
  | 'expected_reset'
  | 'miss_with_client_divergence'
  | 'miss_without_client_divergence'
  | 'partial_reuse'
  | 'telemetry_unavailable';

export interface CacheAssessment {
  requestId: string;
  attemptId: string;
  outcome: CacheAssessmentOutcome;
  structuralRelation: CacheStructuralRelation;
  estimatedReusableTokens: number;
  actualCacheReadTokens?: number;
  /** Reuse we expected but did not get. Undefined when telemetry is unavailable. */
  shortfallTokens?: number;
}

const REUSE_EXPECTED: ReadonlySet<CacheStructuralRelation> = new Set([
  'append_extension',
  'auxiliary_extension',
]);

const RESET_EXPECTED: ReadonlySet<CacheStructuralRelation> = new Set([
  'first_request',
  'declared_rewrite',
  'detached_auxiliary',
  'route_or_cache_identity_change',
]);

export const classifyStructuralRelation = (input: {
  branch: CacheBranch;
  cacheMode: CacheMode;
  hasAncestor: boolean;
  comparison?: ProjectionComparison;
  declaredTransformationIds: string[];
}): CacheStructuralRelation => {
  if (input.cacheMode.kind === 'isolated') return 'detached_auxiliary';
  if (!input.hasAncestor || !input.comparison) return 'first_request';
  if (input.comparison.identityChanged) return 'route_or_cache_identity_change';
  if (input.comparison.isAppendExtension) {
    return input.branch === 'auxiliary' ? 'auxiliary_extension' : 'append_extension';
  }
  return input.declaredTransformationIds.length > 0
    ? 'declared_rewrite'
    : 'unexplained_divergence';
};

export const buildCacheExpectation = (input: {
  requestId: string;
  lineageRootId: string;
  cacheAncestorRequestId: string | null;
  branch: CacheBranch;
  cacheMode: CacheMode;
  projection: ProviderCacheProjection;
  comparison?: ProjectionComparison;
  declaredTransformationIds?: string[];
  estimationMethod?: string;
  /** Segment index a declared transformation said it would change first. */
  declaredDivergenceIndex?: number;
}): CacheExpectation => {
  const declaredTransformationIds = input.declaredTransformationIds ?? [];
  const structuralRelation = classifyStructuralRelation({
    branch: input.branch,
    cacheMode: input.cacheMode,
    hasAncestor: Boolean(input.cacheAncestorRequestId),
    comparison: input.comparison,
    declaredTransformationIds,
  });
  const firstChangedSegmentIndex = input.comparison
    && input.comparison.firstDivergenceIndex >= 0
    ? input.comparison.firstDivergenceIndex
    : null;
  const undeclaredEarlierDivergence = structuralRelation === 'declared_rewrite'
    && typeof input.declaredDivergenceIndex === 'number'
    && firstChangedSegmentIndex !== null
    && firstChangedSegmentIndex < input.declaredDivergenceIndex;

  return {
    schemaVersion: CACHE_LINEAGE_SCHEMA_VERSION,
    requestId: input.requestId,
    lineageRootId: input.lineageRootId,
    cacheAncestorRequestId: input.cacheAncestorRequestId,
    branch: input.branch,
    structuralRelation,
    identityDigest: input.projection.identityDigest,
    prefixDigest: input.projection.prefixDigest,
    firstChangedSegmentIndex,
    ...(input.comparison?.firstDivergence
      ? { firstDivergence: input.comparison.firstDivergence }
      : {}),
    estimatedReusableTokens: input.comparison?.estimatedReusableTokens ?? 0,
    estimatedTotalTokens: input.projection.estimatedTotalTokens,
    estimationMethod: input.estimationMethod ?? 'chars/4:v1',
    declaredTransformationIds,
    ...(undeclaredEarlierDivergence ? { undeclaredEarlierDivergence: true } : {}),
  };
};

/**
 * Joins one expectation to one attempt observation.
 *
 * Missing telemetry never becomes a zero-token miss: zero means a genuine cold miss, and it
 * cannot also mean "the provider did not report this field".
 */
export const assessCacheOutcome = (
  expectation: CacheExpectation,
  observation: CacheObservation,
): CacheAssessment => {
  const base = {
    requestId: expectation.requestId,
    attemptId: observation.attemptId,
    structuralRelation: expectation.structuralRelation,
    estimatedReusableTokens: expectation.estimatedReusableTokens,
  };

  if (observation.telemetryState !== 'reported'
    || typeof observation.cacheReadTokens !== 'number') {
    return { ...base, outcome: 'telemetry_unavailable' };
  }

  const cacheRead = observation.cacheReadTokens;
  const expectsReuse = REUSE_EXPECTED.has(expectation.structuralRelation);

  if (RESET_EXPECTED.has(expectation.structuralRelation)) {
    // A reset means a new declared baseline. It does NOT require cache read to be zero —
    // an earlier unchanged prefix can still be reused.
    return { ...base, outcome: 'expected_reset', actualCacheReadTokens: cacheRead };
  }

  if (expectsReuse && cacheRead > 0) {
    const shortfall = Math.max(0, expectation.estimatedReusableTokens - cacheRead);
    return {
      ...base,
      outcome: shortfall > 0 ? 'partial_reuse' : 'hit_as_expected',
      actualCacheReadTokens: cacheRead,
      shortfallTokens: shortfall,
    };
  }

  if (expectsReuse) {
    // We expected reuse and got none, and the client prefix was clean. The cause is
    // provider-side: TTL expiry, eviction, or a namespace change.
    return {
      ...base,
      outcome: 'miss_without_client_divergence',
      actualCacheReadTokens: cacheRead,
      shortfallTokens: expectation.estimatedReusableTokens,
    };
  }

  return {
    ...base,
    outcome: 'miss_with_client_divergence',
    actualCacheReadTokens: cacheRead,
    shortfallTokens: Math.max(0, expectation.estimatedReusableTokens - cacheRead),
  };
};
