import { vi, describe, it, expect } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const createStore = () =>
  new SessionStore({
    workspaceManager: createTestWorkspaceManager(),
    persistenceService: {
      persistSession: vi.fn(),
      persistMessage: vi.fn(),
      persistCheckpoint: vi.fn(),
      hydrateAll: vi.fn(async () => []),
      deleteSession: vi.fn(),
    } as any,
  });

describe('SessionStore turn lifecycle helpers', () => {
  it('tracks current turn start and clear', async () => {
    const store = createStore();
    const session = await store.create({ modelName: 'test-model' });

    const controller = new AbortController();
    await store.startTurnAsync(session.id, controller, { reason: 'test' });

    const current = store.get(session.id)?.currentTurn;
    expect(current?.controller).toBe(controller);
    expect(current?.reason).toBe('test');
    expect(current?.abortEventEmitted).toBeUndefined();

    await store.clearCurrentTurnAsync(session.id);
    expect(store.get(session.id)?.currentTurn).toBeUndefined();

    store.shutdown();
  });

  it('aborts current turn and clears state only after turn cleanup', async () => {
    const store = createStore();
    const session = await store.create({ modelName: 'test-model' });

    const controller = new AbortController();
    await store.startTurnAsync(session.id, controller, { reason: 'initial' });

    await store.abortCurrentTurnAsync(session.id, 'stop');

    expect(controller.signal.aborted).toBe(true);
    expect(store.get(session.id)?.currentTurn?.controller).toBe(controller);

    await store.clearCurrentTurnAsync(session.id);
    expect(store.get(session.id)?.currentTurn).toBeUndefined();

    store.shutdown();
  });

  it('does not replace the owner of an active turn', async () => {
    const store = createStore();
    const session = await store.create({ modelName: 'test-model' });
    const firstController = new AbortController();
    const duplicateController = new AbortController();

    await expect(store.startTurnAsync(session.id, firstController)).resolves.toBe(true);
    await expect(store.startTurnAsync(session.id, duplicateController)).resolves.toBe(false);
    expect(store.get(session.id)?.currentTurn?.controller).toBe(firstController);

    const settlement = store.abortCurrentTurnAndWaitAsync(session.id, 'duplicate_turn_test', 1_000);
    await vi.waitFor(() => expect(firstController.signal.aborted).toBe(true));
    await store.clearCurrentTurnAsync(session.id);
    await expect(settlement).resolves.toBe(true);
    store.shutdown();
  });
});







