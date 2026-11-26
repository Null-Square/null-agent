import { vi, describe, it, expect, beforeEach } from 'vitest';

// Use vi.hoisted() to declare mocks that will be available in vi.mock() factories
const mocks = vi.hoisted(() => ({
  ensureContainer: vi.fn(),
  destroyContainer: vi.fn(),
  listContainers: vi.fn(),
  restartContainer: vi.fn(),
  pauseContainer: vi.fn(),
  unpauseContainer: vi.fn(),
  stopContainer: vi.fn(),
  getAppliedPolicy: vi.fn(),
  setSidecarCleaner: vi.fn(),
  execExecute: vi.fn(),
  execExec: vi.fn(),
  execStop: vi.fn(),
  runSidecar: vi.fn(),
  stopSidecars: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const fsPromisesMocks = vi.hoisted(() => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('data')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

const osMocks = vi.hoisted(() => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

vi.mock('child_process', () => childProcessMocks);
vi.mock('fs/promises', () => ({
  readFile: fsPromisesMocks.readFile,
  writeFile: fsPromisesMocks.writeFile,
  unlink: fsPromisesMocks.unlink,
}));
vi.mock('os', () => ({
  tmpdir: osMocks.tmpdir,
}));

// Mock the kubernetes client to avoid ESM import issues during tests
vi.mock('@kubernetes/client-node', () => ({
  CoreV1Api: class MockCoreV1Api {
    createNamespacedPod = vi.fn();
    deleteNamespacedPod = vi.fn();
    readNamespacedPod = vi.fn();
    readNamespacedPodStatus = vi.fn();
    listNamespacedPod = vi.fn();
    patchNamespacedPod = vi.fn();
  },
  KubeConfig: class MockKubeConfig {
    loadFromDefault = vi.fn();
    loadFromCluster = vi.fn();
    loadFromFile = vi.fn();
    makeApiClient = vi.fn().mockReturnValue({
      createNamespacedPod: vi.fn(),
      deleteNamespacedPod: vi.fn(),
      readNamespacedPod: vi.fn(),
      readNamespacedPodStatus: vi.fn(),
      listNamespacedPod: vi.fn(),
      patchNamespacedPod: vi.fn(),
    });
  },
  Exec: class MockExec {
    exec = vi.fn(() => Promise.resolve({}));
  },
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/SandboxLifecycle', () => ({
  SandboxLifecycle: class MockSandboxLifecycle {
    ensureContainer = mocks.ensureContainer;
    destroy = mocks.destroyContainer;
    list = mocks.listContainers;
    restart = mocks.restartContainer;
    pause = mocks.pauseContainer;
    unpause = mocks.unpauseContainer;
    stop = mocks.stopContainer;
  },
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/ExecutionCoordinator', () => ({
  ExecutionCoordinator: class MockExecutionCoordinator {
    execute = mocks.execExecute;
    exec = mocks.execExec;
    stop = mocks.execStop;
    activeExecutions = new Map();
  },
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/ContainerLifecycleManager', () => ({
  ContainerLifecycleManager: class MockContainerLifecycleManager {
    setSidecarCleaner = mocks.setSidecarCleaner;
    getAppliedPolicy = mocks.getAppliedPolicy;
  },
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/SidecarManager', () => ({
  SidecarManager: class MockSidecarManager {
    runSidecar = mocks.runSidecar;
    stopSidecars = mocks.stopSidecars;
  },
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/ExecService', () => ({
  ExecService: class MockExecService {},
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/FSService', () => ({
  FSService: class MockFSService {
    writeFile = vi.fn();
    readFile = vi.fn().mockResolvedValue(Buffer.from('data'));
    stat = vi.fn().mockResolvedValue({});
    copyIn = vi.fn();
    copyOut = vi.fn();
  },
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/ImageResolver', () => ({
  ImageResolver: class MockImageResolver {},
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/PolicyEnforcer', () => ({
  PolicyEnforcer: class MockPolicyEnforcer {},
}));

vi.mock('@/domains/agent-brain/adapters/sandbox/SidecarRunner', () => ({
  SidecarRunner: class MockSidecarRunner {},
}));

// Import AFTER mocks are set up
import { SandboxManager } from '@/domains/agent-brain/adapters/sandbox/SandboxManager';

describe('SandboxManager', () => {
  const session = { id: 's1', workspaceDir: '/tmp/ws', containerId: 'c-1' } as any;
  const sessionStore = {
    get: vi.fn().mockReturnValue(session),
  };
  const originalSkipPreflight = process.env.SANDBOX_SKIP_PREFLIGHT;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.get.mockReturnValue(session);
    childProcessMocks.execFile.mockReset();
    fsPromisesMocks.readFile.mockResolvedValue(Buffer.from('data'));
    fsPromisesMocks.writeFile.mockResolvedValue(undefined);
    fsPromisesMocks.unlink.mockResolvedValue(undefined);
    process.env.SANDBOX_SKIP_PREFLIGHT = originalSkipPreflight;
  });

  const makeManager = () =>
    new SandboxManager({
      sessionStore: sessionStore as any,
      config: { runtime: { shellTimeoutMs: 1_000 }, sandbox: {}, trace: {} } as any,
    });

  it('provisions a sandbox on create', async () => {
    const manager = makeManager();

    await manager.create(session);

    expect(mocks.ensureContainer).toHaveBeenCalledWith(session);
  });

  it('destroys a sandbox and propagates errors', async () => {
    const manager = makeManager();

    await manager.destroy(session);

    expect(mocks.destroyContainer).toHaveBeenCalledWith(session, {});
  });

  it('forwards session-removal ownership without changing normal teardown', async () => {
    const manager = makeManager();

    await manager.destroy(session, { sessionRemovalId: session.id });

    expect(mocks.destroyContainer).toHaveBeenCalledWith(
      session,
      { sessionRemovalId: session.id },
    );
  });

  it('throws when ensureContainer fails during create', async () => {
    mocks.ensureContainer.mockRejectedValueOnce(new Error('provision failed'));
    const manager = makeManager();

    await expect(manager.create(session)).rejects.toThrow('provision failed');
  });

  it('executes a command and maps ExecutionCoordinator result', async () => {
    mocks.execExecute.mockResolvedValueOnce({
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
    const manager = makeManager();

    const result = await manager.execute(session, 'echo hi');

    expect(mocks.execExecute).toHaveBeenCalledWith(session, 'echo hi', {}, 1_000, undefined);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        stdout: 'hello',
        stderr: '',
        code: 0,
        timedOut: false,
        aborted: false,
      }),
    );
  });

  it('marks timed-out executions as unsuccessful', async () => {
    mocks.execExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: 'timeout',
      exitCode: 0,
      timedOut: true,
      aborted: false,
      abortReason: undefined,
    });
    const manager = makeManager();

    const result = await manager.execute(session, 'sleep 1');

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it('rejects execute when command is empty', async () => {
    const manager = makeManager();
    await expect(manager.execute(session, '   ')).rejects.toThrow(/required/i);
  });

  it('forwards exec options to the execution coordinator with resolved session', async () => {
    const execResult = {
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      bytesOut: 2,
      bytesErr: 0,
    };
    mocks.execExec.mockResolvedValueOnce(execResult);
    const manager = makeManager();
    const onStdout = vi.fn();
    const onStderr = vi.fn();

    const result = await manager.exec({
      sessionId: session.id,
      containerId: 'c-1',
      cmd: 'ls -la',
      user: 'root',
      onStdout,
      onStderr,
    });

    expect(mocks.execExec).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        sessionId: session.id,
        containerId: 'c-1',
        cmd: 'ls -la',
        user: 'root',
        onStdout,
        onStderr,
      }),
    );
    expect(result).toEqual(execResult);
  });

  it('stops active execution when stop is invoked', async () => {
    const manager = makeManager();
    const stopFn = vi.fn();
    (manager as any).activeExecutions.set(session.id, { stop: stopFn });

    await manager.stop(session, 'because');

    expect(stopFn).toHaveBeenCalledWith('because');
  });

  it('uses a default stop reason when none is provided', async () => {
    const manager = makeManager();
    const stopFn = vi.fn();
    (manager as any).activeExecutions.set(session.id, { stop: stopFn });

    await manager.stop(session);

    expect(stopFn).toHaveBeenCalledWith('Aborted by operator');
  });

  it('throws when resolving session without id or object', async () => {
    const manager = makeManager();
    await expect(manager.runSidecar({ name: 'helper' } as any)).rejects.toThrow(/Sandbox session must be provided/);
  });

  it('fails when session is not found in store', async () => {
    sessionStore.get.mockReturnValueOnce(undefined);
    const manager = makeManager();
    await expect(manager.runSidecar({ sessionId: 'missing', name: 'helper' })).rejects.toThrow(/not found/);
  });

  it('runs sidecar using resolved session', async () => {
    mocks.runSidecar.mockResolvedValueOnce({ containerId: 'sidecar-1', name: 'helper' });
    const manager = makeManager();

    const response = await manager.runSidecar({ sessionId: session.id, name: 'helper' });

    expect(sessionStore.get).toHaveBeenCalledWith(session.id);
    expect(mocks.runSidecar).toHaveBeenCalledWith(session, { name: 'helper' });
    expect(response).toEqual({ containerId: 'sidecar-1', name: 'helper' });
  });

  it('writes files to host and skips container sync when no containerId', async () => {
    const manager = makeManager();
    const fsService = (manager as any).fsService;
    const docker = (manager as any).docker;
    vi.spyOn(docker, 'exec').mockResolvedValue({} as any);
    vi.spyOn(docker, 'copyToContainer').mockResolvedValue(undefined);

    const noContainer = { ...session, containerId: undefined };
    await manager.writeFile(noContainer, 'notes.txt', 'hello');

    expect(fsService.writeFile).toHaveBeenCalledWith(noContainer, 'notes.txt', 'hello');
    expect(docker.exec).not.toHaveBeenCalled();
    expect(docker.copyToContainer).not.toHaveBeenCalled();
  });

  it('writes files into the container when a containerId exists', async () => {
    const manager = makeManager();
    const fsService = (manager as any).fsService;
    const docker = (manager as any).docker;
    const execSpy = vi.spyOn(docker, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);
    const copySpy = vi.spyOn(docker, 'copyToContainer').mockResolvedValue(undefined);

    await manager.writeFile(session, 'dir/file.txt', 'hello');

    expect(fsService.writeFile).toHaveBeenCalledWith(session, 'dir/file.txt', 'hello');
    expect(execSpy).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ cmd: "mkdir -p '/workspace/dir'", user: 'root' }),
    );
    expect(execSpy).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({
        cmd: "cat > '/workspace/dir/file.txt'",
        user: 'root',
        stdin: Buffer.from('hello'),
      }),
    );
    expect(copySpy).not.toHaveBeenCalled();
  });

  it('throws when container sync fails so callers do not assume the workspace is usable', async () => {
    const manager = makeManager();
    const docker = (manager as any).docker;
    vi.spyOn(docker, 'exec')
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
      .mockResolvedValueOnce({ stdout: '', stderr: 'write failed', exitCode: 1 } as any);
    vi.spyOn(docker, 'copyToContainer').mockResolvedValue(undefined);

    await expect(manager.writeFile(session, 'dir/file.txt', 'hello')).rejects.toThrow('write failed');
  });

  it('returns applied policy from container manager', () => {
    mocks.getAppliedPolicy.mockReturnValueOnce({ network: 'bridge' });
    const manager = makeManager();

    const policy = manager.getAppliedPolicy(session.id);

    expect(mocks.getAppliedPolicy).toHaveBeenCalledWith(session.id);
    expect(policy).toEqual({ network: 'bridge' });
  });

  it('routes lifecycle operations (restart/pause/unpause/stop) to SandboxLifecycle', async () => {
    const manager = makeManager();

    await manager.restartSandbox('c-1');
    await manager.pauseSandbox('c-1');
    await manager.unpauseSandbox('c-1');
    await manager.stopSandbox('c-1');

    expect(mocks.restartContainer).toHaveBeenCalledWith('c-1');
    expect(mocks.pauseContainer).toHaveBeenCalledWith('c-1');
    expect(mocks.unpauseContainer).toHaveBeenCalledWith('c-1');
    expect(mocks.stopContainer).toHaveBeenCalledWith('c-1');
  });

  it('proxies filesystem operations to FSService', async () => {
    const manager = makeManager();
    const fsService = (manager as any).fsService;

    const buf = await manager.readFile(session, 'notes.txt');
    await manager.stat(session, 'notes.txt');
    await manager.cpIn(session, '/host/input.txt', 'input.txt');
    await manager.cpOut(session, 'output.txt', '/host/output.txt');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(fsService.readFile).toHaveBeenCalledWith(session, 'notes.txt', undefined);
    expect(fsService.stat).toHaveBeenCalledWith(session, 'notes.txt');
    expect(fsService.copyIn).toHaveBeenCalledWith(session, '/host/input.txt', 'input.txt');
    expect(fsService.copyOut).toHaveBeenCalledWith(session, 'output.txt', '/host/output.txt');
  });

  it('mirrors a workspace file from the container when it is missing on the host', async () => {
    const manager = makeManager();
    const fsService = (manager as any).fsService;
    const docker = (manager as any).docker;
    fsService.readFile.mockRejectedValueOnce(new Error('ENOENT host'));
    fsPromisesMocks.readFile.mockResolvedValueOnce(Buffer.from('remote-data'));
    vi.spyOn(docker, 'copyFromContainer').mockResolvedValue(undefined);

    const content = await manager.readFile(session, '/workspace/.artifacts/httpx.jsonl');

    expect(content.toString('utf8')).toBe('remote-data');
    expect(docker.copyFromContainer).toHaveBeenCalledWith('c-1', {
      hostPath: expect.stringContaining('download-s1-'),
      containerPath: '/workspace/.artifacts/httpx.jsonl',
    });
    expect(fsService.writeFile).toHaveBeenCalledWith(
      session,
      '.artifacts/httpx.jsonl',
      expect.any(Buffer),
    );
    expect(fsPromisesMocks.unlink).toHaveBeenCalled();
  });

  it('re-stats a mirrored workspace file after pulling it from the container', async () => {
    const manager = makeManager();
    const fsService = (manager as any).fsService;
    const docker = (manager as any).docker;
    fsService.stat
      .mockRejectedValueOnce(new Error('ENOENT host'))
      .mockResolvedValueOnce({ size: 11, mode: 0o644, mtimeMs: 123, isDirectory: false });
    fsPromisesMocks.readFile.mockResolvedValueOnce(Buffer.from('remote-stat'));
    vi.spyOn(docker, 'copyFromContainer').mockResolvedValue(undefined);

    const stat = await manager.stat(session, '/workspace/.artifacts/httpx.jsonl');

    expect(stat).toEqual({ size: 11, mode: 0o644, mtimeMs: 123, isDirectory: false });
    expect(fsService.writeFile).toHaveBeenCalledWith(
      session,
      '.artifacts/httpx.jsonl',
      expect.any(Buffer),
    );
    expect(fsService.stat).toHaveBeenNthCalledWith(2, session, '.artifacts/httpx.jsonl');
  });

  it('exposes container/workspace lookups and lists sandboxes', async () => {
    const manager = makeManager();
    mocks.listContainers.mockResolvedValueOnce([{ id: 'c-1' }]);

    const listed = await manager.listSandboxes();

    expect(listed).toEqual([{ id: 'c-1' }]);
    expect(manager.getContainerId('s1')).toBe('c-1');
    expect(manager.getWorkspacePath('s1')).toBe('/tmp/ws');
  });

  it('returns undefined when container lookup has no session', () => {
    sessionStore.get.mockReturnValueOnce(undefined);
    const manager = makeManager();

    const containerId = manager.getContainerId('missing');

    expect(containerId).toBeUndefined();
  });

  it('stops sidecars for a session', async () => {
    const manager = makeManager();

    await manager.stopSidecars('s1', 'c-1');

    expect(mocks.stopSidecars).toHaveBeenCalledWith('s1', 'c-1');
  });

  it('egressCheck currently throws to signal missing session context', async () => {
    const manager = makeManager();
    await expect(manager.egressCheck()).rejects.toThrow(/requires session-scoped context/i);
  });

  it('skips preflight when SANDBOX_SKIP_PREFLIGHT is true', async () => {
    process.env.SANDBOX_SKIP_PREFLIGHT = 'true';
    const manager = makeManager();

    await manager.preflight();

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('throws a helpful error when preflight fails', async () => {
    childProcessMocks.execFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        cb(Object.assign(new Error('bad image'), { stderr: 'docker error' }));
      }
    });
    const manager = makeManager();

    await expect(manager.preflight()).rejects.toThrow(/SandboxPreflight/);
  });
});
