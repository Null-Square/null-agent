import { describe, expect, it, vi } from 'vitest';
import { ManagedShellJobService } from '@/domains/agent-brain/adapters/sandbox/ManagedShellJobService';

const makeHarness = (initialFiles: Record<string, string> = {}) => {
  const files = new Map<string, Buffer>(
    Object.entries(initialFiles).map(([key, value]) => [key, Buffer.from(value)]),
  );
  const fs = {
    writeFile: vi.fn(async (_session: unknown, targetPath: string, content: string | Buffer) => {
      files.set(targetPath, Buffer.isBuffer(content) ? content : Buffer.from(content));
    }),
    readFileTail: vi.fn(async (_session: unknown, targetPath: string, maxBytes: number) => {
      const data = files.get(targetPath);
      if (!data) {
        throw new Error('missing file');
      }
      return data.subarray(Math.max(0, data.byteLength - maxBytes));
    }),
    stat: vi.fn(async (_session: unknown, targetPath: string) => {
      const data = files.get(targetPath);
      if (!data) {
        throw new Error('missing file');
      }
      return { size: data.byteLength, mode: 0o644, mtimeMs: 0, isDirectory: false };
    }),
  };
  const docker = {
    execDetached: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(async (_containerId: string, options: { cmd: string }) => {
      if (options.cmd.startsWith('test -f ')) {
        return { stdout: '', stderr: '', exitCode: 1, timedOut: false, aborted: false };
      }
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false };
    }),
    copyToContainer: vi.fn().mockResolvedValue(undefined),
  };
  const lifecycle = {
    ensureContainer: vi.fn().mockResolvedValue(undefined),
  };
  const traceRecorder = {
    write: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ManagedShellJobService({
    docker: docker as never,
    fs: fs as never,
    lifecycle: lifecycle as never,
    artifactDirName: '.artifacts',
    traceRecorder: traceRecorder as never,
    log: { warn: vi.fn() } as never,
  });
  const session = { id: 'session-1', containerId: 'cid-1', turn: 2 } as never;

  return { service, session, files, fs, docker, lifecycle, traceRecorder };
};

describe('ManagedShellJobService', () => {
  it('starts a detached shell job and returns running metadata after the initial wait budget', async () => {
    const { service, session, files, docker, lifecycle, fs, traceRecorder } = makeHarness();

    const result = await service.start(session, 'sleep 60', {
      waitBudgetMs: 0,
      hardTimeoutMs: 120_000,
      turnNumber: 5,
    });

    expect(lifecycle.ensureContainer).toHaveBeenCalledWith(session);
    expect(docker.execDetached).toHaveBeenCalledWith('cid-1', expect.objectContaining({
      cmd: expect.stringContaining('/workspace/.artifacts/shell-jobs/'),
    }));
    expect(result.status).toBe('running');
    expect(result.commandFinished).toBe(false);
    expect(result.success).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(result.outputPath).toContain('.artifacts/shell-jobs/');
    expect(fs.writeFile).toHaveBeenCalledWith(session, expect.stringContaining('/command.sh'), expect.stringContaining('sleep 60'));
    expect(docker.exec).toHaveBeenCalledWith('cid-1', expect.objectContaining({
      cmd: expect.stringContaining('cat >'),
      stdin: expect.any(Buffer),
    }));
    expect(Array.from(files.keys()).some((key) => key.endsWith('/runner.sh'))).toBe(true);
    expect(traceRecorder.write).toHaveBeenCalledWith(
      'session-1',
      5,
      expect.objectContaining({ event: 'shell_job.started' }),
    );
  });

  it('reads job state from the container when bind-mounted host files are stale', async () => {
    const jobId = 'shelljob-fixed';
    const base = `.artifacts/shell-jobs/${jobId}`;
    const { service, session, docker } = makeHarness({
      [`${base}/command.sh`]: 'sleep 60\n',
      [`${base}/status.json`]: JSON.stringify({
        jobId,
        sessionId: 'session-1',
        status: 'running',
        startedAt: '2026-04-18T00:00:00.000Z',
        exitCode: null,
      }),
      [`${base}/stdout.log`]: '',
      [`${base}/stderr.log`]: '',
    });
    docker.exec.mockImplementation(async (_containerId: string, options: { cmd: string }) => {
      if (options.cmd.includes('status.json') && options.cmd.includes('tail -c')) {
        return {
          stdout: JSON.stringify({
            jobId,
            sessionId: 'session-1',
            status: 'completed',
            startedAt: '2026-04-18T00:00:00.000Z',
            completedAt: '2026-04-18T00:00:01.000Z',
            exitCode: 0,
          }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
        };
      }
      if (options.cmd.includes('stdout.log') && options.cmd.includes('tail -c')) {
        return { stdout: 'container-ok\n', stderr: '', exitCode: 0, timedOut: false, aborted: false };
      }
      if (options.cmd.includes('stderr.log') && options.cmd.includes('tail -c')) {
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false };
      }
      if (options.cmd.includes('command.sh') && options.cmd.includes('tail -c')) {
        return { stdout: 'echo ok\n', stderr: '', exitCode: 0, timedOut: false, aborted: false };
      }
      if (options.cmd.includes('wc -c')) {
        return {
          stdout: options.cmd.includes('stdout.log') ? '13\n' : '0\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false };
    });

    const result = await service.check(session, jobId);

    expect(result.status).toBe('completed');
    expect(result.stdout).toBe('container-ok\n');
    expect(result.bytesOut).toBe(13);
  });

  it('checks completed jobs with tailed stdout and stderr', async () => {
    const jobId = 'shelljob-fixed';
    const base = `.artifacts/shell-jobs/${jobId}`;
    const { service, session } = makeHarness({
      [`${base}/command.sh`]: 'echo ok\n',
      [`${base}/status.json`]: JSON.stringify({
        jobId,
        sessionId: 'session-1',
        status: 'completed',
        startedAt: '2026-04-18T00:00:00.000Z',
        completedAt: '2026-04-18T00:00:01.000Z',
        exitCode: 0,
      }),
      [`${base}/stdout.log`]: 'ok\n',
      [`${base}/stderr.log`]: '',
    });

    const result = await service.check(session, jobId);

    expect(result).toMatchObject({
      jobId,
      status: 'completed',
      success: true,
      commandFinished: true,
      stdout: 'ok\n',
      exitCode: 0,
    });
  });

  it('cancels a running job and persists cancellation state', async () => {
    const jobId = 'shelljob-fixed';
    const base = `.artifacts/shell-jobs/${jobId}`;
    const { service, session, docker, files } = makeHarness({
      [`${base}/command.sh`]: 'sleep 60\n',
      [`${base}/status.json`]: JSON.stringify({
        jobId,
        sessionId: 'session-1',
        status: 'running',
        startedAt: '2026-04-18T00:00:00.000Z',
        exitCode: null,
      }),
      [`${base}/stdout.log`]: '',
      [`${base}/stderr.log`]: '',
      [`${base}/pid`]: '123',
    });

    const result = await service.cancel(session, jobId, 'test_cancel');
    const writtenStatus = JSON.parse(files.get(`${base}/status.json`)!.toString('utf8'));

    expect(docker.exec).toHaveBeenCalledWith('cid-1', expect.objectContaining({
      cmd: expect.stringContaining('kill -TERM'),
      timeoutMs: 5000,
    }));
    expect(writtenStatus).toMatchObject({ status: 'cancelled', cancelled: true, cancellationReason: 'test_cancel' });
    expect(result.status).toBe('cancelled');
    expect(result.success).toBe(false);
  });
});
