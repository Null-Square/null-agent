import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeCacheIdentity,
  cacheLineage,
  releaseCacheLineageSession,
  resetCacheLineageForTests,
} from '@/domains/agent-brain/application/orchestration/cacheLineageRegistry';
import {
  buildProviderCacheProjection,
  type ProviderCacheProjection,
} from '@/domains/agent-brain/domain/cache';

const projection = (messageDigest: string): ProviderCacheProjection =>
  buildProviderCacheProjection({
    identity: buildRuntimeCacheIdentity({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
    segments: [
      { kind: 'system', key: 'system:0', digest: 'sha256:stable', estimatedTokens: 100 },
      { kind: 'message', key: 'message:1', digest: messageDigest, estimatedTokens: 20 },
    ],
  });

const record = (sessionId: string, requestId: string, messageDigest: string) => {
  cacheLineage.track(sessionId);
  return cacheLineage.observe().recordExpectation({
    sessionId,
    requestId,
    branch: 'main',
    cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'session' },
    projection: projection(messageDigest),
  });
};

describe('cache lineage registry', () => {
  afterEach(() => {
    resetCacheLineageForTests();
  });

  it('keeps one ancestor chain per session', () => {
    record('session-a', 'a-1', 'sha256:one');
    record('session-b', 'b-1', 'sha256:two');
    const secondOfA = record('session-a', 'a-2', 'sha256:one-extended');

    // Session B's request must not become session A's ancestor.
    expect(secondOfA.cacheAncestorRequestId).toBe('a-1');
    expect(secondOfA.lineageRootId).toBe('a-1');
  });

  it('starts a fresh lineage after a session is released', () => {
    record('session-a', 'a-1', 'sha256:one');
    releaseCacheLineageSession('session-a');
    const afterRelease = record('session-a', 'a-2', 'sha256:one');

    expect(afterRelease.cacheAncestorRequestId).toBeNull();
    expect(afterRelease.structuralRelation).toBe('first_request');
  });

  it('evicts the oldest session rather than growing without a bound', () => {
    // The cap is 500; crossing it must drop the oldest tracked session, not the newest.
    for (let index = 0; index < 500; index += 1) {
      record(`session-${index}`, `req-${index}`, 'sha256:one');
    }
    record('session-500', 'req-500', 'sha256:one');

    const evicted = record('session-0', 'req-0b', 'sha256:one');
    const retained = record('session-499', 'req-499b', 'sha256:one-extended');

    expect(evicted.structuralRelation).toBe('first_request');
    expect(retained.cacheAncestorRequestId).toBe('req-499');
  });

  it('does not put a credential or session identifier into the cache identity', () => {
    const identity = buildRuntimeCacheIdentity({ provider: 'deepseek', model: 'deepseek-v4-pro' });

    expect(identity.tenantDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(identity.translationVersion).toBe('openai-compatible/v1');
  });
});
