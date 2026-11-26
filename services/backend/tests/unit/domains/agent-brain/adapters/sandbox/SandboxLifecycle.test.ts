import { describe, it, expect, vi } from 'vitest';
import { SandboxLifecycle } from '@/domains/agent-brain/adapters/sandbox';

describe('SandboxLifecycle', () => {
  it('requires docker mode for container operations', async () => {
    const containerManager = {
      createContainer: vi.fn(),
      markSessionActive: vi.fn(),
      listActiveContainers: vi.fn(),
    } as any;
    const sidecarManager = { stopSidecars: vi.fn() } as any;
    const lifecycle = new SandboxLifecycle(containerManager, sidecarManager, 'local' as any);

    await expect(lifecycle.list()).rejects.toThrow('sandbox_docker_required');
  });

  it('ensures containers and marks sessions active', async () => {
    const session = { id: 'session-1', workspaceDir: '/tmp/ws' } as any;
    const containerManager = {
      createContainer: vi.fn(async () => {
        session.containerId = 'container-1';
      }),
      markSessionActive: vi.fn(),
    } as any;
    const sidecarManager = { stopSidecars: vi.fn() } as any;
    const lifecycle = new SandboxLifecycle(containerManager, sidecarManager, 'docker');

    await lifecycle.ensureContainer(session);

    expect(containerManager.createContainer).toHaveBeenCalledWith(session);
    expect(containerManager.markSessionActive).toHaveBeenCalledWith('session-1');
  });

  it('throws when containers are missing after creation', async () => {
    const session = { id: 'session-2', workspaceDir: '/tmp/ws' } as any;
    const containerManager = {
      createContainer: vi.fn(),
      markSessionActive: vi.fn(),
    } as any;
    const sidecarManager = { stopSidecars: vi.fn() } as any;
    const lifecycle = new SandboxLifecycle(containerManager, sidecarManager, 'docker');

    await expect(lifecycle.ensureContainer(session)).rejects.toThrow(
      'Session session-2 does not have an active container.',
    );
  });

  it('destroys containers after stopping sidecars', async () => {
    const containerManager = { destroyContainer: vi.fn() } as any;
    const sidecarManager = { stopSidecars: vi.fn() } as any;
    const lifecycle = new SandboxLifecycle(containerManager, sidecarManager, 'docker');
    const session = { id: 'session-3' } as any;

    await lifecycle.destroy(session);

    expect(sidecarManager.stopSidecars).toHaveBeenCalledWith('session-3');
    expect(containerManager.destroyContainer).toHaveBeenCalledWith(session, {});
  });

  it('forwards session-removal ownership to container teardown', async () => {
    const containerManager = { destroyContainer: vi.fn() } as any;
    const sidecarManager = { stopSidecars: vi.fn() } as any;
    const lifecycle = new SandboxLifecycle(containerManager, sidecarManager, 'docker');
    const session = { id: 'session-removing' } as any;

    await lifecycle.destroy(session, { sessionRemovalId: session.id });

    expect(containerManager.destroyContainer).toHaveBeenCalledWith(
      session,
      { sessionRemovalId: session.id },
    );
  });

  it('stops sidecars without checking sandbox mode', async () => {
    const containerManager = { markSessionActive: vi.fn() } as any;
    const sidecarManager = { stopSidecars: vi.fn() } as any;
    const lifecycle = new SandboxLifecycle(containerManager, sidecarManager, 'local' as any);

    await lifecycle.stopSidecars('session-4', 'container-x');

    expect(sidecarManager.stopSidecars).toHaveBeenCalledWith('session-4', 'container-x');
  });
});
