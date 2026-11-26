import { vi, describe, it, expect, beforeEach, afterEach, Mock } from 'vitest';
vi.mock('fs', () => {
  const actual = vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

import * as fs from 'fs';
import { SessionPersistenceService } from '@/domains/agent-brain/infrastructure/persistence/SessionPersistenceService';

describe('SessionPersistenceService hydration contracts', () => {
  const now = Date.now();

  const makeSessionRow = (id: string, lastActiveDeltaMs: number) => ({
    id,
    userId: 'u1',
    status: 'idle',
    mode: 'interactive',
    workspaceDir: `/tmp/ws/${id}`,
    plan: [],
    metadata: {
      version: 1,
      flags: {
        token_usage_totals: { promptTokens: 10, completionTokens: 5, cost: 1.25, currency: 'usd', model: 'gpt-test' },
      },
    },
    summary: null,
    createdAt: new Date(now - lastActiveDeltaMs),
    updatedAt: new Date(now - lastActiveDeltaMs),
    lastActiveAt: new Date(now - lastActiveDeltaMs),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    (fs.existsSync as Mock).mockReturnValue(false);
    (fs.mkdirSync as Mock).mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hydrates only recent sessions up to maxSessions and truncates nested collections', async () => {
    const sessions = [
      makeSessionRow('recent', 1_000),
      makeSessionRow('old', 10 * 60_000),
      makeSessionRow('mid', 5_000),
    ];

    const messageRows = [
      { id: 'm1', sessionId: 'recent', role: 'assistant', content: 'a', metadata: {}, createdAt: new Date(now - 3000) },
      { id: 'm2', sessionId: 'recent', role: 'assistant', content: 'b', metadata: {}, createdAt: new Date(now - 2000) },
      { id: 'm3', sessionId: 'recent', role: 'assistant', content: 'c', metadata: {}, createdAt: new Date(now - 1000) },
    ];
    const artifactRows = [
      { id: 'a1', sessionId: 'recent', filePath: 'foo', originalName: 'foo', fileType: 'txt', sizeBytes: 1, createdAt: new Date(now) },
      { id: 'a2', sessionId: 'recent', filePath: 'bar', originalName: 'bar', fileType: 'txt', sizeBytes: 2, createdAt: new Date(now) },
    ];
    const checkpointRows = [
      { id: 'c1', sessionId: 'recent', parentId: null, metadata: { id: 'c1', ts: new Date(now - 10).toISOString() }, createdAt: new Date(now - 10) },
      { id: 'c2', sessionId: 'recent', parentId: null, metadata: { id: 'c2', ts: new Date(now) }, createdAt: new Date(now) },
    ];

    const deps = {
      sessions: {
        listAll: vi.fn(async () => sessions),
      },
      messages: {
        listBySession: vi.fn(async (sessionId: string) => (sessionId === 'recent' ? messageRows : [])),
      },
      artifacts: {
        listBySession: vi.fn(async (sessionId: string) => (sessionId === 'recent' ? artifactRows : [])),
      },
      checkpoints: {
        listBySession: vi.fn(async (sessionId: string) => (sessionId === 'recent' ? checkpointRows : [])),
      },
    };

    const service = new SessionPersistenceService(deps as any);

    const hydrated = await service.hydrateAll({
      maxSessions: 2,
      recentMs: 6_000, // exclude "old"
      maxMessages: 2,
      maxArtifacts: 1,
      maxCheckpoints: 1,
    });

    const hydratedIds = hydrated.map((s) => s.id);
    expect(hydratedIds).toEqual(['recent', 'mid']); // sorted by recency and capped to 2

    const recent = hydrated.find((s) => s.id === 'recent')!;
    expect(recent.messages.map((m) => m.id)).toEqual(['m2', 'm3']); // last 2 only
    expect((recent.artifacts ?? []).map((a) => a.id)).toEqual(['a2']); // capped to 1
    expect(Object.keys(recent.checkpoints)).toEqual(['c2']); // capped to 1, newest
    expect(recent.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: 1.25,
      currency: 'usd',
      model: 'gpt-test',
    });

    expect(fs.existsSync).toHaveBeenCalledWith('/tmp/ws/recent');
    expect(fs.mkdirSync).toHaveBeenCalledTimes(2); // recent + mid
  });
});






