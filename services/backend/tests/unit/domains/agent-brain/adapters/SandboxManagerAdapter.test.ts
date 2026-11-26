import { describe, it, expect, vi } from 'vitest';
import { SandboxManagerAdapter } from '@/domains/agent-brain/adapters/SandboxManagerAdapter';

describe('SandboxManagerAdapter', () => {
  it('forwards lifecycle and policy calls', async () => {
    const manager = {
      create: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getAppliedPolicy: vi.fn().mockResolvedValue({ policy: 'p1' }),
    };
    const adapter = new SandboxManagerAdapter(manager as any);
    const session = { id: 's1' } as any;

    await adapter.create(session);
    await adapter.stop(session, 'reason');
    await adapter.destroy(session);
    const policy = await adapter.getPolicy('s1');

    expect(manager.create).toHaveBeenCalledWith(session);
    expect(manager.stop).toHaveBeenCalledWith(session, 'reason');
    expect(manager.destroy).toHaveBeenCalledWith(session);
    expect(policy).toEqual({ policy: 'p1' });
  });

  it('executes and manages sidecars via the adapter', async () => {
    const manager = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
      runSidecar: vi.fn().mockResolvedValue({ containerId: 'sidecar-1' }),
      stopSidecars: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from('content')),
    };
    const adapter = new SandboxManagerAdapter(manager as any);
    const session = { id: 's2' } as any;

    const execResult = await adapter.exec(session, { cmd: 'ls', timeoutMs: 10 } as any);
    const sidecar = await adapter.runSidecar(session, {
      name: 'helper',
      image: 'img',
      command: ['bash'],
      env: { KEY: 'VALUE' },
      capabilityProfile: 'profile',
    } as any);
    await adapter.stopSidecars('s2', 'sidecar-1');
    await adapter.writeFile(session, '/tmp/file.txt', 'data');
    const readResult = await adapter.readFile(session, '/tmp/file.txt');

    expect(manager.exec).toHaveBeenCalledWith({ cmd: 'ls', timeoutMs: 10, session });
    expect(manager.runSidecar).toHaveBeenCalledWith({
      session,
      name: 'helper',
      image: 'img',
      command: ['bash'],
      env: { KEY: 'VALUE' },
      capabilityProfile: 'profile',
    });
    expect(manager.stopSidecars).toHaveBeenCalledWith('s2', 'sidecar-1');
    expect(manager.writeFile).toHaveBeenCalledWith(session, '/tmp/file.txt', 'data');
    expect(manager.readFile).toHaveBeenCalledWith(session, '/tmp/file.txt');
    expect(execResult).toEqual({ exitCode: 0 });
    expect(sidecar).toEqual({ containerId: 'sidecar-1' });
    expect(readResult).toEqual(Buffer.from('content'));
  });
});
