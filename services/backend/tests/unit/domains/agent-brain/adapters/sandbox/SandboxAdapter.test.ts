import { vi, describe, it, expect } from 'vitest';
import { SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';

describe('SandboxAdapter', () => {
  it('re-probes health and allows a lifecycle retry after a transient create failure', async () => {
    const manager = {
      create: vi.fn()
        .mockRejectedValueOnce(new Error('removal already in progress'))
        .mockResolvedValueOnce(undefined),
      preflight: vi.fn().mockResolvedValue(undefined),
      getAppliedPolicy: vi.fn(),
      listSandboxes: vi.fn(),
      destroy: vi.fn(),
    };

    const adapter = new SandboxAdapter(manager as any);

    await expect(adapter.create({ id: 'next-phase' } as any)).rejects.toThrow('removal already in progress');
    expect(adapter.isHealthy()).toBe(false);
    await expect(adapter.create({ id: 'next-phase' } as any)).resolves.toBeUndefined();
    expect(manager.preflight).toHaveBeenCalledTimes(1);
    expect(manager.create).toHaveBeenCalledTimes(2);
    expect(adapter.isHealthy()).toBe(true);
  });

  it('preflight resets health when successful', async () => {
    const manager = {
      preflight: vi.fn(),
    };
    const adapter = new SandboxAdapter(manager as any);
    adapter['markUnhealthy']?.(new Error('fail'));
    expect(adapter.isHealthy()).toBe(false);
    await adapter.preflight();
    expect(adapter.isHealthy()).toBe(true);
  });

  it('forwards session-removal ownership to local sandbox teardown', async () => {
    const manager = {
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new SandboxAdapter(manager as any);
    const session = { id: 'session-removing' } as any;

    await adapter.destroy(session, { sessionRemovalId: session.id });

    expect(manager.destroy).toHaveBeenCalledWith(
      session,
      { sessionRemovalId: session.id },
    );
  });

  it('still tears down resources after the adapter becomes unhealthy', async () => {
    const manager = {
      create: vi.fn().mockRejectedValue(new Error('provision failed')),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new SandboxAdapter(manager as any);
    const session = { id: 'failed-session', sandboxImage: 'image' } as any;

    await expect(adapter.create(session)).rejects.toThrow('provision failed');
    expect(adapter.isHealthy()).toBe(false);
    await adapter.destroy(session);

    expect(manager.destroy).toHaveBeenCalledWith(session, {});
  });

  it('marks unhealthy when execute fails and wraps the error', async () => {
    const manager = {
      execute: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const adapter = new SandboxAdapter(manager as any);
    const session = { id: 's1', sandboxImage: 'img' } as any;

    await expect(adapter.execute(session, 'ls')).rejects.toThrow('sandbox_unavailable: boom');
    expect(adapter.isHealthy()).toBe(false);
    await expect(adapter.execute(session, 'ls')).rejects.toThrow('sandbox_unavailable');
  });

  it('marks unhealthy when exec fails and wraps the error', async () => {
    const manager = {
      exec: vi.fn(async () => {
        throw new Error('bad');
      }),
    };
    const adapter = new SandboxAdapter(manager as any);

    await expect(adapter.exec({ sessionId: 's1' } as any)).rejects.toThrow('sandbox_unavailable: bad');
    expect(adapter.isHealthy()).toBe(false);
  });

  it('does not mark adapter unhealthy when remote execute fails', async () => {
    const manager = {
      execute: vi.fn(),
    };
    const remote = {
      exec: vi.fn(async () => {
        throw new Error('runner_disconnected:r1');
      }),
    };
    const adapter = new SandboxAdapter(manager as any, remote as any);
    const session = {
      id: 's-remote',
      sandboxImage: 'img',
      flags: { securityops: { executionTarget: 'scope_runner', runnerId: 'r1' } },
    } as any;

    await expect(adapter.execute(session, 'ls')).rejects.toThrow('runner_disconnected:r1');
    expect(adapter.isHealthy()).toBe(true);
  });

  it('does not mark adapter unhealthy when remote exec fails', async () => {
    const manager = {
      exec: vi.fn(),
    };
    const remote = {
      exec: vi.fn(async () => {
        throw new Error('runner_request_timeout:req1');
      }),
    };
    const adapter = new SandboxAdapter(manager as any, remote as any);
    const session = {
      id: 's-remote',
      flags: { securityops: { executionTarget: 'scope_runner', runnerId: 'r1' } },
    } as any;

    await expect(adapter.exec({ session, cmd: 'pwd' } as any)).rejects.toThrow(
      'runner_request_timeout:req1',
    );
    expect(adapter.isHealthy()).toBe(true);
  });

  it('routes managed shell jobs through the remote runner when a session is runner-backed', async () => {
    const files = new Map<string, Buffer>();
    const manager = {
      startManagedShellJob: vi.fn(),
      traceRecorder: undefined,
      artifactDirName: '.artifacts',
    };
    const remote = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', bytesOut: 0, bytesErr: 0 }),
      writeFile: vi.fn(async ({ path, content }: { path: string; content: string | Buffer }) => {
        files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
      }),
      readFile: vi.fn(async ({ path }: { path: string }) => {
        const data = files.get(path);
        if (!data) throw new Error('missing');
        return data;
      }),
      statFile: vi.fn(async ({ path }: { path: string }) => {
        const data = files.get(path);
        if (!data) throw new Error('missing');
        return { exists: true, isFile: true, sizeBytes: data.byteLength, mtimeMs: 0 };
      }),
    };
    const adapter = new SandboxAdapter(manager as any, remote as any);
    const session = {
      id: 's-remote',
      flags: { securityops: { executionTarget: 'scope_runner', runnerId: 'r1' } },
    } as any;

    const result = await adapter.startManagedShellJob(session, 'sleep 60', { waitBudgetMs: 0 });

    expect(result.status).toBe('running');
    expect(remote.exec).toHaveBeenCalledWith(expect.objectContaining({
      runnerId: 'r1',
      cmd: expect.stringContaining('nohup bash'),
    }));
    expect(manager.startManagedShellJob).not.toHaveBeenCalled();
  });

  it('uses one run-scoped remote workspace key across private-runner lifecycle and file operations', async () => {
    const files = new Map<string, Buffer>();
    const manager = {
      create: vi.fn(),
      destroy: vi.fn(),
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(),
    };
    const remote = {
      sessionInit: vi.fn(async (_params: Record<string, unknown>) => undefined),
      sessionDestroy: vi.fn(async (_params: Record<string, unknown>) => undefined),
      writeFile: vi.fn(async ({ path, content }: { path: string; content: string | Buffer }) => {
        files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
      }),
      readFile: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? Buffer.from('')),
      statFile: vi.fn(async ({ path }: { path: string }) => {
        const data = files.get(path);
        return {
          exists: Boolean(data),
          isFile: Boolean(data),
          sizeBytes: data?.byteLength ?? 0,
          mtimeMs: 0,
        };
      }),
    };
    const adapter = new SandboxAdapter(manager as any, remote as any);
    const session = {
      id: 'phase-session-1',
      flags: {
        securityops: {
          executionTarget: 'scope_runner',
          runnerId: 'runner-1',
          runId: '61250a38-3919-4362-baee-4f97a538bce6',
        },
      },
    } as any;

    await adapter.create(session);
    await adapter.writeFile(session, 'journal/model.md', 'model');
    const content = await adapter.readFile(session, 'journal/model.md');
    await adapter.destroy(session);

    expect(content.toString('utf8')).toBe('model');
    for (const call of [
      remote.sessionInit.mock.calls[0]?.[0],
      remote.writeFile.mock.calls[0]?.[0],
      remote.readFile.mock.calls[0]?.[0],
      remote.sessionDestroy.mock.calls[0]?.[0],
    ]) {
      expect(call).toMatchObject({
        runnerId: 'runner-1',
        sessionId: 'phase-session-1',
        workspaceKey: 'run-61250a38-3919-4362-baee-4f97a538bce6',
      });
    }
    expect(manager.create).not.toHaveBeenCalled();
    expect(manager.destroy).not.toHaveBeenCalled();
    expect(manager.writeFile).toHaveBeenCalledWith(session, 'journal/model.md', 'model');
  });
});
