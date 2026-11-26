import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidecarRunner } from '@/domains/agent-brain/adapters/sandbox';

describe('SidecarRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a sidecar container with secured options', async () => {
    const docker = { create: vi.fn().mockResolvedValue('cid-1'), destroy: vi.fn() };
    const policy = {
      applySecurityDefaults: vi.fn((opts) => ({ ...opts, securityOpts: ['secured'] })),
    };
    const imageResolver = { resolve: vi.fn().mockReturnValue('resolved-image') };
    const runner = new SidecarRunner(docker as any, policy as any, imageResolver as any);
    const profile = {
      readonlyRootfs: true,
      capDrop: ['ALL'],
      capAdd: ['NET_RAW'],
      privileged: false,
      network: 'bridge',
    } as any;
    const options = {
      name: 'sidecar',
      shareNetworkWith: 'c-main',
      workspaceMount: '/tmp/ws',
      env: { A: '1' },
      command: ['node', 'app.js'],
      image: 'img',
    } as any;

    const containerId = await runner.run(options, profile);

    expect(imageResolver.resolve).toHaveBeenCalledWith(options);
    expect(policy.applySecurityDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'resolved-image',
        name: 'sidecar',
        network: { shareWith: 'c-main' },
        readonlyRootfs: true,
        mounts: [{ source: '/tmp/ws', target: '/workspace', readOnly: false }],
        env: { A: '1' },
        command: ['node', 'app.js'],
        capDrop: ['ALL'],
        capAdd: ['NET_RAW'],
        privileged: false,
        securityOpts: [],
        user: 'root',
      }),
      profile,
    );
    expect(docker.create).toHaveBeenCalledWith(
      expect.objectContaining({ securityOpts: ['secured'] }),
    );
    expect(containerId).toBe('cid-1');
  });

  it('destroys sidecar containers', async () => {
    const docker = { create: vi.fn(), destroy: vi.fn().mockResolvedValue(undefined) };
    const policy = { applySecurityDefaults: vi.fn() };
    const imageResolver = { resolve: vi.fn() };
    const runner = new SidecarRunner(docker as any, policy as any, imageResolver as any);

    await runner.destroy('cid-2');

    expect(docker.destroy).toHaveBeenCalledWith('cid-2');
  });

  it('uses root user for privileged sidecars', async () => {
    const docker = { create: vi.fn().mockResolvedValue('cid-3'), destroy: vi.fn() };
    const policy = {
      applySecurityDefaults: vi.fn((opts) => opts),
    };
    const imageResolver = { resolve: vi.fn().mockReturnValue('resolved-image') };
    const runner = new SidecarRunner(docker as any, policy as any, imageResolver as any);
    const profile = {
      readonlyRootfs: false,
      capDrop: ['ALL'],
      capAdd: ['SYS_ADMIN'],
      privileged: true,
      network: 'bridge',
    } as any;
    const options = {
      name: 'sidecar-root',
      shareNetworkWith: 'c-main',
      workspaceMount: '/tmp/ws',
      image: 'img',
    } as any;

    const containerId = await runner.run(options, profile);

    expect(policy.applySecurityDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'resolved-image',
        user: 'root',
        privileged: true,
      }),
      profile,
    );
    expect(docker.create).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'root', privileged: true }),
    );
    expect(containerId).toBe('cid-3');
  });
});
