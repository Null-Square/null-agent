import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidecarManager } from '@/domains/agent-brain/adapters/sandbox/SidecarManager';
import { resolveCapabilityProfile } from '@/domains/agent-brain/adapters/sandbox/capabilityProfiles';

vi.mock('@/domains/agent-brain/adapters/sandbox/capabilityProfiles', () => ({
  resolveCapabilityProfile: vi.fn(),
}));

const resolvedProfile = {
  name: 'hardened',
  capAdd: [],
  capDrop: ['ALL'],
  privileged: false,
  network: 'bridge',
  readonlyRootfs: true,
};

describe('SidecarManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCapabilityProfile).mockResolvedValue(resolvedProfile as any);
  });

  it('throws when workspace or container is missing', async () => {
    const sidecarRunner = { run: vi.fn(), destroy: vi.fn() };
    const manager = new SidecarManager(sidecarRunner as any);

    await expect(manager.runSidecar({ id: 's1' } as any, {})).rejects.toThrow(/workspace/);
    await expect(manager.runSidecar({ id: 's2', workspaceDir: '/tmp/ws' } as any, {})).rejects.toThrow(
      /primary container/,
    );
  });

  it('uses policy facade when provided and records non-cloud creation', async () => {
    const sidecarRunner = {
      run: vi.fn().mockResolvedValue('sidecar-1'),
      destroy: vi.fn(),
    };
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const policyFacade = {
      resolveSandboxCapabilities: vi.fn().mockResolvedValue(resolvedProfile),
    };
    const manager = new SidecarManager(
      sidecarRunner as any,
      traceRecorder as any,
      undefined,
      undefined,
      policyFacade as any,
    );
    const session = {
      id: 's1',
      workspaceDir: '/tmp/ws',
      containerId: 'c-main',
      turn: 2,
    } as any;

    const result = await manager.runSidecar(session, { name: 'helper' });

    expect(policyFacade.resolveSandboxCapabilities).toHaveBeenCalledWith(undefined);
    expect(resolveCapabilityProfile).not.toHaveBeenCalled();
    expect(sidecarRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'helper',
        shareNetworkWith: 'c-main',
        workspaceMount: '/tmp/ws',
        labels: expect.objectContaining({
          'nullai.runtime-kind': 'sidecar',
        }),
      }),
      resolvedProfile,
    );
    expect(result).toEqual({ containerId: 'sidecar-1', name: 'helper' });
    expect(traceRecorder.write).toHaveBeenCalledWith(
      's1',
      2,
      expect.objectContaining({ event: 'sandbox.sidecar.created' }),
    );
  });

  it('fails closed when an admitted cloud Run has no distinct sidecar lease', async () => {
    const sidecarRunner = { run: vi.fn(), destroy: vi.fn() };
    const manager = new SidecarManager(sidecarRunner as any);
    const session = {
      id: 's-cloud',
      workspaceDir: '/tmp/ws',
      containerId: 'c-main',
      flags: {
        securityops: {
          runId: 'run-1',
          cloudAdmission: {
            admissionEpoch: 4,
            leaseId: 'lease-1',
            bundleKey: 'run:run-1:epoch:4',
          },
        },
      },
    } as any;

    await expect(manager.runSidecar(session, { name: 'helper' })).rejects.toThrow(
      'cloud_sidecar_capacity_not_reserved',
    );
    expect(sidecarRunner.run).not.toHaveBeenCalled();
  });

  it('falls back to resolveCapabilityProfile when facade is absent', async () => {
    const sidecarRunner = {
      run: vi.fn().mockResolvedValue('sidecar-2'),
      destroy: vi.fn(),
    };
    const policyResolver = {
      getBySlug: vi.fn(),
      getDefaultPolicy: vi.fn(),
      resolvePolicy: vi.fn(),
    };
    const manager = new SidecarManager(sidecarRunner as any, undefined, undefined, policyResolver as any);
    const session = {
      id: 's1',
      workspaceDir: '/tmp/ws',
      containerId: 'c-main',
      sandboxProfile: 'session-profile',
    } as any;

    await manager.runSidecar(session, {
      capabilityProfile: 'override-profile',
    });

    expect(resolveCapabilityProfile).toHaveBeenCalledWith('override-profile', undefined, policyResolver);
    expect(sidecarRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        shareNetworkWith: 'c-main',
        workspaceMount: '/tmp/ws',
      }),
      resolvedProfile,
    );
  });

  it('stops sidecars and clears tracking even when destroy fails', async () => {
    const sidecarRunner = {
      run: vi.fn().mockResolvedValueOnce('sidecar-1').mockResolvedValueOnce('sidecar-2'),
      destroy: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined),
    };
    const policyResolver = {
      getBySlug: vi.fn(),
      getDefaultPolicy: vi.fn(),
      resolvePolicy: vi.fn(),
    };
    const manager = new SidecarManager(sidecarRunner as any, undefined, undefined, policyResolver as any);
    const session = {
      id: 's1',
      workspaceDir: '/tmp/ws',
      containerId: 'c-main',
    } as any;

    await manager.runSidecar(session, { name: 'a' });
    await manager.runSidecar(session, { name: 'b' });

    await manager.stopSidecars(session.id);

    expect(sidecarRunner.destroy).toHaveBeenCalledWith('sidecar-1');
    expect(sidecarRunner.destroy).toHaveBeenCalledWith('sidecar-2');
    expect((manager as any).sidecars.get(session.id)).toBeUndefined();
  });
});
