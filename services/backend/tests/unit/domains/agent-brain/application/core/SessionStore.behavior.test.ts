import { describe, it, expect, vi } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const now = Date.now();

const makeHydratedSession = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: overrides.id ?? 'session-1',
  messages: [],
  plan: [],
  memory: createEmptyMemory(),
  flags: {},
  workspaceDir: overrides.workspaceDir ?? '/tmp/ws/session-1',
  createdAt: overrides.createdAt ?? now,
  lastActive: overrides.lastActive ?? now,
  turn: overrides.turn ?? 0,
  pendingApproval: overrides.pendingApproval,
  checkpoints: overrides.checkpoints ?? {},
  ...overrides,
});

describe('SessionStore behavior', () => {
  it('removes explicit sessions from persistence and workspace manager', async () => {
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceManager = {
      allocateWorkspace: vi.fn((id: string) => `/tmp/ws-${id}`),
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    };

    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager: workspaceManager as any,
      sessionTTL: 1_000,
    });
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });

    const removed = await store.removeAsync(session.id, 'explicit');

    expect(removed).toBe(true);
    expect(store.get(session.id)).toBeUndefined();
    expect(sessionRepository.deleteSession).toHaveBeenCalledWith(session.id);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledWith(session.workspaceDir, session.id);

    store.shutdown();
  });

  it('does not remove a session until its active provider turn has settled', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ modelName: 'test-model' });
    const controller = new AbortController();
    await store.startTurnAsync(session.id, controller);

    const removal = store.removeAsync(session.id, 'explicit');
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(store.get(session.id)).toBeDefined();

    await store.clearCurrentTurnAsync(session.id);
    await expect(removal).resolves.toBe(true);
    expect(store.get(session.id)).toBeUndefined();

    store.shutdown();
  });

  it('keeps a session registered when owned resource teardown fails', async () => {
    const onSessionRemove = vi.fn()
      .mockRejectedValueOnce(new Error('docker removal timed out'))
      .mockResolvedValueOnce(undefined);
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      onSessionRemove,
    });
    const session = await store.create({ modelName: 'test-model' });

    await expect(store.removeAsync(session.id, 'explicit')).rejects.toThrow(
      'docker removal timed out',
    );
    expect(store.get(session.id)).toBeDefined();

    await expect(store.removeAsync(session.id, 'explicit')).resolves.toBe(true);
    expect(store.get(session.id)).toBeUndefined();
    expect(onSessionRemove).toHaveBeenCalledTimes(2);

    store.shutdown();
  });

  it('releases settled per-session lock promises', async () => {
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
    });
    const session = await store.create({ modelName: 'test-model' });

    await store.updateSessionAsync(session.id, (current) => {
      current.title = 'updated';
    });

    expect((store as any).cache.sessionLocks.size).toBe(0);
    store.shutdown();
  });

  it('coalesces concurrent on-demand hydration', async () => {
    let resolveHydration: (session: SessionState | undefined) => void;
    const hydratePromise = new Promise<SessionState | undefined>((resolve) => {
      resolveHydration = resolve;
    });

    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockResolvedValue(undefined),
      hydrateSession: vi.fn().mockReturnValue(hydratePromise),
    };

    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager: createTestWorkspaceManager(),
    });

    expect(store.get('missing')).toBeUndefined();
    expect(store.get('missing')).toBeUndefined();
    expect(sessionRepository.hydrateSession).toHaveBeenCalledTimes(1);

    resolveHydration!(makeHydratedSession({ id: 'missing' }));
    await hydratePromise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.get('missing')).toEqual(expect.objectContaining({ id: 'missing' }));

    store.shutdown();
  });

  it('preserves existing messages when setAsync receives a sparse state', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ modelName: 'test-model' });

    await store.appendMessageAsync(session.id, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    });

    const current = store.get(session.id)!;
    const originalMessages = current.messages;
    const snapshot: SessionState = { ...current, messages: [] };

    await store.setAsync(session.id, snapshot, 'test');

    const updated = store.get(session.id)!;
    expect(updated.messages).toBe(originalMessages);
    expect(updated.messages).toHaveLength(1);

    store.shutdown();
  });

  it('does not clean a run workspace while a recoverable run session is active', async () => {
    const workspaceManager = {
      allocateWorkspace: vi.fn((id: string) => `/tmp/ws/ns-run-${id}`),
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    };
    const store = new SessionStore({ workspaceManager: workspaceManager as any });
    const session = await store.create({
      modelName: 'test-model',
      flags: { securityops: { runId: 'run-1' } },
    });

    session.blockedReason = 'system_paused';
    session.blockedMeta = { recoverable: true };
    await store.setAsync(session.id, session, 'test.system_paused');

    const result = await store.cleanupRunWorkspaceAsync('run-1');

    expect(result.cleaned).toBe(false);
    expect(result.skippedReason).toBe('active_sessions');
    expect(result.activeSessionIds).toEqual([session.id]);
    expect(workspaceManager.cleanupWorkspace).not.toHaveBeenCalled();

    store.shutdown();
  });

  it('does not let legacy recoverable=false metadata destroy restartable workspace state', async () => {
    const workspaceManager = {
      allocateWorkspace: vi.fn((id: string) => `/tmp/ws/ns-run-${id}`),
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    };
    const store = new SessionStore({ workspaceManager: workspaceManager as any });
    const session = await store.create({
      modelName: 'test-model',
      flags: { securityops: { runId: 'run-restartable-error' } },
    });

    session.blockedReason = 'error';
    session.blockedMeta = { recoverable: false };
    await store.setAsync(session.id, session, 'test.error');

    const result = await store.cleanupRunWorkspaceAsync('run-restartable-error');

    expect(result.cleaned).toBe(false);
    expect(result.skippedReason).toBe('active_sessions');
    expect(result.activeSessionIds).toEqual([session.id]);
    expect(workspaceManager.cleanupWorkspace).not.toHaveBeenCalled();

    store.shutdown();
  });

  it('cleans a run workspace when all cached run sessions are completed or explicitly cancelled', async () => {
    const workspaceManager = {
      allocateWorkspace: vi.fn((id: string) => `/tmp/ws/ns-run-${id}`),
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    };
    const store = new SessionStore({ workspaceManager: workspaceManager as any });
    const completedSession = await store.create({
      modelName: 'test-model',
      flags: { securityops: { runId: 'run-2' } },
    });
    const abortedSession = await store.create({
      modelName: 'test-model',
      flags: { securityops: { runId: 'run-2' } },
    });

    completedSession.completed = true;
    completedSession.flags = { ...completedSession.flags, session: { completed: true } };
    await store.setAsync(completedSession.id, completedSession, 'test.completed');
    abortedSession.blockedReason = 'aborted_by_user';
    await store.setAsync(abortedSession.id, abortedSession, 'test.aborted');

    const result = await store.cleanupRunWorkspaceAsync('run-2');

    expect(result.cleaned).toBe(true);
    expect(result.activeSessionIds).toEqual([]);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledWith('/tmp/ws/ns-run-run-2', 'run-2');
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);

    store.shutdown();
  });

  it('ignores stale setAsync writes with older versions', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ modelName: 'test-model' });

    const initial = store.get(session.id)!;
    await store.setAsync(session.id, { ...initial, status: 'running' }, 'test');

    const stale: SessionState = {
      ...store.get(session.id)!,
      status: 'idle',
      version: 0,
    };
    await store.setAsync(session.id, stale, 'test');

    const updated = store.get(session.id)!;
    expect(updated.status).toBe('running');

    store.shutdown();
  });
});
