import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxProvisioner } from '@/domains/agent-brain/application/orchestration/services/SandboxProvisioner';

describe('SandboxProvisioner', () => {
  const makeDeps = () => {
    const provision = {
      create: vi.fn(),
      getPolicy: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
    };
    const events = { emit: vi.fn() };
    return { provision, events };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates sandbox and emits policy summary', async () => {
    const { provision, events } = makeDeps();
    const policy = { network: 'bridge' } as any;
    provision.getPolicy.mockResolvedValue(policy);
    const provisioner = new SandboxProvisioner({ provision, events } as any);
    const session = { id: 's1' } as any;

    const result = await provisioner.provision(session, 'img-1');

    expect(provision.create).toHaveBeenCalledWith(session);
    expect(provision.getPolicy).toHaveBeenCalledWith('s1');
    expect(events.emit).toHaveBeenCalledWith('s1', { type: 'sandbox_policy', data: policy });
    expect(result).toBe(policy);
  });

  it('records sandbox readiness when a container id exists', async () => {
    const { provision, events } = makeDeps();
    provision.getPolicy.mockResolvedValue(undefined);
    const provisioner = new SandboxProvisioner({ provision, events } as any);
    const session = { id: 's2', turn: 3, containerId: 'c-1' } as any;
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };

    await provisioner.provision(session, 'img-2', traceRecorder as any);

    expect(traceRecorder.write).toHaveBeenCalledWith(
      's2',
      3,
      expect.objectContaining({
        event: 'session.sandbox.ready',
        payload: expect.objectContaining({ containerId: 'c-1', image: 'img-2' }),
      }),
    );
  });

  it('swallows trace recorder failures', async () => {
    const { provision, events } = makeDeps();
    const policy = { network: 'bridge' } as any;
    provision.getPolicy.mockResolvedValue(policy);
    const provisioner = new SandboxProvisioner({ provision, events } as any);
    const session = { id: 's3', containerId: 'c-2' } as any;
    const traceRecorder = { write: vi.fn().mockRejectedValue(new Error('boom')) };

    await expect(provisioner.provision(session, undefined, traceRecorder as any)).resolves.toBe(policy);
  });

  it('passes through stop/destroy/getPolicy', async () => {
    const { provision, events } = makeDeps();
    provision.getPolicy.mockResolvedValue({ network: 'none' });
    const provisioner = new SandboxProvisioner({ provision, events } as any);
    const session = { id: 's4' } as any;

    await provisioner.stop(session, 'cleanup');
    await provisioner.destroy(session);
    const policy = await provisioner.getPolicy('s4');

    expect(provision.stop).toHaveBeenCalledWith(session, 'cleanup');
    expect(provision.destroy).toHaveBeenCalledWith(session);
    expect(provision.getPolicy).toHaveBeenCalledWith('s4');
    expect(policy).toEqual({ network: 'none' });
  });

  it('skips policy emit and trace when policy is absent and no container exists', async () => {
    const { provision, events } = makeDeps();
    provision.getPolicy.mockResolvedValue(undefined);
    const provisioner = new SandboxProvisioner({ provision, events } as any);
    const session = { id: 's5', turn: 1 } as any;
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };

    const result = await provisioner.provision(session, undefined, traceRecorder as any);

    expect(result).toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
    expect(traceRecorder.write).not.toHaveBeenCalled();
  });
});
