import { describe, it, expect, vi } from 'vitest';
import { DockerExecutionStrategy } from '@/domains/agent-brain/adapters/sandbox';

describe('DockerExecutionStrategy', () => {
  it('requires a container id', async () => {
    const execService = { run: vi.fn() } as any;
    const strategy = new DockerExecutionStrategy(execService);

    await expect(
      strategy.execute({ id: 'session-1' } as any, 'echo test', { onStdout: vi.fn(), onStderr: vi.fn() }, 1000),
    ).rejects.toThrow('DockerExecutionStrategy requires a containerId');
  });

  it('delegates to ExecService with callbacks', async () => {
    const execService = { run: vi.fn().mockResolvedValue({ exitCode: 0 }) } as any;
    const strategy = new DockerExecutionStrategy(execService);
    const callbacks = { onStdout: vi.fn(), onStderr: vi.fn() };
    const controller = new AbortController();

    const result = await strategy.execute(
      { id: 'session-1' } as any,
      'echo test',
      callbacks,
      1500,
      controller.signal,
      'container-1',
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(execService.run).toHaveBeenCalledWith({
      session: { id: 'session-1' },
      containerId: 'container-1',
      cmd: 'echo test',
      timeoutMs: 1500,
      signal: controller.signal,
      onStdout: callbacks.onStdout,
      onStderr: callbacks.onStderr,
    });
  });
});
