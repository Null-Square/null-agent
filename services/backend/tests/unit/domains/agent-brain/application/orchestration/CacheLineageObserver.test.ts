import { describe, it, expect } from 'vitest';
import { CacheLineageObserver } from '@/domains/agent-brain/application/orchestration/CacheLineageObserver';
import {
  digestOf,
  projectOpenAiCompatibleCacheSurface,
  type CacheIdentity,
} from '@/domains/agent-brain/domain/cache';

const identity: CacheIdentity = {
  provider: 'deepseek',
  model: 'v4-pro',
  tenantDigest: digestOf('t'),
  translationVersion: 'openai-compatible/v1',
};

const project = (messages: unknown[]) =>
  projectOpenAiCompatibleCacheSurface({ envelope: { model: 'v4-pro', messages }, identity });

const sys = { role: 'system', content: 'system prompt' };
const user = { role: 'user', content: 'task' };

const setup = () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const observer = new CacheLineageObserver((event, payload) => events.push({ event, payload }));
  return { observer, events };
};

describe('CacheLineageObserver', () => {
  it('classifies an append against the declared ancestor', () => {
    const { observer, events } = setup();
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r1', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'none' },
      projection: project([sys, user]),
    });
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r2', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'r1' },
      projection: project([sys, user, { role: 'assistant', content: 'ok' }]),
    });
    expect(events[0]!.payload.structuralRelation).toBe('first_request');
    expect(events[1]!.payload.structuralRelation).toBe('append_extension');
    expect(events[1]!.payload.cacheAncestorRequestId).toBe('r1');
  });

  it('does not let an auxiliary become the next main ancestor', () => {
    const { observer, events } = setup();
    const main = [sys, user];
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r1', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'none' },
      projection: project(main),
    });
    // A cache-affine auxiliary extends the main prefix with its own trailing instruction.
    observer.recordExpectation({
      sessionId: 's1', requestId: 'aux1', branch: 'auxiliary',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'r1' },
      projection: project([...main, { role: 'user', content: 'summarize the above' }]),
    });
    // The next ordinary request must still compare against r1, not aux1.
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r2', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'r1' },
      projection: project([...main, { role: 'assistant', content: 'ok' }]),
    });
    expect(events[1]!.payload.structuralRelation).toBe('auxiliary_extension');
    expect(events[2]!.payload.cacheAncestorRequestId).toBe('r1');
    expect(events[2]!.payload.structuralRelation).toBe('append_extension');
  });

  it('marks an isolated auxiliary as detached rather than divergent', () => {
    const { observer, events } = setup();
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r1', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'none' },
      projection: project([sys, user]),
    });
    observer.recordExpectation({
      sessionId: 's1', requestId: 'judge', branch: 'auxiliary',
      cacheMode: { kind: 'isolated', reason: 'duplicate-finding judge' },
      projection: project([{ role: 'user', content: 'are these duplicates?' }]),
    });
    expect(events[1]!.payload.structuralRelation).toBe('detached_auxiliary');
  });

  it('reports an undeclared rewrite as unexplained divergence', () => {
    const { observer, events } = setup();
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r1', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'none' },
      projection: project([sys, user]),
    });
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r2', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'r1' },
      projection: project([{ role: 'system', content: 'silently changed' }, user]),
    });
    expect(events[1]!.payload.structuralRelation).toBe('unexplained_divergence');
    expect(events[1]!.payload.firstChangedSegmentIndex).toBe(0);
  });

  it('joins retries to one request and never invents a zero on missing telemetry', () => {
    const { observer, events } = setup();
    observer.recordExpectation({
      sessionId: 's1', requestId: 'r1', branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'none' },
      projection: project([sys, user]),
    });
    observer.recordObservation({
      sessionId: 's1', requestId: 'r1', attemptId: 'a1', attemptOrdinal: 1,
      telemetryState: 'not_reported',
    });
    observer.recordObservation({
      sessionId: 's1', requestId: 'r1', attemptId: 'a2', attemptOrdinal: 2,
      telemetryState: 'reported', cacheReadTokens: 0,
    });
    const observed = events.filter((e) => e.event === 'cache.lineage.observed');
    expect(observed).toHaveLength(2);
    expect(observed[0]!.payload.outcome).toBe('telemetry_unavailable');
    expect(observed[0]!.payload.actualCacheReadTokens).toBeUndefined();
    expect(observed[1]!.payload.outcome).toBe('expected_reset');
    expect(observed[1]!.payload.actualCacheReadTokens).toBe(0);
  });

  it('ignores an observation for an unknown request', () => {
    const { observer, events } = setup();
    observer.recordObservation({
      sessionId: 's1', requestId: 'ghost', attemptId: 'a1', attemptOrdinal: 1,
      telemetryState: 'reported', cacheReadTokens: 5,
    });
    expect(events).toHaveLength(0);
  });
});
