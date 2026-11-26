import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContainerLifecycleManager } from '@/domains/agent-brain/adapters/sandbox';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const makeSession = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: overrides.id ?? 'session-1',
  messages: [],
  plan: [],
  memory: createEmptyMemory(),
  flags: {},
  workspaceDir: overrides.workspaceDir ?? '/tmp/ws/session-1',
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 0,
  pendingApproval: undefined,
  checkpoints: {},
  ...overrides,
});

const baseProfile = {
  name: 'hardened',
  privileged: false,
  readonlyRootfs: true,
  network: 'bridge',
  capDrop: ['ALL'],
  capAdd: [],
};

const buildDeps = (overrides: Partial<any> = {}) => {
  const docker = {
    inspect: vi.fn(),
    inspectImage: vi.fn().mockResolvedValue({ id: 'img' }),
    create: vi.fn().mockResolvedValue('cid-1'),
    exec: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'NULLAI_HTTP_PROXY=started',
      stderr: '',
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn(),
    listByLabel: vi.fn(),
    restart: vi.fn(),
    pause: vi.fn(),
    unpause: vi.fn(),
  };
  const policy = {
    applySecurityDefaults: vi.fn((opts) => opts),
  };
  const imageResolver = {
    resolve: vi.fn().mockReturnValue('resolved-image'),
  };
  const traceRecorder = {
    write: vi.fn().mockResolvedValue(undefined),
  };
  const policyFacade = {
    resolveSandboxCapabilities: vi.fn().mockResolvedValue(baseProfile),
  };
  const sessionStore = {
    get: vi.fn(),
    set: vi.fn(),
    setAsync: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockReturnValue([]),
  };

  return {
    docker,
    policy,
    imageResolver,
    traceRecorder,
    policyFacade,
    sessionStore,
    ...overrides,
  };
};

