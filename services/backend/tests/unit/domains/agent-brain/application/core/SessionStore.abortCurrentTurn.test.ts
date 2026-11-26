import { vi, describe, it, expect } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

vi.mock('@/shared/logger', () => {
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  childLogger.child.mockImplementation(() => childLogger);
  return { logger: { child: vi.fn(() => childLogger) } };
});

describe('SessionStore.abortCurrentTurnAsync', () => {
  it('aborts the controller but keeps the turn owned until its execution settles', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });
    const controller = new AbortController();

    await store.startTurnAsync(session.id, controller);

    await store.abortCurrentTurnAsync(session.id, 'user_aborted');

    expect(controller.signal.aborted).toBe(true);
    const updated = store.get(session.id)!;
    expect(updated.currentTurn?.controller).toBe(controller);

    await store.clearCurrentTurnAsync(session.id);
    expect(store.get(session.id)?.currentTurn).toBeUndefined();
  });

  it('waits for the active turn to settle after requesting abort', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });
    const controller = new AbortController();
    await store.startTurnAsync(session.id, controller);

    const waiting = store.abortCurrentTurnAndWaitAsync(session.id, 'user_aborted', 1_000);
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await store.clearCurrentTurnAsync(session.id);
    await expect(waiting).resolves.toBe(true);
  });
});







