import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';

describe('SessionStore workspace enforcement', () => {
  it('allocates run-scoped workspaces when securityops.runId is present', async () => {
    const workspaceManager = {
      allocateWorkspace: vi.fn((ownerId: string, options?: { kind?: string }) => `/tmp/${options?.kind ?? 'session'}-${ownerId}`),
      ensureWorkspace: vi.fn(async () => undefined),
      cleanupWorkspace: vi.fn(async () => undefined),
    };
    const store = new SessionStore({
      workspaceManager: workspaceManager as any,
    });

    const phase = await store.create({
      modelName: 'test-model',
      flags: {
        securityops: { runId: 'run-1' },
      },
    });
    const standalone = await store.create({ modelName: 'test-model' });

    expect(phase.workspaceDir).toBe('/tmp/run-run-1');
    expect(standalone.workspaceDir).toBe(`/tmp/session-${standalone.id}`);
    expect(workspaceManager.allocateWorkspace).toHaveBeenCalledWith('run-1', { kind: 'run' });
    expect(workspaceManager.allocateWorkspace).toHaveBeenCalledWith(standalone.id, { kind: 'session' });
  });

  it('can reassign a pre-run planner session onto the run workspace', async () => {
    const workspaceManager = {
      allocateWorkspace: vi.fn((ownerId: string, options?: { kind?: string }) => `/tmp/${options?.kind ?? 'session'}-${ownerId}`),
      ensureWorkspace: vi.fn(async () => undefined),
      cleanupWorkspace: vi.fn(async () => undefined),
    };
    const store = new SessionStore({
      workspaceManager: workspaceManager as any,
    });
    const session = await store.create({ modelName: 'test-model' });

    const updated = await store.assignRunWorkspaceAsync(session.id, 'run-2');

    expect(updated?.workspaceDir).toBe('/tmp/run-run-2');
    expect((updated?.flags.securityops as any)?.runId).toBe('run-2');
    expect(store.get(session.id)?.workspaceDir).toBe('/tmp/run-run-2');
    expect(workspaceManager.ensureWorkspace).toHaveBeenCalledWith('/tmp/run-run-2', 'run-2');
  });

  it('does not delete a run-scoped workspace when a single session is removed', async () => {
    const workspaceManager = {
      allocateWorkspace: vi.fn((ownerId: string, options?: { kind?: string }) => `/tmp/${options?.kind ?? 'session'}-${ownerId}`),
      ensureWorkspace: vi.fn(async () => undefined),
      cleanupWorkspace: vi.fn(async () => undefined),
    };
    const store = new SessionStore({
      workspaceManager: workspaceManager as any,
    });
    const session = await store.create({
      modelName: 'test-model',
      flags: {
        securityops: { runId: 'run-3' },
      },
    });

    await (store as any).removeInternal(session.id, 'explicit');

    expect(workspaceManager.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('throws when workspace ensure fails', async () => {
    const store = new SessionStore({
      workspaceManager: {
        allocateWorkspace: () => '/tmp/fail',
        ensureWorkspace: vi.fn(async () => {
          throw new Error('ensure failed');
        }),
      } as any,
    });

    await expect(store.create({ modelName: 'test-model' })).rejects.toThrow('ensure failed');
  });

  it('throws when workspace quota enforcement fails', async () => {
    const store = new SessionStore({
      workspaceManager: {
        allocateWorkspace: () => '/tmp/fail',
        ensureWorkspace: vi.fn(async () => undefined),
        enforceQuota: vi.fn(async () => {
          throw new Error('quota exceeded');
        }),
      } as any,
    });

    await expect(store.create({ modelName: 'test-model' })).rejects.toThrow('quota exceeded');
  });
});







