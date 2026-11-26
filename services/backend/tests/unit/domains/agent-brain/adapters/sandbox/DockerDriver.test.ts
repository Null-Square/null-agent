import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

import { DockerDriver } from '@/domains/agent-brain/adapters/sandbox';

const makeChild = () => {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end: vi.fn(),
    on: vi.fn(),
  };
  child.kill = vi.fn();
  return child;
};

describe('DockerDriver', () => {
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates containers and returns the container id', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: 'cid-1\n', stderr: '' });
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    const id = await driver.create({
      image: 'img',
      name: 'sandbox',
      network: 'bridge',
      readonlyRootfs: true,
      user: 'agent',
      cpuQuota: 1.5,
      memoryMb: 1024,
      pidsLimit: 256,
      shmSizeMb: 512,
      seccompProfilePath: '/seccomp.json',
      capDrop: ['ALL'],
      capAdd: ['NET_ADMIN'],
      securityOpts: ['no-new-privileges'],
      env: { KEY: 'VALUE' },
    });

    expect(id).toBe('cid-1');
    const args = execFileAsync.mock.calls[0][1];
    expect(args).toEqual(
      expect.arrayContaining([
        'run',
        '-d',
        '--rm',
        '--name',
        'sandbox',
        '--network',
        'bridge',
        '--read-only',
        '--user',
        'agent',
        '--cpus',
        '1.5',
        '--memory',
        '1024m',
        '--pids-limit',
        '256',
        '--shm-size',
        '512m',
        '--security-opt',
        'seccomp=/seccomp.json',
        '--security-opt',
        'no-new-privileges',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'NET_ADMIN',
        '-e',
        'KEY=VALUE',
        'img',
      ]),
    );
    expect(args.slice(-2)).toEqual(['-c', 'sleep infinity']);
  });

  it('opens a raw byte stream to a container process, without a TTY', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);

    const stream = driver.execStream('cid-1', ['socat', 'STDIO', 'TCP:127.0.0.1:9222']);

    expect(stream).toBe(child);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      ['exec', '-i', 'cid-1', 'socat', 'STDIO', 'TCP:127.0.0.1:9222'],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
  });

  it('throws when docker run returns an empty container id', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    await expect(driver.create({
      image: 'img',
      name: 'sandbox',
      network: 'bridge',
      readonlyRootfs: false,
    })).rejects.toThrow('Docker run did not return a container id');
  });

  it('ignores stop errors', async () => {
    const execFileAsync = vi.fn().mockRejectedValue(new Error('stop failed'));
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    await expect(driver.stop('cid-1')).resolves.toBeUndefined();
  });

  it('ignores destroy errors for missing containers', async () => {
    const error = Object.assign(new Error('missing'), { stderr: 'No such container' });
    const execFileAsync = vi.fn().mockRejectedValue(error);
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    await expect(driver.destroy('missing')).resolves.toBeUndefined();
  });

  it('rethrows destroy errors when container exists', async () => {
    const error = Object.assign(new Error('permission denied'), { stderr: 'permission denied' });
    const execFileAsync = vi.fn().mockRejectedValue(error);
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    await expect(driver.destroy('cid-1')).rejects.toThrow('permission denied');
  });

  it('bounds container destruction so Docker cannot pin session cleanup', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    await driver.destroy('cid-1');

    expect(execFileAsync).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'cid-1'],
      expect.objectContaining({
        timeout: 15_000,
        windowsHide: true,
      }),
    );
  });

  it('lists containers and skips malformed lines', async () => {
    const output = '{"ID":"1","Names":"n1"}\nnot-json\n{"ID":"2","Names":"n2"}';
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: output, stderr: '' });
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    const rows = await driver.list('ns-agent-');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.ID).toBe('1');
    expect(rows[1]?.Names).toBe('n2');
  });

  it('returns null when inspecting a missing image', async () => {
    const error = Object.assign(new Error('missing'), { stderr: 'No such image' });
    const execFileAsync = vi.fn().mockRejectedValue(error);
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    await expect(driver.inspectImage('missing')).resolves.toBeNull();
  });

  it('executes a command and streams output', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);

    const resultPromise = driver.exec('cid-1', {
      cmd: 'echo hi',
      cwd: '/workspace',
      env: { A: '1' },
      user: 'root',
    });

    child.stdout.emit('data', Buffer.from('out'));
    child.stderr.emit('data', Buffer.from('err'));
    child.emit('close', 0);

    const result = await resultPromise;

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.exitCode).toBe(0);
    const args = mocks.spawn.mock.calls[0][1];
    expect(args).toEqual(
      expect.arrayContaining([
        'exec',
        '-i',
        '--user',
        'root',
        '-e',
        'A=1',
        'cid-1',
        'bash',
        '-lc',
        'cd /workspace && echo hi',
      ]),
    );
  });

  it('passes stdin to docker exec when provided', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);

    const resultPromise = driver.exec('cid-1', {
      cmd: 'cat > /workspace/out.txt',
      user: 'root',
      stdin: Buffer.from('payload'),
    });

    child.emit('close', 0);
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from('payload'));
  });

  it('starts detached exec commands without attaching to the process', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const driver = new DockerDriver(log);
    (driver as any).execFileAsync = execFileAsync;

    await driver.execDetached('cid-1', {
      cmd: 'bash /workspace/.artifacts/shell-jobs/job/runner.sh',
      cwd: '/workspace',
      env: { A: '1' },
      user: 'root',
    });

    expect(execFileAsync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-d',
        '--user',
        'root',
        '-e',
        'A=1',
        'cid-1',
        'bash',
        '-lc',
        'cd /workspace && bash /workspace/.artifacts/shell-jobs/job/runner.sh',
      ]),
      expect.objectContaining({
        timeout: 15_000,
        windowsHide: true,
      }),
    );
  });

  it('marks exec as timed out and aborts the process', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);

    const resultPromise = driver.exec('cid-1', {
      cmd: 'sleep 10',
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(20);
    child.emit('close', null);
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('marks exec as aborted when the signal fires', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);
    const controller = new AbortController();

    const resultPromise = driver.exec('cid-1', {
      cmd: 'echo hi',
      signal: controller.signal,
    });

    controller.abort();
    child.emit('close', null);
    const result = await resultPromise;

    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('Aborted by operator');
  });

  it('rejects docker build failures', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);

    const promise = driver.build({
      tag: 'img:latest',
      contextPath: '/ctx',
    });

    child.emit('close', 1);
    await expect(promise).rejects.toThrow('Docker build failed with code 1');
  });

  it('aborts docker build when the signal is triggered', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);
    const controller = new AbortController();

    const promise = driver.build({
      tag: 'img:latest',
      contextPath: '/ctx',
      signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toThrow('Build aborted');
    expect(child.kill).toHaveBeenCalled();
  });

  it('rejects docker push failures', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const driver = new DockerDriver(log);

    const promise = driver.push('img:latest');

    child.emit('close', 1);
    await expect(promise).rejects.toThrow('Docker push failed with code 1');
  });
});
