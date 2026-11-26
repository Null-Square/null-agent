import { describe, it, expect } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

describe('SessionStore flags and listing', () => {
  it('filters sessions by user and clones results', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session1 = await store.create({ userId: 'u1', modelName: 'test-model' });
    const session2 = await store.create({ userId: 'u2', modelName: 'test-model' });

    const list = store.listByUser('u1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(session1.id);
    expect(store.listByUser()).toEqual([]);

    const snapshots = store.listSessions();
    snapshots[0].flags = { injected: true } as any;
    const original = store.get(session1.id);
    expect(original?.flags?.injected).toBeUndefined();

    store.shutdown();
  });

  it('sorts checkpoints by timestamp descending', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ modelName: 'test-model' });
    session.checkpoints = {
      c1: { id: 'c1', ts: 10, label: 'first' } as any,
      c2: { id: 'c2', ts: 20, label: 'second' } as any,
    };
    await store.setAsync(session.id, session, 'checkpoint-seed');

    const list = store.listCheckpoints(session.id);

    expect(list.map((c) => c.id)).toEqual(['c2', 'c1']);
    store.shutdown();
  });

  it('supports flag set, merge, and clear flows', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ modelName: 'test-model' });

    const invalid = await store.setFlagAsync(session.id, 'badpath', 'value');
    expect(invalid).toBe(false);

    await store.setFlagAsync(session.id, 'billing.plan', 'control');
    expect(store.get(session.id)?.flags?.billing).toEqual({ plan: 'control' });

    await store.mergeFlagNamespaceAsync(session.id, 'billing', { credits: 5 });
    expect(store.get(session.id)?.flags?.billing).toEqual({ plan: 'control', credits: 5 });

    await store.setFlagAsync(session.id, 'billing.plan', undefined);
    expect((store.get(session.id)?.flags?.billing as any)?.plan).toBeUndefined();

    await store.clearFlagsAsync(session.id);
    expect(store.get(session.id)?.flags).toEqual({});

    store.shutdown();
  });
});
