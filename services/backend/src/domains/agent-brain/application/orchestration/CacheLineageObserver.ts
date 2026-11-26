import {
  assessCacheOutcome,
  buildCacheExpectation,
  compareProjections,
  type CacheAssessment,
  type CacheExpectation,
  type CacheIdentity,
  type CacheMode,
  type CacheObservation,
  type CacheTelemetryState,
  type ProviderCacheProjection,
} from '../../domain/cache';

/**
 * E12 Slice A — observe-only cache lineage.
 *
 * Holds the last **main-branch** projection per session so a candidate request can be
 * compared against its declared ancestor rather than whatever request happened to run
 * immediately before it. Auxiliary requests form side branches and never become the main
 * branch's next ancestor.
 *
 * This changes no dispatched request. It only records what relationship each request has to
 * its ancestor and, once the provider replies, whether the outcome matched.
 */

export interface CacheLineageEmit {
  (event: 'cache.lineage.expected' | 'cache.lineage.observed', payload: Record<string, unknown>): void;
}

interface SessionLineage {
  lineageRootId: string;
  lastMainRequestId: string;
  lastMainProjection: ProviderCacheProjection;
}

export class CacheLineageObserver {
  private readonly sessions = new Map<string, SessionLineage>();
  private readonly expectations = new Map<string, CacheExpectation>();

  constructor(private readonly emit?: CacheLineageEmit) {}

  /**
   * Records the pre-dispatch expectation. Returns it so callers can attach it to durable
   * records later; Slice A only needs the trace.
   */
  recordExpectation(input: {
    sessionId: string;
    requestId: string;
    branch: 'main' | 'auxiliary';
    cacheMode: CacheMode;
    projection: ProviderCacheProjection;
    declaredTransformationIds?: string[];
    declaredDivergenceIndex?: number;
  }): CacheExpectation {
    const existing = this.sessions.get(input.sessionId);
    const isolated = input.cacheMode.kind === 'isolated';
    const ancestor = isolated ? undefined : existing;

    const comparison = ancestor
      ? compareProjections(ancestor.lastMainProjection, input.projection)
      : undefined;

    const expectation = buildCacheExpectation({
      requestId: input.requestId,
      lineageRootId: existing?.lineageRootId ?? input.requestId,
      cacheAncestorRequestId: ancestor?.lastMainRequestId ?? null,
      branch: input.branch,
      cacheMode: input.cacheMode,
      projection: input.projection,
      comparison,
      declaredTransformationIds: input.declaredTransformationIds ?? [],
      ...(typeof input.declaredDivergenceIndex === 'number'
        ? { declaredDivergenceIndex: input.declaredDivergenceIndex }
        : {}),
    });

    this.expectations.set(input.requestId, expectation);

    // Only a main-branch request advances the ancestor. An auxiliary summary must not
    // become the next ordinary request's ancestor.
    if (input.branch === 'main') {
      this.sessions.set(input.sessionId, {
        lineageRootId: expectation.lineageRootId,
        lastMainRequestId: input.requestId,
        lastMainProjection: input.projection,
      });
    }

    this.emit?.('cache.lineage.expected', {
      sessionId: input.sessionId,
      requestId: expectation.requestId,
      lineageRootId: expectation.lineageRootId,
      cacheAncestorRequestId: expectation.cacheAncestorRequestId,
      branch: expectation.branch,
      structuralRelation: expectation.structuralRelation,
      firstChangedSegmentIndex: expectation.firstChangedSegmentIndex,
      firstDivergence: expectation.firstDivergence,
      estimatedReusableTokens: expectation.estimatedReusableTokens,
      estimatedTotalTokens: expectation.estimatedTotalTokens,
      declaredTransformationIds: expectation.declaredTransformationIds,
      undeclaredEarlierDivergence: expectation.undeclaredEarlierDivergence ?? false,
    });

    return expectation;
  }

  /**
   * Joins a provider attempt's reported usage to its expectation.
   *
   * `telemetryState` must be resolved by the caller from the raw provider payload: a
   * missing field is `not_reported`, never a zero-token miss.
   */
  recordObservation(input: {
    sessionId: string;
    requestId: string;
    attemptId: string;
    attemptOrdinal: number;
    telemetryState: CacheTelemetryState;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    uncachedInputTokens?: number;
    providerRequestId?: string | null;
  }): CacheAssessment | undefined {
    const expectation = this.expectations.get(input.requestId);
    if (!expectation) return undefined;

    const observation: CacheObservation = {
      schemaVersion: 1,
      requestId: input.requestId,
      attemptId: input.attemptId,
      attemptOrdinal: input.attemptOrdinal,
      telemetryState: input.telemetryState,
      ...(typeof input.cacheReadTokens === 'number'
        ? { cacheReadTokens: input.cacheReadTokens }
        : {}),
      ...(typeof input.cacheWriteTokens === 'number'
        ? { cacheWriteTokens: input.cacheWriteTokens }
        : {}),
      ...(typeof input.uncachedInputTokens === 'number'
        ? { uncachedInputTokens: input.uncachedInputTokens }
        : {}),
      ...(input.providerRequestId !== undefined
        ? { providerRequestId: input.providerRequestId }
        : {}),
    };

    const assessment = assessCacheOutcome(expectation, observation);

    this.emit?.('cache.lineage.observed', {
      sessionId: input.sessionId,
      requestId: assessment.requestId,
      attemptId: assessment.attemptId,
      attemptOrdinal: observation.attemptOrdinal,
      telemetryState: observation.telemetryState,
      structuralRelation: assessment.structuralRelation,
      outcome: assessment.outcome,
      estimatedReusableTokens: assessment.estimatedReusableTokens,
      actualCacheReadTokens: assessment.actualCacheReadTokens,
      shortfallTokens: assessment.shortfallTokens,
    });

    // D8 - returned so the caller can persist it beside the E7 attempt it settles. Debug logs
    // and an in-memory map produced zero lineage evidence for the whole of run r1.
    return assessment;
  }

  /** Releases per-session state when a session terminates. */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  buildIdentity(input: {
    provider: string;
    model: string;
    tenantDigest: string;
    reasoningConfig?: string;
    cacheControlMode?: string;
  }): CacheIdentity {
    return {
      provider: input.provider,
      model: input.model,
      tenantDigest: input.tenantDigest,
      ...(input.reasoningConfig ? { reasoningConfig: input.reasoningConfig } : {}),
      ...(input.cacheControlMode ? { cacheControlMode: input.cacheControlMode } : {}),
      translationVersion: 'openai-compatible/v1',
    };
  }
}
