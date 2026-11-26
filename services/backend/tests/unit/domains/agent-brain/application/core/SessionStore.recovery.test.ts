import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { LocalWorkspaceManager } from '@/domains/agent-brain/adapters/workspace/LocalWorkspaceManager';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const baseSession = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: overrides.id ?? 's1',
  messages: [],
  plan: [],
  memory: createEmptyMemory(),
  flags: {},
  workspaceDir: overrides.workspaceDir ?? '/tmp/ws/s1',
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 0,
  pendingApproval: undefined,
  checkpoints: {},
  ...overrides,
});

const flushQueue = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('SessionStore recovery and persistence', () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    tmpRoot = undefined;
  });

  it('hydrates sessions and ensures workspace via manager', async () => {
    const hydrated = baseSession({ id: 's-hydrate', workspaceDir: '/tmp/ws/hydrate' });
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([hydrated]),
      persistSession: vi.fn(),
    };
    const workspaceManager = {
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
    };

    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager: workspaceManager as any,
    });
    await store.whenReady();

    expect(store.get('s-hydrate')).toEqual(expect.objectContaining({ id: 's-hydrate' }));
    expect(workspaceManager.ensureWorkspace).toHaveBeenCalledWith('/tmp/ws/hydrate', 's-hydrate');

    store.shutdown();
  });

  it('hydrates run-scoped sessions with the run id as workspace owner', async () => {
    const hydrated = baseSession({
      id: 's-run-hydrate',
      workspaceDir: '/tmp/ws/ns-run-run-1',
      flags: {
        securityops: {
          runId: 'run-1',
        },
      },
    });
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([hydrated]),
      persistSession: vi.fn(),
    };
    const workspaceManager = {
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
    };

    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager: workspaceManager as any,
    });
    await store.whenReady();

    expect(workspaceManager.ensureWorkspace).toHaveBeenCalledWith('/tmp/ws/ns-run-run-1', 'run-1');

    store.shutdown();
  });

  it('creates missing workspace directories when no manager is present', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-hydrate-'));
    const workspaceDir = path.join(tmpRoot, 'ws-1');
    const hydrated = baseSession({ id: 's-local', workspaceDir });
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([hydrated]),
      persistSession: vi.fn(),
    };
    const workspaceManager = new LocalWorkspaceManager({ root: tmpRoot });

    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager,
    });
    await store.whenReady();

    expect(fs.existsSync(workspaceDir)).toBe(true);

    store.shutdown();
  });

  it('skips message persistence when session has not been persisted', async () => {
    const persistSession = vi.fn().mockRejectedValue(new Error('db-down'));
    const persistMessage = vi.fn();
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession,
      persistMessage,
    };
    const onPersistError = vi.fn();

    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      onPersistError,
      workspaceManager: createTestWorkspaceManager(),
    });
    const session = await store.create({ modelName: 'test-model' });
    await store.appendMessageAsync(session.id, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    });

    await flushQueue();
    await flushQueue();

    expect(persistMessage).not.toHaveBeenCalled();
    expect(onPersistError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'session', error: expect.any(Error) }),
    );

    store.shutdown();
  });

  it('retries session persistence on version conflict', async () => {
    vi.useFakeTimers();
    const conflictError = new Error('session_version_conflict');
    const persistSession = vi.fn()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce(undefined);
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession,
    };
    const onPersistError = vi.fn();

    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      onPersistError,
      workspaceManager: createTestWorkspaceManager(),
    });

    await store.create({ modelName: 'test-model' });
    await vi.advanceTimersByTimeAsync(60);
    await flushQueue();

    expect(persistSession).toHaveBeenCalledTimes(2);
    expect(onPersistError).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, stage: 'session', error: conflictError }),
    );

    store.shutdown();
    vi.useRealTimers();
  });

  it('hydrates missing sessions on demand and dedupes concurrent requests', async () => {
    const hydrated = baseSession({ id: 's-on-demand', workspaceDir: '/tmp/ws/on-demand' });
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      hydrateSession: vi.fn().mockResolvedValue(hydrated),
      persistSession: vi.fn(),
    };
    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager: createTestWorkspaceManager(),
    });
    await store.whenReady();

    await Promise.all([
      (store as any).hydrateIfMissing('s-on-demand'),
      (store as any).hydrateIfMissing('s-on-demand'),
    ]);

    expect(sessionRepository.hydrateSession).toHaveBeenCalledTimes(1);
    expect(store.get('s-on-demand')).toEqual(expect.objectContaining({ id: 's-on-demand' }));

    store.shutdown();
  });
});
