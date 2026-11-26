import { describe, it, expect, vi } from 'vitest';
import { ExecutionCoordinator } from '@/domains/agent-brain/adapters/sandbox';

const createCoordinator = () => {
  const execService = { run: vi.fn() } as any;
  const lifecycle = {
    ensureContainer: vi.fn(),
    markSessionActive: vi.fn(),
  } as any;
  const activeExecutions = new Map<string, { stop: (reason?: string) => void }>();
  const recordExecFinish = vi.fn().mockResolvedValue(undefined);
  const log = { warn: vi.fn() } as any;
  const traceRecorder = {} as any;

  const coordinator = new ExecutionCoordinator(
    execService,
    lifecycle,
    5000,
    activeExecutions,
    recordExecFinish,
    log,
    traceRecorder,
  );

  return { coordinator, execService, lifecycle, activeExecutions, recordExecFinish, log };
};

describe('ExecutionCoordinator', () => {
  it('executes commands and records completion', async () => {
    const { coordinator, execService, lifecycle, activeExecutions, recordExecFinish } =
      createCoordinator();
    const session = { id: 'session-1', containerId: 'container-1', turn: 2 } as any;
    const execResult = {
      exitCode: 0,
      timedOut: false,
      aborted: false,
      bytesOut: 5,
      bytesErr: 0,
      artifacts: [],
    } as any;
    execService.run.mockResolvedValue(execResult);

    const result = await coordinator.execute(
      session,
      'echo ok',
      { onStdout: vi.fn(), onStderr: vi.fn() },
      1000,
    );

    expect(lifecycle.ensureContainer).toHaveBeenCalledWith(session);
    expect(execService.run).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'echo ok', timeoutMs: 1000 }),
    );
    expect(recordExecFinish).toHaveBeenCalledWith(
      'session-1',
      3,
      expect.objectContaining({ command: 'echo ok' }),
    );
    expect(activeExecutions.has('session-1')).toBe(false);
    expect(result).toBe(execResult);
  });

  it('uses session container id for exec and throws when missing', async () => {
    const { coordinator, execService, lifecycle } = createCoordinator();
    const session = { id: 'session-2', containerId: 'container-2' } as any;
    execService.run.mockResolvedValue({ exitCode: 0 });

    await coordinator.exec({ cmd: 'ls', session });

    expect(lifecycle.markSessionActive).toHaveBeenCalledWith('session-2');
    expect(execService.run).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-2', timeoutMs: 5000 }),
    );

    await expect(coordinator.exec({ cmd: 'ls', session: { id: 's3' } as any })).rejects.toThrow(
      'Session s3 does not have an active container.',
    );
  });

  it('stops active executions and logs failures', () => {
    const { coordinator, activeExecutions, log } = createCoordinator();
    activeExecutions.set('session-3', {
      stop: vi.fn(() => {
        throw new Error('boom');
      }),
    });

    coordinator.stop('session-3', 'manual');

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-3' }),
      'Failed to stop active execution',
    );
  });
});
