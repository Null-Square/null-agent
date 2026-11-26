import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionCleanupService } from '@/domains/agent-brain/application/services/SessionCleanupService';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const now = Date.now();

const makeSession = (overrides: Partial<SessionState> & { mockProcessing?: boolean } = {}): SessionState => {
  const { mockProcessing, ...rest } = overrides;
  const mockStateMachine = {
    isProcessing: () => mockProcessing ?? false,
    startProcessing: () => true,
    stopProcessing: () => true,
    getState: () => mockProcessing ? "processing" : "idle",
  };
  return {
    id: rest.id ?? 'session-1',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: rest.workspaceDir ?? '/tmp/ws/session-1',
    stateMachine: mockStateMachine as any,
    createdAt: rest.createdAt ?? now,
    lastActive: rest.lastActive ?? now,
    turn: rest.turn ?? 0,
    pendingApproval: rest.pendingApproval,
    checkpoints: rest.checkpoints ?? {},
    ...rest,
  };
};

describe('SessionCleanupService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes idle expired sessions and skips processing or pending approval', () => {
    const sessions = new Map<string, SessionState>([
      ['expired', makeSession({ id: 'expired', lastActive: now - 10_000 })],
      ['processing', makeSession({ id: 'processing', lastActive: now - 10_000, mockProcessing: true })],
      [
        'pending',
        makeSession({
          id: 'pending',
          lastActive: now - 10_000,
          pendingApproval: {
            actionId: 'tc-1',
            toolCallId: 'tc-1',
            tool: 'shell',
            reason: 'awaiting_approval',
            requestedAt: now - 5_000,
          },
        }),
      ],
      ['fresh', makeSession({ id: 'fresh', lastActive: now - 100 })],
    ]);

    const removed: Array<{ id: string; reason: 'explicit' | 'ttl' }> = [];
    const service = new SessionCleanupService(
      {
        entries: () => sessions.entries(),
        remove: (id, reason) => {
          removed.push({ id, reason });
          sessions.delete(id);
          return true;
        },
      },
      { sessionTTL: 5_000 },
    );

    const result = service.cleanupExpiredSessions();

    expect(result).toEqual({ removed: 1, sessionIds: ['expired'] });
    expect(removed).toEqual([{ id: 'expired', reason: 'ttl' }]);
    expect(sessions.has('processing')).toBe(true);
    expect(sessions.has('pending')).toBe(true);
    expect(sessions.has('fresh')).toBe(true);
  });

  it('starts and stops the cleanup interval', () => {
    vi.useFakeTimers();

    const service = new SessionCleanupService(
      {
        entries: () => new Map<string, SessionState>().entries(),
        remove: vi.fn(),
      },
      { sessionTTL: 120_000 },
    );
    const spy = vi.spyOn(service, 'cleanupExpiredSessions');

    service.start();
    expect(service.isRunning()).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(1);

    service.shutdown();
    expect(service.isRunning()).toBe(false);
  });
});


