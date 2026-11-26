import { describe, expect, it, vi } from 'vitest';
import { RemoteManagedShellJobService } from '@/domains/agent-brain/adapters/sandbox/RemoteManagedShellJobService';

const makeHarness = (initialFiles: Record<string, string> = {}) => {
  const files = new Map<string, Buffer>(
    Object.entries(initialFiles).map(([key, value]) => [key, Buffer.from(value)]),
  );
  const remote = {
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', bytesOut: 0, bytesErr: 0 }),
    writeFile: vi.fn(async ({ path, content }: { path: string; content: string | Buffer }) => {
      files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const data = files.get(path);
      if (!data) {
        throw new Error('missing file');
      }
      return data;
    }),
    statFile: vi.fn(async ({ path }: { path: string }) => {
      const data = files.get(path);
      if (!data) {
        throw new Error('missing file');
      }
      return { exists: true, isFile: true, sizeBytes: data.byteLength, mtimeMs: 0 };
    }),
  };
  const traceRecorder = {
    write: vi.fn().mockResolvedValue(undefined),
  };
  const service = new RemoteManagedShellJobService({
    remote: remote as never,
    runnerId: 'runner-1',
    artifactDirName: '.artifacts',
    traceRecorder: traceRecorder as never,
    log: { warn: vi.fn() } as never,
  });
  const session = { id: 'session-1', turn: 0 } as never;

  return { service, session, files, remote, traceRecorder };
};

describe('RemoteManagedShellJobService', () => {
  it('starts managed shell jobs through existing runner exec and file messages', async () => {
    const { service, session, files, remote, traceRecorder } = makeHarness();

    const result = await service.start(session, 'sleep 60', {
      waitBudgetMs: 0,
      hardTimeoutMs: 120_000,
      turnNumber: 6,
    });

    expect(remote.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      runnerId: 'runner-1',
      sessionId: 'session-1',
      path: expect.stringContaining('/command.sh'),
    }));
    expect(remote.exec).toHaveBeenCalledWith(expect.objectContaining({
      runnerId: 'runner-1',
      sessionId: 'session-1',
      cmd: expect.stringContaining('nohup bash'),
      timeoutMs: 5000,
    }));
    expect(Array.from(files.keys()).some((key) => key.endsWith('/runner.sh'))).toBe(true);
    expect(result.status).toBe('running');
    expect(result.success).toBe(true);
    expect(traceRecorder.write).toHaveBeenCalledWith(
      'session-1',
      6,
      expect.objectContaining({ event: 'shell_job.started' }),
    );
  });

  it('checks and cancels remote managed shell jobs', async () => {
    const jobId = 'shelljob-fixed';
    const base = `.artifacts/shell-jobs/${jobId}`;
    const { service, session, remote, files } = makeHarness({
      [`${base}/command.sh`]: 'sleep 60\n',
      [`${base}/status.json`]: JSON.stringify({
        jobId,
        sessionId: 'session-1',
        status: 'running',
        startedAt: '2026-04-18T00:00:00.000Z',
        exitCode: null,
      }),
      [`${base}/stdout.log`]: 'partial\n',
      [`${base}/stderr.log`]: '',
      [`${base}/pid`]: '123',
    });

    const checked = await service.check(session, jobId);
    const cancelled = await service.cancel(session, jobId, 'test_cancel');
    const status = JSON.parse(files.get(`${base}/status.json`)!.toString('utf8'));

    expect(checked).toMatchObject({ status: 'running', stdout: 'partial\n' });
    expect(remote.exec).toHaveBeenCalledWith(expect.objectContaining({
      cmd: expect.stringContaining('kill -TERM'),
    }));
    expect(status).toMatchObject({ status: 'cancelled', cancellationReason: 'test_cancel' });
    expect(cancelled.status).toBe('cancelled');
  });
});
