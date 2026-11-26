import { describe, it, expect } from 'vitest';
import {
  assessCacheOutcome,
  buildCacheExpectation,
  classifyStructuralRelation,
  compareProjections,
  digestOf,
  projectOpenAiCompatibleCacheSurface,
  type CacheExpectation,
  type CacheIdentity,
  type CacheObservation,
} from '@/domains/agent-brain/domain/cache';

const identity: CacheIdentity = {
  provider: 'deepseek',
  model: 'v4-pro',
  tenantDigest: digestOf('tenant-1'),
  translationVersion: 'openai-compatible/v1',
};

const project = (messages: unknown[]) =>
  projectOpenAiCompatibleCacheSurface({
    envelope: { model: 'v4-pro', messages },
    identity,
  });

const sys = { role: 'system', content: 'system prompt' };
const user = { role: 'user', content: 'first task' };
const assistant = { role: 'assistant', content: 'working on it' };

const expectationFor = (
  ancestorMessages: unknown[],
  candidateMessages: unknown[],
  overrides: Partial<Parameters<typeof buildCacheExpectation>[0]> = {},
): CacheExpectation => {
  const ancestor = project(ancestorMessages);
  const candidate = project(candidateMessages);
  return buildCacheExpectation({
    requestId: 'req-2',
    lineageRootId: 'lineage-1',
    cacheAncestorRequestId: 'req-1',
    branch: 'main',
    cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'req-1' },
    projection: candidate,
    comparison: compareProjections(ancestor, candidate),
    ...overrides,
  });
};

describe('structural relation classification', () => {
  it('classifies a clean append as append_extension', () => {
    const expectation = expectationFor([sys, user], [sys, user, assistant]);
    expect(expectation.structuralRelation).toBe('append_extension');
    expect(expectation.firstChangedSegmentIndex).toBeNull();
  });

  it('classifies an undeclared early change as unexplained_divergence', () => {
    const expectation = expectationFor([sys, user], [{ role: 'system', content: 'changed' }, user]);
    expect(expectation.structuralRelation).toBe('unexplained_divergence');
    expect(expectation.firstChangedSegmentIndex).toBe(0);
  });

  it('classifies the same change as declared_rewrite when a transformation is declared', () => {
    const expectation = expectationFor(
      [sys, user],
      [{ role: 'system', content: 'changed' }, user],
      { declaredTransformationIds: ['history:abc'] },
    );
    expect(expectation.structuralRelation).toBe('declared_rewrite');
    expect(expectation.declaredTransformationIds).toEqual(['history:abc']);
  });

  it('flags a declared rewrite that actually diverged earlier than declared', () => {
    // The transformation said it would first change segment 1, but segment 0 also moved.
    // Declaring a rewrite must not suppress diagnostics.
    const expectation = expectationFor(
      [sys, user],
      [{ role: 'system', content: 'ALSO changed' }, { role: 'user', content: 'changed' }],
      { declaredTransformationIds: ['history:abc'], declaredDivergenceIndex: 1 },
    );
    expect(expectation.structuralRelation).toBe('declared_rewrite');
    expect(expectation.undeclaredEarlierDivergence).toBe(true);
  });

  it('does not flag a declared rewrite that diverged exactly where declared', () => {
    const expectation = expectationFor(
      [sys, user],
      [sys, { role: 'user', content: 'changed' }],
      { declaredTransformationIds: ['history:abc'], declaredDivergenceIndex: 1 },
    );
    expect(expectation.undeclaredEarlierDivergence).toBeUndefined();
  });

  it('classifies an identity change as route_or_cache_identity_change', () => {
    const ancestor = project([sys, user]);
    const candidate = projectOpenAiCompatibleCacheSurface({
      envelope: { model: 'other', messages: [sys, user] },
      identity: { ...identity, model: 'other' },
    });
    const expectation = buildCacheExpectation({
      requestId: 'req-2',
      lineageRootId: 'lineage-1',
      cacheAncestorRequestId: 'req-1',
      branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'req-1' },
      projection: candidate,
      comparison: compareProjections(ancestor, candidate),
    });
    expect(expectation.structuralRelation).toBe('route_or_cache_identity_change');
  });

  it('classifies an isolated auxiliary as detached_auxiliary, not a divergence', () => {
    const relation = classifyStructuralRelation({
      branch: 'auxiliary',
      cacheMode: { kind: 'isolated', reason: 'duplicate-finding judge' },
      hasAncestor: false,
      declaredTransformationIds: [],
    });
    expect(relation).toBe('detached_auxiliary');
  });

  it('classifies a cache-affine auxiliary append as auxiliary_extension', () => {
    const expectation = expectationFor([sys, user], [sys, user, assistant], {
      branch: 'auxiliary',
    });
    expect(expectation.structuralRelation).toBe('auxiliary_extension');
  });

  it('classifies the first request in a lineage', () => {
    const expectation = buildCacheExpectation({
      requestId: 'req-1',
      lineageRootId: 'lineage-1',
      cacheAncestorRequestId: null,
      branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'none' },
      projection: project([sys, user]),
    });
    expect(expectation.structuralRelation).toBe('first_request');
  });
});

