import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

describe('SessionStore persist error handling', () => {
  it('surfaces persist errors via onPersistError callback', async () => {
    const persistError = new Error('persist-failed');
    const persistenceService = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockRejectedValue(persistError),
    } as any;

    const onPersistError = vi.fn();
    const store = new SessionStore({
      persistenceService,
      onPersistError,
      sessionTTL: 1000,
      workspaceManager: createTestWorkspaceManager(),
    });

    const session = await store.create({ modelName: 'test-model' });
    // allow async persist queue to process
    await new Promise((resolve) => setImmediate(resolve));

    expect(onPersistError).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        error: persistError,
        stage: 'session',
      }),
    );

    store.shutdown();
  }, 10000);

  it('TTL cleanup evicts from memory and cleans workspace without deleting persistence', async () => {
    const persistenceService = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockResolvedValue(undefined),
    } as any;
    const sessionRepository = { 
      deleteSession: vi.fn().mockResolvedValue(true),
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockResolvedValue(undefined),
      updateSession: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceManager = {
      allocateWorkspace: vi.fn((id: string) => `/tmp/ws-${id}`),
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      enforceQuota: vi.fn().mockResolvedValue(undefined),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    };

    const store = new SessionStore({
      persistenceService,
      sessionRepository: sessionRepository as any,
      workspaceManager: workspaceManager as any,
      sessionTTL: 100,
    });

    const session = await store.create({ userId: 'u1', modelName: 'test-model' });
    // Make session stale for TTL cleanup
    session.lastActive = Date.now() - 5_000;

    // Run TTL sweep directly
    await (store as any).cleanupService.cleanupExpiredSessions();
    // Allow async cleanup to settle
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.get(session.id)).toBeUndefined();
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledWith(session.workspaceDir, session.id);

    store.shutdown();
  });
});