describe('ContainerLifecycleManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("says once, from the network a sandbox really gets, that Docker's default bridge has no seal", async () => {
    const createTwoSandboxes = async (network: string) => {
      const deps = buildDeps({
        policyFacade: { resolveSandboxCapabilities: vi.fn().mockResolvedValue({ ...baseProfile, network }) },
      });
      deps.docker.create.mockResolvedValueOnce('cid-a').mockResolvedValueOnce('cid-b');
      const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() };
      const manager = new ContainerLifecycleManager(
        deps.docker as any,
        deps.policy as any,
        deps.imageResolver as any,
        60_000,
        undefined,
        undefined,
        // The configured network is not what decides: a sandbox policy may name its own.
        { sandbox: { user: 'agent', network: 'null-ai-sandbox' } } as any,
        log as any,
        undefined,
        deps.policyFacade as any,
      );
      await manager.createContainer(makeSession({ id: 'sa', workspaceDir: '/tmp/ws/sa', sandboxImage: 'img' }));
      await manager.createContainer(makeSession({ id: 'sb', workspaceDir: '/tmp/ws/sb', sandboxImage: 'img' }));
      return log.warn.mock.calls.filter(([, message]) => String(message).includes('without the seal'));
    };

    const unsealed = await createTwoSandboxes('bridge');
    expect(unsealed).toHaveLength(1);
    expect(unsealed[0][1]).toContain('browser');

    expect(await createTwoSandboxes('null-ai-sandbox')).toHaveLength(0);
  });

  it('creates a new container and updates session state', async () => {
    const deps = buildDeps();
    const session = makeSession({
      id: 's1',
      workspaceDir: '/tmp/ws/s1',
      sandboxImage: 'img',
    });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      {
        sandbox: {
          user: 'agent',
          cpuQuota: 1.5,
          memoryMb: 1024,
          pidsLimit: 256,
        },
      } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    const containerId = await manager.createContainer(session);

    expect(containerId).toBe('cid-1');
    expect(session.containerId).toBe('cid-1');
    expect(deps.sessionStore.set).toHaveBeenCalledWith('s1', expect.objectContaining({ containerId: 'cid-1' }));
    expect(manager.getAppliedPolicy('s1')).toEqual(expect.objectContaining({ profile: 'hardened', privileged: false }));
    expect(deps.docker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'resolved-image',
        cpuQuota: 1.5,
        memoryMb: 1024,
        pidsLimit: 256,
        // Room in /dev/shm for the browser that runs in the sandbox.
        shmSizeMb: 512,
      }),
    );
    const createdTrace = deps.traceRecorder.write.mock.calls
      .map((call) => call[2])
      .find((event) => event?.event === 'sandbox.created');
    expect(createdTrace?.payload?.limits).toEqual({
      cpuQuota: 1.5,
      memoryMb: 1024,
      memoryBytes: 1024 * 1024 * 1024,
      pidsLimit: 256,
      enforced: true,
      source: 'docker',
    });
  });

  it('labels admitted runtime with its complete durable ownership tuple', async () => {
    const deps = buildDeps();
    const session = makeSession({
      id: 'phase-admitted',
      sandboxImage: 'img',
      flags: {
        securityops: {
          runId: 'run-admitted',
          cloudAdmission: {
            admissionEpoch: 3,
            leaseId: 'lease-base',
            bundleKey: 'run:run-admitted:epoch:3',
            workerTaskId: 'worker-task-1',
          },
        },
      } as any,
    });
    deps.sessionStore.get.mockReturnValue(session);
    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await manager.createContainer(session);

    expect(deps.docker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.objectContaining({
          'nullai.run-id': 'run-admitted',
          'nullai.session-id': 'phase-admitted',
          'nullai.admission-epoch': '3',
          'nullai.capacity-lease-id': 'lease-base',
          'nullai.capacity-bundle-key': 'run:run-admitted:epoch:3',
          'nullai.worker-task-id': 'worker-task-1',
        }),
      }),
    );
  });

  it('releases no bundle until label-based absence is proven', async () => {
    const deps = buildDeps();
    const owned = { ID: 'owned-1', Names: 'ns-run-run-1' };
    deps.docker.listByLabel.mockResolvedValueOnce([owned]).mockResolvedValueOnce([]);
    deps.docker.inspect.mockResolvedValue({
      Config: {
        Labels: {
          'nullai.sandbox': 'true',
          'nullai.run-id': 'run-1',
          'nullai.admission-epoch': '2',
        },
      },
    });
    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await expect(
      manager.destroyOwnedBundleAndVerify({
        runId: 'run-1',
        admissionEpoch: 2,
      }),
    ).resolves.toBeUndefined();
    expect(deps.docker.destroy).toHaveBeenCalledWith('owned-1');
    expect(deps.docker.listByLabel).toHaveBeenCalledTimes(2);
  });

  it('fails closed when an owned runtime remains after teardown', async () => {
    const deps = buildDeps();
    const owned = { ID: 'owned-1', Names: 'ns-run-run-1' };
    deps.docker.listByLabel.mockResolvedValue([owned]);
    deps.docker.inspect.mockResolvedValue({
      Config: {
        Labels: {
          'nullai.sandbox': 'true',
          'nullai.run-id': 'run-1',
          'nullai.admission-epoch': '2',
        },
      },
    });
    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await expect(
      manager.destroyOwnedBundleAndVerify({
        runId: 'run-1',
        admissionEpoch: 2,
      }),
    ).rejects.toThrow('sandbox_bundle_teardown_unverified');
  });

  it('reports container removal failures instead of recording a false cleanup', async () => {
    const deps = buildDeps();
    const session = makeSession({ id: 's-cleanup', sandboxImage: 'img' });
    deps.sessionStore.get.mockReturnValue(session);
    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );
    await manager.createContainer(session);
    deps.docker.destroy.mockRejectedValue(new Error('docker removal timed out'));

    await expect(manager.destroyContainer(session)).rejects.toThrow('docker removal timed out');
    expect(session.containerId).toBe('cid-1');
    expect(deps.traceRecorder.write).not.toHaveBeenCalledWith(
      session.id,
      expect.any(Number),
      expect.objectContaining({ event: 'sandbox.destroyed' }),
    );
  });

  it("advertises only the sandbox's own capture proxy, which the browser in the sandbox uses too", async () => {
    const deps = buildDeps({
      policyFacade: {
        resolveSandboxCapabilities: vi.fn().mockResolvedValue({
          ...baseProfile,
          network: 'nullai-db_default',
        }),
      },
    });
    const session = makeSession({
      id: 's-proxy',
      workspaceDir: '/tmp/ws/s-proxy',
      sandboxImage: 'img',
    });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await manager.createContainer(session);

    expect(deps.docker.exec).toHaveBeenCalledWith(
      'cid-1',
      expect.objectContaining({
        cmd: expect.stringContaining('mitmdump --listen-host 0.0.0.0'),
      }),
    );
    expect(session.flags?.httpProxy).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:8080',
      capturePath: '.http-proxy.ndjson',
    });
  });

  it('shares one run container across non-scoped sessions in the same run', async () => {
    const deps = buildDeps();
    deps.docker.create.mockResolvedValue('cid-run');
    const sessions = new Map<string, SessionState>();
    deps.sessionStore.get.mockImplementation((id: string) => sessions.get(id));
    deps.sessionStore.set.mockImplementation((id: string, session: SessionState) => {
      sessions.set(id, session);
      return true;
    });
    deps.sessionStore.listSessions.mockImplementation(() => [...sessions.values()]);

    const first = makeSession({
      id: 'phase-1',
      workspaceDir: '/tmp/ws/run-1',
      sandboxImage: 'img',
      flags: { securityops: { runId: 'run-1' } } as any,
    });
    const second = makeSession({
      id: 'phase-2',
      workspaceDir: '/tmp/ws/run-1',
      sandboxImage: 'img',
      flags: { securityops: { runId: 'run-1' } } as any,
    });
    sessions.set(first.id, first);
    sessions.set(second.id, second);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await expect(manager.createContainer(first)).resolves.toBe('cid-run');
    deps.docker.inspect.mockResolvedValue({ State: { Running: true } });
    await expect(manager.createContainer(second)).resolves.toBe('cid-run');

    expect(deps.docker.create).toHaveBeenCalledTimes(1);
    expect(deps.docker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ns-run-run-1',
        labels: expect.objectContaining({
          'nullai.container-scope': 'run',
          'nullai.run-id': 'run-1',
          'nullai.session-id': 'phase-1',
        }),
      }),
    );
    expect(first.containerId).toBe('cid-run');
    expect(second.containerId).toBe('cid-run');
    expect(deps.policyFacade.resolveSandboxCapabilities).toHaveBeenCalledTimes(1);
  });

  it('keeps scoped workers in session containers even when they share the run workspace', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-worker-collapse-'));
    try {
      const deps = buildDeps();
      const session = makeSession({
        id: 'worker-run-1',
        workspaceDir,
        sandboxImage: 'img',
        flags: { securityops: { runId: 'run-1' } } as any,
        coordination: {
          role: 'worker',
          parentSessionId: 'phase-1',
          parentTaskId: 'task-1',
          workerType: 'recon_worker',
          writeScope: ['/workspace/.artifacts/scans/task-1'],
        },
      });
      deps.sessionStore.get.mockReturnValue(session);

      const manager = new ContainerLifecycleManager(
        deps.docker as any,
        deps.policy as any,
        deps.imageResolver as any,
        60_000,
        deps.sessionStore as any,
        deps.traceRecorder as any,
        { sandbox: { user: 'agent' } } as any,
        undefined,
        undefined,
        deps.policyFacade as any,
      );

      await manager.createContainer(session);

      expect(deps.docker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ns-agent-worker-run-1',
          labels: expect.objectContaining({
            'nullai.container-scope': 'session',
            'nullai.run-id': 'run-1',
            'nullai.session-id': 'worker-run-1',
          }),
          mounts: [
            { source: workspaceDir, target: '/workspace', readOnly: true },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'scans', 'task-1'),
              target: '/workspace/.artifacts/scans/task-1',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.http_sessions'),
              target: '/workspace/.http_sessions',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'shell-jobs'),
              target: '/workspace/.artifacts/shell-jobs',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'python-session'),
              target: '/workspace/.artifacts/python-session',
              readOnly: false,
            },
          ],
        }),
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('keeps workers without writeScope read-only except runtime-infra submounts', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-worker-readonly-'));
    try {
      const deps = buildDeps();
      const session = makeSession({
        id: 'worker-readonly',
        workspaceDir,
        sandboxImage: 'img',
        flags: { securityops: { runId: 'run-1' } } as any,
        coordination: {
          role: 'worker',
          parentSessionId: 'phase-1',
          parentTaskId: 'task-1',
          workerType: 'repo_research_worker',
          executionMode: 'background',
          dependencyMode: 'sidecar',
        } as any,
      });
      deps.sessionStore.get.mockReturnValue(session);

      const manager = new ContainerLifecycleManager(
        deps.docker as any,
        deps.policy as any,
        deps.imageResolver as any,
        60_000,
        deps.sessionStore as any,
        deps.traceRecorder as any,
        { sandbox: { user: 'agent' } } as any,
        undefined,
        undefined,
        deps.policyFacade as any,
      );

      await manager.createContainer(session);

      expect(deps.docker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ns-agent-worker-readonly',
          labels: expect.objectContaining({
            'nullai.container-scope': 'session',
            'nullai.run-id': 'run-1',
          }),
          mounts: [
            { source: workspaceDir, target: '/workspace', readOnly: true },
            {
              source: path.resolve(workspaceDir, '.http_sessions'),
              target: '/workspace/.http_sessions',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'shell-jobs'),
              target: '/workspace/.artifacts/shell-jobs',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'python-session'),
              target: '/workspace/.artifacts/python-session',
              readOnly: false,
            },
          ],
        }),
      );
      // Workers never start the HTTP proxy capture (the parent run session owns it and
      // the worker's shared workspace is read-only outside its submounts).
      expect(deps.docker.exec).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          cmd: expect.stringContaining('mitmdump --listen-host 0.0.0.0'),
        }),
      );
      expect(session.flags?.httpProxy).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('adopts a running container when session already has one', async () => {
    const deps = buildDeps();
    deps.docker.inspect.mockResolvedValue({ State: { Running: true } });

    const session = makeSession({ id: 's2', containerId: 'cid-existing' });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    const containerId = await manager.createContainer(session);

    expect(containerId).toBe('cid-existing');
    expect(deps.docker.inspect).toHaveBeenCalledWith('cid-existing');
    expect(deps.docker.create).not.toHaveBeenCalled();
    expect(deps.policyFacade.resolveSandboxCapabilities).not.toHaveBeenCalled();
    expect(deps.traceRecorder.write).not.toHaveBeenCalledWith(
      's2',
      expect.any(Number),
      expect.objectContaining({ event: 'sandbox.policy.resolved' }),
    );
  });

  it('does not resolve or emit sandbox policy again when reusing a known container', async () => {
    const deps = buildDeps();
    const session = makeSession({
      id: 's-reuse',
      workspaceDir: '/tmp/ws/s-reuse',
      sandboxImage: 'img',
    });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await manager.createContainer(session);
    vi.clearAllMocks();
    deps.docker.inspect.mockResolvedValue({ State: { Running: true } });

    const containerId = await manager.createContainer(session);

    expect(containerId).toBe('cid-1');
    expect(deps.docker.inspect).toHaveBeenCalledWith('cid-1');
    expect(deps.policyFacade.resolveSandboxCapabilities).not.toHaveBeenCalled();
    expect(deps.docker.create).not.toHaveBeenCalled();
    expect(deps.traceRecorder.write).toHaveBeenCalledWith(
      's-reuse',
      expect.any(Number),
      expect.objectContaining({
        event: 'sandbox.attached',
        payload: expect.objectContaining({
          containerId: 'cid-1',
        }),
      }),
    );
    expect(deps.traceRecorder.write).not.toHaveBeenCalledWith(
      's-reuse',
      expect.any(Number),
      expect.objectContaining({ event: 'sandbox.policy.resolved' }),
    );
  });

  it('mounts scoped worker workspaces read-only with explicit read-write writeScope submounts', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-worker-mount-'));
    try {
      const deps = buildDeps();
      const session = makeSession({
        id: 'worker-1',
        workspaceDir,
        sandboxImage: 'img',
        coordination: {
          role: 'worker',
          parentSessionId: 'parent-1',
          parentTaskId: 'task-1',
          workerType: 'recon_worker',
          writeScope: ['/workspace/.artifacts/scans/task-1'],
        },
      });
      deps.sessionStore.get.mockReturnValue(session);

      const manager = new ContainerLifecycleManager(
        deps.docker as any,
        deps.policy as any,
        deps.imageResolver as any,
        60_000,
        deps.sessionStore as any,
        deps.traceRecorder as any,
        { sandbox: { user: 'agent' } } as any,
        undefined,
        undefined,
        deps.policyFacade as any,
      );

      await manager.createContainer(session);

      expect(deps.docker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mounts: [
            { source: workspaceDir, target: '/workspace', readOnly: true },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'scans', 'task-1'),
              target: '/workspace/.artifacts/scans/task-1',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.http_sessions'),
              target: '/workspace/.http_sessions',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'shell-jobs'),
              target: '/workspace/.artifacts/shell-jobs',
              readOnly: false,
            },
            {
              source: path.resolve(workspaceDir, '.artifacts', 'python-session'),
              target: '/workspace/.artifacts/python-session',
              readOnly: false,
            },
          ],
        }),
      );
      await expect(fs.stat(path.resolve(workspaceDir, '.artifacts', 'scans', 'task-1'))).resolves.toBeTruthy();
      await expect(fs.stat(path.resolve(workspaceDir, '.http_sessions'))).resolves.toBeTruthy();
      await expect(fs.stat(path.resolve(workspaceDir, '.artifacts', 'shell-jobs'))).resolves.toBeTruthy();
      await expect(fs.stat(path.resolve(workspaceDir, '.artifacts', 'python-session'))).resolves.toBeTruthy();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('rejects worker writeScope that grants the entire workspace', async () => {
    const deps = buildDeps();
    const session = makeSession({
      id: 'worker-root',
      workspaceDir: '/tmp/ws/worker-root',
      sandboxImage: 'img',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        writeScope: ['/workspace'],
      },
    });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await expect(manager.createContainer(session)).rejects.toThrow('entire workspace');
    expect(deps.docker.create).not.toHaveBeenCalled();
  });

  it('recreates a known container when Docker reports it stopped', async () => {
    const deps = buildDeps();
    deps.docker.create.mockResolvedValueOnce('cid-old').mockResolvedValueOnce('cid-new');
    const session = makeSession({
      id: 's-stopped',
      workspaceDir: '/tmp/ws/s-stopped',
      sandboxImage: 'img',
    });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );
    const sidecarCleaner = vi.fn().mockResolvedValue(undefined);
    manager.setSidecarCleaner(sidecarCleaner);

    await manager.createContainer(session);
    vi.clearAllMocks();
    sidecarCleaner.mockClear();
    deps.sessionStore.get.mockReturnValue(session);
    deps.docker.inspect.mockResolvedValue({ State: { Running: false } });

    const containerId = await manager.createContainer(session);

    expect(containerId).toBe('cid-new');
    expect(deps.docker.inspect).toHaveBeenCalledWith('cid-old');
    expect(deps.docker.destroy).toHaveBeenCalledWith('cid-old');
    expect(deps.docker.create).toHaveBeenCalledWith(expect.objectContaining({ image: 'resolved-image' }));
    expect(sidecarCleaner).toHaveBeenCalledWith('s-stopped', 'cid-old');
    expect(session.containerId).toBe('cid-new');
  });

  it('recreates the container when inspection fails', async () => {
    const deps = buildDeps();
    deps.docker.inspect.mockRejectedValue(new Error('missing'));

    const session = makeSession({ id: 's3', containerId: 'cid-old' });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    const containerId = await manager.createContainer(session);

    expect(containerId).toBe('cid-1');
    expect(deps.docker.destroy).toHaveBeenCalledWith('cid-old');
    expect(deps.docker.create).toHaveBeenCalled();
  });

  it('throws when the sandbox image is missing', async () => {
    const deps = buildDeps({
      docker: {
        ...buildDeps().docker,
        inspectImage: vi.fn().mockResolvedValue(null),
      },
    });

    const session = makeSession({ id: 's4', sandboxImage: 'missing-image' });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    await expect(manager.createContainer(session)).rejects.toThrow('Sandbox image');
    expect(deps.docker.create).not.toHaveBeenCalled();
  });

  it('destroys containers and clears the session container id', async () => {
    const deps = buildDeps();
    const session = makeSession({ id: 's5', containerId: 'cid-5' });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    manager.setSidecarCleaner(vi.fn().mockResolvedValue(undefined));
    (manager as any).containers.set('s5', {
      id: 'cid-5',
      lastUsed: Date.now(),
    });

    await manager.destroyContainer(session);

    expect(deps.docker.destroy).toHaveBeenCalledWith('cid-5');
    expect(deps.sessionStore.setAsync).toHaveBeenCalledWith(
      's5',
      expect.objectContaining({ containerId: undefined }),
      'sandbox.stop.cleanup',
    );
  });

  it('detaches a session from a shared run container while another run session is still active', async () => {
    const deps = buildDeps();
    const first = makeSession({
      id: 'phase-a',
      containerId: 'cid-run',
      flags: { securityops: { runId: 'run-1' } } as any,
    });
    const second = makeSession({
      id: 'phase-b',
      containerId: 'cid-run',
      flags: { securityops: { runId: 'run-1' } } as any,
    });
    const sessions = new Map<string, SessionState>([
      [first.id, first],
      [second.id, second],
    ]);
    deps.sessionStore.get.mockImplementation((id: string) => sessions.get(id));
    deps.sessionStore.listSessions.mockImplementation(() => [...sessions.values()]);
    deps.sessionStore.setAsync.mockImplementation(async (id: string, session: SessionState) => {
      sessions.set(id, session);
    });

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    (manager as any).containers.set('run:run-1', {
      id: 'cid-run',
      lastUsed: Date.now(),
      scopeKey: 'run:run-1',
      name: 'ns-run-run-1',
      runId: 'run-1',
    });

    await manager.destroyContainer(first);

    expect(deps.docker.destroy).not.toHaveBeenCalled();
    expect(first.containerId).toBeUndefined();
    expect(second.containerId).toBe('cid-run');
    expect(deps.sessionStore.setAsync).toHaveBeenCalledWith(
      'phase-a',
      expect.objectContaining({ containerId: undefined }),
      'sandbox.stop.detach',
    );
  });

  it('does not re-enter the current session lock during SessionStore-owned teardown', async () => {
    const deps = buildDeps();
    const removing = makeSession({
      id: 'phase-removing',
      containerId: 'cid-run-removal',
      flags: { securityops: { runId: 'run-removal' } } as any,
    });
    const active = makeSession({
      id: 'phase-active',
      containerId: 'cid-run-removal',
      flags: { securityops: { runId: 'run-removal' } } as any,
    });
    deps.sessionStore.get.mockImplementation((id: string) => (id === removing.id ? removing : active));
    deps.sessionStore.listSessions.mockReturnValue([removing, active]);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );
    (manager as any).containers.set('run:run-removal', {
      id: 'cid-run-removal',
      lastUsed: Date.now(),
      scopeKey: 'run:run-removal',
      name: 'ns-run-run-removal',
      runId: 'run-removal',
    });

    await manager.destroyContainer(removing, { sessionRemovalId: removing.id });

    expect(removing.containerId).toBeUndefined();
    expect(active.containerId).toBe('cid-run-removal');
    expect(deps.docker.destroy).not.toHaveBeenCalled();
    expect(deps.sessionStore.setAsync).not.toHaveBeenCalled();
  });

  it('removes a real SessionStore session without deadlocking sandbox cleanup', async () => {
    const deps = buildDeps();
    const store = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
    });
    const created = await store.create({ modelName: 'test-model' });
    await store.updateSessionAsync(created.id, (session) => {
      session.containerId = 'cid-real-removal';
      session.flags = {
        securityops: { runId: 'run-real-removal' },
      } as any;
    });
    const session = store.get(created.id)!;

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      store,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );
    (manager as any).containers.set('run:run-real-removal', {
      id: 'cid-real-removal',
      lastUsed: Date.now(),
      scopeKey: 'run:run-real-removal',
      name: 'ns-run-run-real-removal',
      runId: 'run-real-removal',
    });
    store.setOnSessionRemove(async (removing) => {
      await manager.destroyContainer(removing, {
        sessionRemovalId: removing.id,
      });
    });

    await expect(store.removeAsync(session.id, 'explicit')).resolves.toBe(true);

    expect(store.get(session.id)).toBeUndefined();
    expect(deps.docker.destroy).toHaveBeenCalledWith('cid-real-removal');
    store.shutdown();
  });

  it('stops containers by id and clears session mapping', async () => {
    const deps = buildDeps();
    const session = makeSession({ id: 's6', containerId: 'cid-6' });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      60_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    manager.setSidecarCleaner(vi.fn().mockResolvedValue(undefined));
    (manager as any).containers.set('s6', {
      id: 'cid-6',
      lastUsed: Date.now(),
    });

    await manager.stopContainer('cid-6');

    expect(deps.docker.destroy).toHaveBeenCalledWith('cid-6');
    expect(deps.sessionStore.setAsync).toHaveBeenCalledWith(
      's6',
      expect.objectContaining({ containerId: undefined }),
      'sandbox.ensure.active',
    );
  });

  it('reaps stale containers and clears session state', async () => {
    const deps = buildDeps();
    const session = makeSession({ id: 's7', containerId: 'cid-7' });
    deps.sessionStore.get.mockReturnValue(session);

    const manager = new ContainerLifecycleManager(
      deps.docker as any,
      deps.policy as any,
      deps.imageResolver as any,
      1_000,
      deps.sessionStore as any,
      deps.traceRecorder as any,
      { sandbox: { user: 'agent' } } as any,
      undefined,
      undefined,
      deps.policyFacade as any,
    );

    manager.setSidecarCleaner(vi.fn().mockResolvedValue(undefined));
    (manager as any).containers.set('s7', {
      id: 'cid-7',
      lastUsed: Date.now() - 5_000,
    });

    await (manager as any).reapStaleContainers();

    expect(deps.docker.destroy).toHaveBeenCalledWith('cid-7');
    expect(deps.sessionStore.setAsync).toHaveBeenCalledWith(
      's7',
      expect.objectContaining({ containerId: undefined }),
      'sandbox.remove.active',
    );
  });
});