describe('cache assessment', () => {
  const observation = (patch: Partial<CacheObservation>): CacheObservation => ({
    schemaVersion: 1,
    requestId: 'req-2',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    telemetryState: 'reported',
    ...patch,
  });

  it('never turns missing telemetry into a zero-token miss', () => {
    const expectation = expectationFor([sys, user], [sys, user, assistant]);
    for (const state of ['not_reported', 'unsupported'] as const) {
      const assessment = assessCacheOutcome(expectation, observation({ telemetryState: state }));
      expect(assessment.outcome).toBe('telemetry_unavailable');
      expect(assessment.actualCacheReadTokens).toBeUndefined();
    }
  });

  it('treats reported zero as a genuine miss, distinct from unavailable telemetry', () => {
    const expectation = expectationFor([sys, user], [sys, user, assistant]);
    const assessment = assessCacheOutcome(
      expectation,
      observation({ telemetryState: 'reported', cacheReadTokens: 0 }),
    );
    expect(assessment.outcome).toBe('miss_without_client_divergence');
    expect(assessment.actualCacheReadTokens).toBe(0);
  });

  it('reports hit_as_expected when reuse meets the estimate', () => {
    const expectation = expectationFor([sys, user], [sys, user, assistant]);
    const assessment = assessCacheOutcome(
      expectation,
      observation({ cacheReadTokens: expectation.estimatedReusableTokens + 10 }),
    );
    expect(assessment.outcome).toBe('hit_as_expected');
    expect(assessment.shortfallTokens).toBe(0);
  });

  it('reports partial_reuse and the shortfall when reuse falls short', () => {
    const expectation = expectationFor([sys, user], [sys, user, assistant]);
    const short = Math.max(1, Math.floor(expectation.estimatedReusableTokens / 2));
    const assessment = assessCacheOutcome(expectation, observation({ cacheReadTokens: short }));
    expect(assessment.outcome).toBe('partial_reuse');
    expect(assessment.shortfallTokens).toBe(expectation.estimatedReusableTokens - short);
  });

  it('does not require a declared reset to read zero cache', () => {
    // An earlier unchanged prefix can still be reused across an intentional rewrite.
    const expectation = expectationFor(
      [sys, user],
      [sys, { role: 'user', content: 'changed' }],
      { declaredTransformationIds: ['history:abc'] },
    );
    const assessment = assessCacheOutcome(expectation, observation({ cacheReadTokens: 4_000 }));
    expect(assessment.outcome).toBe('expected_reset');
    expect(assessment.actualCacheReadTokens).toBe(4_000);
  });

  it('separates client divergence from provider-side miss', () => {
    const clean = expectationFor([sys, user], [sys, user, assistant]);
    const dirty = expectationFor([sys, user], [{ role: 'system', content: 'changed' }, user]);

    expect(assessCacheOutcome(clean, observation({ cacheReadTokens: 0 })).outcome)
      .toBe('miss_without_client_divergence');
    expect(assessCacheOutcome(dirty, observation({ cacheReadTokens: 0 })).outcome)
      .toBe('miss_with_client_divergence');
  });

  it('joins one expectation to several retry attempts independently', () => {
    const expectation = expectationFor([sys, user], [sys, user, assistant]);
    const first = assessCacheOutcome(
      expectation,
      observation({ attemptId: 'attempt-1', attemptOrdinal: 1, cacheReadTokens: 0 }),
    );
    const second = assessCacheOutcome(
      expectation,
      observation({
        attemptId: 'attempt-2',
        attemptOrdinal: 2,
        cacheReadTokens: expectation.estimatedReusableTokens + 5,
      }),
    );
    expect(first.outcome).toBe('miss_without_client_divergence');
    expect(second.outcome).toBe('hit_as_expected');
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.requestId).toBe(second.requestId);
  });
});
