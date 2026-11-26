import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

describe('SessionStore persistence serialization', () => {
  it('serializes session persists per session', async () => {
    const calls: Array<{ inFlight: number }> = [];
    let inFlight = 0;

    const persistSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          calls.push({ inFlight });
          setTimeout(() => {
            inFlight -= 1;
            resolve();
          }, 5);
        }),
    );

    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      persistenceService: {
        persistSession,
        persistMessage: vi.fn(),
        persistCheckpoint: vi.fn(),
        hydrateAll: vi.fn(async () => []),
        deleteSession: vi.fn(),
      } as any,
    });

    const session = await store.create({ modelName: 'test-model' });
    // Queue multiple writes in quick succession to force potential overlap
    const first = store.get(session.id)!;
    await store.setAsync(session.id, { ...first });
    const second = store.get(session.id)!;
    await store.setAsync(session.id, { ...second });

    await store.waitForSessionPersisted(session.id);
    await new Promise((resolve) => setTimeout(resolve, 15));

    // No more than one persist should be in flight at a time
    expect(calls.every((c) => c.inFlight === 1)).toBe(true);
    expect(persistSession).toHaveBeenCalledTimes(3); // create + two sets
    store.shutdown();
  });

  it('serializes session persists across concurrent callers', async () => {
    const persistSession = vi.fn(async () => Promise.resolve());
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      persistenceService: {
        persistSession,
        persistMessage: vi.fn(),
        persistCheckpoint: vi.fn(),
        hydrateAll: vi.fn(async () => []),
        deleteSession: vi.fn(),
      } as any,
    });

    const session = await store.create({ modelName: 'test-model' });
    const writes = Array.from({ length: 20 }).map((_, idx) =>
      store.setAsync(session.id, { ...store.get(session.id)!, version: idx }),
    );
    await Promise.all(writes);
    await store.waitForSessionPersisted(session.id);
    expect(persistSession).toHaveBeenCalledTimes(21); // 1 create + 20 sets serialized
    store.shutdown();
  });

  it('provides an awaitable durable metadata flush for lifecycle boundaries', async () => {
    let releaseMetadata!: () => void;
    const persistMetadata = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseMetadata = resolve;
      }),
    );
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      persistenceService: {
        persistSession: vi.fn(async () => undefined),
        persistMetadata,
        persistMessage: vi.fn(),
        persistCheckpoint: vi.fn(),
        hydrateAll: vi.fn(async () => []),
        deleteSession: vi.fn(),
      } as any,
    });
    const session = await store.create({ modelName: 'test-model' });
    await store.waitForSessionPersisted(session.id);

    store.queuePersistMetadata(store.get(session.id)!);
    const flushed = store.waitForSessionMetadataPersisted(session.id);
    await vi.waitFor(() => expect(persistMetadata).toHaveBeenCalledTimes(1));

    let settled = false;
    void flushed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseMetadata();
    await flushed;
    expect(settled).toBe(true);
    store.shutdown();
  });

  // Legacy CAS-fencing tests were removed with the dead lease/nonce path.
  // Persistence safety is now covered by serialization and optimistic-version tests.

  it('skips last-write-wins fallback on version conflict to avoid stale overwrites', async () => {
    const conflictError = new Error('session_version_conflict');
    (conflictError as any).code = 'session.conflict';

    const sessions = {
      create: vi.fn(async () => ({} as any)),
      update: vi.fn(async (_id: string, _fields: any, options?: { expectedVersion?: number }) => {
        // Simulate optimistic conflict on first update
        if (options?.expectedVersion !== undefined) {
          throw conflictError;
        }
        // If fallback ever runs, fail the test
        throw new Error('fallback_should_not_run');
      }),
      listAll: vi.fn(async () => []),
      delete: vi.fn(),
    };

    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      persistence: {
        sessions: sessions as any,
        messages: { append: vi.fn(), appendMany: vi.fn() } as any,
      },
    });

    const session = await store.create({ modelName: 'test-model' });
    await store.waitForSessionPersisted(session.id);
    // Trigger a persist; conflict will occur in update
    await store.setAsync(session.id, { ...store.get(session.id)! });
    await store.waitForSessionPersisted(session.id);

    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(sessions.update).toHaveBeenCalledTimes(1); // no fallback update without expectedVersion

    store.shutdown();
  });
});







