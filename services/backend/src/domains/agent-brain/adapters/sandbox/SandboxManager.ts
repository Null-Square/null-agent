import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { SessionState, SandboxPolicySummary } from '../../domain/types';
import type { SessionStore } from '../../application/core/SessionStore';
import type {
  ExecOptions,
  ExecResult,
  ManagedShellJobCheckOptions,
  ManagedShellJobResult,
  ManagedShellJobStartOptions,
  RuntimeBundleOwnership,
  SandboxDestroyOptions,
  SandboxConfig,
  NamespaceAttachment,
  SandboxStreamCallbacks,
  SandboxListEntry,
} from './types';
import { ExecService } from './ExecService';
import { FSService, type FileStat } from './FSService';
import { DockerDriver } from './DockerDriver';
import { PolicyEnforcer } from './PolicyEnforcer';
import { ImageResolver } from './ImageResolver';
import { SidecarRunner, type SidecarOptions } from './SidecarRunner';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import { ContainerLifecycleManager } from './ContainerLifecycleManager';
import { SidecarManager } from './SidecarManager';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { recordSandboxLifecycle } from '@/shared/metrics/prometheusMetrics';
import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import type { PolicyResolver } from '../../domain/policy';
import { type PolicyEngine } from '../../application/services/PolicyEngine';
import { SandboxLifecycle } from './SandboxLifecycle';
import { ExecutionCoordinator } from './ExecutionCoordinator';
import { ManagedShellJobService } from './ManagedShellJobService';

// summarizeForNote imported from @/shared/utils/text

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const DEFAULT_SANDBOX_IMAGE = 'null-ai-sandbox:local';

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export interface SandboxExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  abortReason?: string;
  artifacts?: ExecResult['artifacts'];
}

export interface SandboxManagerOptions {
  sessionStore?: SessionStore;
  ttlMs?: number;
  traceRecorder?: SessionTraceRecorder;
  config?: ResolvedConfig;
  policyResolver?: PolicyResolver;
  policyFacade?: PolicyEngine;
}

interface ActiveExecution {
  stop: (reason?: string) => void;
}

export class SandboxManager {
  private readonly docker: DockerDriver;
  private readonly policy: PolicyEnforcer;
  private readonly imageResolver: ImageResolver;
  private readonly execService: ExecService;
  private readonly fsService: FSService;
  private readonly sidecarRunner: SidecarRunner;
  private readonly containerManager: ContainerLifecycleManager;
  private readonly sidecarManager: SidecarManager;
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly ttlMs: number;
  private sessionStore?: SessionStore;
  private readonly traceRecorder?: SessionTraceRecorder;
  private readonly config?: ResolvedConfig;
  private readonly sandboxMode: 'docker';
  private readonly shellTimeoutMs: number;
  private readonly artifactDirName: string;
  private readonly sandboxUser: string;
  private readonly log = logger.child({ scope: 'SandboxManager' });
  private readonly includeDockerLogs: boolean;
  private readonly policyResolver?: PolicyResolver;
  private readonly policyFacade?: PolicyEngine;
  private readonly lifecycle: SandboxLifecycle;
  private readonly executionCoordinator: ExecutionCoordinator;
  private readonly managedShellJobs: ManagedShellJobService;
  private readonly logPayload = (payload: Record<string, unknown>) => {
    const entry = { component: 'sandbox', ...payload };
    if (payload.event === 'docker.log' && !this.includeDockerLogs) {
      this.log.trace?.(entry);
      return;
    }
    this.log.debug(entry);
  };
  private readonly execFileAsync = promisify(execFile);

  constructor(options: SandboxManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? (options.config?.runtime.sessionTTLMinutes ?? 120) * 60 * 1000;
    this.traceRecorder = options.traceRecorder;
    this.config = options.config;
    this.includeDockerLogs = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.LOG_INCLUDE_DOCKER ?? process.env.LOG_VERBOSE_SANDBOX ?? '').toLowerCase(),
    );
    const sandboxConfigLayer = options.config?.sandbox;
    this.sandboxMode = 'docker';
    this.shellTimeoutMs = options.config?.runtime.shellTimeoutMs ?? 120_000;
    this.artifactDirName = options.config?.trace.artifactDirName ?? '.artifacts';
    // AUTHORITATIVE: Sandbox user comes from config, defaults to 'root' for Docker isolation.
    // TODO(P2): Consider making this configurable per-profile rather than global.
    this.sandboxUser = sandboxConfigLayer?.user ?? 'root';
    this.policyResolver = options.policyResolver;
    this.policyFacade = options.policyFacade;

    const sandboxDefaults = {
      image: sandboxConfigLayer?.image ?? DEFAULT_SANDBOX_IMAGE,
      stdoutLimitBytes: sandboxConfigLayer?.stdoutLimitBytes ?? 1_048_576,
      network: sandboxConfigLayer?.network ?? 'bridge',
      devUnsafe: sandboxConfigLayer?.devUnsafe ?? false,
      cpuQuota: sandboxConfigLayer?.cpuQuota,
      memoryMb: sandboxConfigLayer?.memoryMb,
      pidsLimit: sandboxConfigLayer?.pidsLimit,
    };

    this.fsService = new FSService({
      resolveRoots: (session) => {
        if (!session.workspaceDir) {
          throw new Error(`Session ${session.id} does not have a workspace directory.`);
        }
        const workspaceDir = path.resolve(session.workspaceDir);
        const artifactsDir = path.resolve(workspaceDir, this.artifactDirName || '.artifacts');
        return {
          workspaceDir,
          artifactsDir,
        };
      },
    });

    this.docker = new DockerDriver((message) => this.logPayload({ event: 'docker.log', message }));

    const sandboxConfig: SandboxConfig = {
      image: sandboxDefaults.image,
      workspaceHostDir: '',
      stdoutLimitBytes: sandboxDefaults.stdoutLimitBytes,
      killGraceMs: 1_500,
      defaultNetwork: sandboxDefaults.network === 'none' ? 'none' : 'bridge',
      readonlyRootfs: false,
      cpuQuota: sandboxDefaults.cpuQuota,
      memoryMb: sandboxDefaults.memoryMb,
      pidsLimit: sandboxDefaults.pidsLimit,
      user: this.sandboxUser,
      devUnsafe: sandboxDefaults.devUnsafe,
    };

    this.policy = new PolicyEnforcer(sandboxConfig);
    this.imageResolver = new ImageResolver(sandboxConfig);
    this.execService = new ExecService({
      docker: this.docker,
      fs: this.fsService,
      stdoutLimitBytes: sandboxDefaults.stdoutLimitBytes,
    });
    this.sidecarRunner = new SidecarRunner(this.docker, this.policy, this.imageResolver);

    this.containerManager = new ContainerLifecycleManager(
      this.docker,
      this.policy,
      this.imageResolver,
      this.ttlMs,
      options.sessionStore,
      this.traceRecorder,
      this.config,
      undefined,
      this.policyResolver,
      this.policyFacade,
    );

    this.sidecarManager = new SidecarManager(
      this.sidecarRunner,
      this.traceRecorder,
      this.config,
      this.policyResolver,
      this.policyFacade,
    );

    this.containerManager.setSidecarCleaner((sessionId, containerId) =>
      this.sidecarManager.stopSidecars(sessionId, containerId),
    );

    this.lifecycle = new SandboxLifecycle(this.containerManager, this.sidecarManager, this.sandboxMode);
    this.executionCoordinator = new ExecutionCoordinator(
      this.execService,
      this.lifecycle,
      this.shellTimeoutMs,
      this.activeExecutions,
      async (sessionId, turn, data) => {
        if (this.traceRecorder) {
          await this.recordExecFinish(this.traceRecorder, sessionId, turn, data);
        }
      },
      this.log,
      this.traceRecorder,
    );
    this.managedShellJobs = new ManagedShellJobService({
      docker: this.docker,
      fs: this.fsService,
      lifecycle: this.lifecycle,
      artifactDirName: this.artifactDirName || '.artifacts',
      traceRecorder: this.traceRecorder,
      log: this.log,
    });

    if (options.sessionStore) {
      this.bindSessionStore(options.sessionStore);
    }
  }

  async preflight(): Promise<void> {
    // Allow skipping preflight for containerized development (Docker-out-of-Docker)
    if (process.env.SANDBOX_SKIP_PREFLIGHT === 'true') {
      this.log.info('[SandboxManager] Skipping preflight check (SANDBOX_SKIP_PREFLIGHT=true)');
      return;
    }

    if (this.sandboxMode !== 'docker') {
      throw new Error('Sandbox requires docker mode; host execution is not supported.');
    }
    const image = this.config?.sandbox.image ?? DEFAULT_SANDBOX_IMAGE;
    // Use the configured sandboxUser (set in constructor from config)
    const user = this.sandboxUser;
    const args = ['run', '--rm', '--user', user, '--entrypoint', 'id', image, '-u'];
    this.logPayload({ event: 'sandbox.preflight', image, user });
    try {
      await this.execFileAsync('docker', args);
    } catch (error: unknown) {
      const record = isRecord(error) ? error : undefined;
      const message =
        (typeof record?.['stderr'] === 'string' && record['stderr']) ||
        (typeof record?.['stdout'] === 'string' && record['stdout']) ||
        (error instanceof Error ? error.message : String(error));
      throw new Error(
        `[SandboxPreflight] docker image '${image}' is not compatible (expected user '${user}'). ${message}`.trim(),
      );
    }
  }

  bindSessionStore(store: SessionStore): void {
    this.sessionStore = store;
  }

  async create(session: SessionState): Promise<void> {
    if (this.sandboxMode !== 'docker') {
      throw new Error('sandbox_docker_required');
    }

    const start = Date.now();
    try {
      await this.lifecycle.ensureContainer(session);
      opsMetrics.recordSandboxLifecycle('provision', Date.now() - start, 'ok');
      recordSandboxLifecycle('provision', Date.now() - start, true);
      this.logPayload({
        event: 'sandbox.provision',
        sessionId: session.id,
        status: 'ok',
      });
    } catch (error) {
      opsMetrics.recordSandboxLifecycle('provision', Date.now() - start, 'error');
      recordSandboxLifecycle('provision', Date.now() - start, false);
      this.logPayload({
        event: 'sandbox.provision',
        sessionId: session.id,
        status: 'error',
        error: (error as Error)?.message,
      });
      throw error;
    }
  }

  getAppliedPolicy(sessionId: string): SandboxPolicySummary | undefined {
    return this.containerManager.getAppliedPolicy(sessionId);
  }

  async execute(
    session: SessionState,
    command: string,
    callbacks: SandboxStreamCallbacks = {},
    timeoutMs: number = this.shellTimeoutMs,
    signal?: AbortSignal,
  ): Promise<SandboxExecutionResult> {
    if (!command || !command.trim()) {
      throw new Error('Command is required');
    }

    const execResult = await this.executionCoordinator.execute(session, command, callbacks, timeoutMs, signal);

    return {
      success: !execResult.timedOut && !execResult.aborted && execResult.exitCode === 0,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      code: execResult.exitCode,
      timedOut: execResult.timedOut,
      aborted: execResult.aborted,
      abortReason: execResult.abortReason,
      artifacts: execResult.artifacts,
    };
  }

  async stop(session: SessionState | string, reason?: string): Promise<void> {
    const sessionId = typeof session === 'string' ? session : session.id;
    const active = this.activeExecutions.get(sessionId);
    if (!active) {
      return;
    }

    try {
      active.stop(reason ?? 'Aborted by operator');
    } catch (error) {
      this.log.warn({ err: error, sessionId }, 'Failed to stop active execution');
    }
  }

  async exec(
    options: ExecOptions & {
      session?: SessionState;
      sessionId?: string;
      containerId?: string;
    },
  ): Promise<ExecResult> {
    const { sessionId, session: providedSession, containerId, signal, onStdout, onStderr, ...rest } = options;
    const session = this.resolveSession(providedSession, sessionId);
    return this.executionCoordinator.exec({
      session,
      sessionId,
      containerId,
      signal,
      onStdout,
      onStderr,
      ...rest,
    });
  }

  async startManagedShellJob(
    session: SessionState,
    command: string,
    options: ManagedShellJobStartOptions = {},
  ): Promise<ManagedShellJobResult> {
    if (!command || !command.trim()) {
      throw new Error('Command is required');
    }
    return this.managedShellJobs.start(session, command, options);
  }

  async checkManagedShellJob(
    session: SessionState,
    jobId: string,
    options: ManagedShellJobCheckOptions = {},
  ): Promise<ManagedShellJobResult> {
    if (!jobId || !jobId.trim()) {
      throw new Error('jobId is required');
    }
    return this.managedShellJobs.check(session, jobId.trim(), options);
  }

  async cancelManagedShellJob(session: SessionState, jobId: string, reason?: string): Promise<ManagedShellJobResult> {
    if (!jobId || !jobId.trim()) {
      throw new Error('jobId is required');
    }
    return this.managedShellJobs.cancel(session, jobId.trim(), reason);
  }

  async destroy(session: SessionState, options: SandboxDestroyOptions = {}): Promise<void> {
    if (this.sandboxMode !== 'docker') {
      throw new Error('sandbox_docker_required');
    }

    const start = Date.now();
    try {
      await this.lifecycle.destroy(session, options);
      opsMetrics.recordSandboxLifecycle('destroy', Date.now() - start, 'ok');
      recordSandboxLifecycle('destroy', Date.now() - start, true);
      this.logPayload({
        event: 'sandbox.destroy',
        sessionId: session.id,
        status: 'ok',
      });
    } catch (error) {
      opsMetrics.recordSandboxLifecycle('destroy', Date.now() - start, 'error');
      recordSandboxLifecycle('destroy', Date.now() - start, false);
      this.logPayload({
        event: 'sandbox.destroy',
        sessionId: session.id,
        status: 'error',
        error: (error as Error)?.message,
      });
      this.log.error({ err: error, sessionId: session.id }, 'Error destroying sandbox');
      throw error;
    }
  }

  async destroyOwnedBundleAndVerify(ownership: RuntimeBundleOwnership): Promise<void> {
    if (this.sandboxMode !== 'docker') {
      throw new Error('sandbox_docker_required');
    }
    await this.containerManager.destroyOwnedBundleAndVerify(ownership);
  }

  async init(_config: SandboxConfig): Promise<void> {
    // Reserved for future configuration plumbing.
  }

  async writeFile(session: SessionState, targetPath: string, content: string | Buffer): Promise<void> {
    // Write to host filesystem
    await this.fsService.writeFile(session, targetPath, content);

    // If session has an active container, also write through the container.
    // Docker cp is unreliable for nested writable mounts under a read-only workspace.
    if (session.containerId) {
      const containerPath = path.posix.join('/workspace', targetPath);
      const containerDir = path.posix.dirname(containerPath);

      try {
        // Ensure parent directory exists in container
        const mkdirResult = await this.docker.exec(session.containerId, {
          cmd: `mkdir -p ${shellSingleQuote(containerDir)}`,
          user: 'root',
          timeoutMs: 5_000,
        });
        if (mkdirResult.exitCode !== 0) {
          throw new Error(`mkdir failed: ${mkdirResult.stderr || mkdirResult.stdout}`);
        }
        const contentBuffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        const writeResult = await this.docker.exec(session.containerId, {
          cmd: `cat > ${shellSingleQuote(containerPath)}`,
          user: 'root',
          timeoutMs: 5_000,
          stdin: contentBuffer,
        });
        if (writeResult.exitCode !== 0) {
          throw new Error(`write failed: ${writeResult.stderr || writeResult.stdout}`);
        }
        this.log.debug(
          { sessionId: session.id, containerPath },
          '[SandboxManager] Wrote file to container via exec stdin',
        );
      } catch (error) {
        this.log.warn(
          { err: error, sessionId: session.id, targetPath },
          '[SandboxManager] Failed to write file to container',
        );
        throw error;
      }
    }
  }

  async readFile(session: SessionState, targetPath: string, maxBytes?: number): Promise<Buffer> {
    try {
      return await this.fsService.readFile(session, targetPath, maxBytes);
    } catch (error) {
      const mirrored = await this.tryMirrorWorkspaceFileFromContainer(session, targetPath);
      if (!mirrored) {
        throw error;
      }
      if (typeof maxBytes === 'number' && maxBytes >= 0 && mirrored.content.byteLength > maxBytes) {
        return mirrored.content.subarray(0, maxBytes);
      }
      return mirrored.content;
    }
  }

  async stat(session: SessionState, targetPath: string): Promise<FileStat> {
    try {
      return await this.fsService.stat(session, targetPath);
    } catch (error) {
      const mirrored = await this.tryMirrorWorkspaceFileFromContainer(session, targetPath);
      if (!mirrored) {
        throw error;
      }
      return this.fsService.stat(session, mirrored.relativePath);
    }
  }

  async cpIn(session: SessionState, srcHostPath: string, destPath: string): Promise<void> {
    await this.fsService.copyIn(session, srcHostPath, destPath);
  }

  async cpOut(session: SessionState, srcPath: string, destHostPath: string): Promise<void> {
    await this.fsService.copyOut(session, srcPath, destHostPath);
  }

  async runSidecar(
    options: Partial<SidecarOptions> & {
      session?: SessionState;
      sessionId?: string;
    },
  ): Promise<{ containerId: string; name: string }> {
    const { session: providedSession, sessionId, ...rest } = options;
    const session = this.resolveSession(providedSession, sessionId);
    return this.sidecarManager.runSidecar(session, rest);
  }

  async attachNetwork(_ns: NamespaceAttachment): Promise<void> {
    // To be implemented alongside the network service refactor.
  }

  async egressCheck(): Promise<{ ip?: string; ok: boolean }> {
    throw new Error('SandboxManager.egressCheck requires session-scoped context (todo).');
  }

  getContainerId(sessionId: string): string | undefined {
    const session = this.sessionStore?.get(sessionId);
    return session?.containerId;
  }

  getWorkspacePath(sessionId: string): string | undefined {
    const session = this.sessionStore?.get(sessionId);
    return session?.workspaceDir;
  }

  async stopSidecars(sessionId: string, containerId?: string): Promise<void> {
    return this.sidecarManager.stopSidecars(sessionId, containerId);
  }

  async listSandboxes(): Promise<SandboxListEntry[]> {
    return this.lifecycle.list();
  }

  async restartSandbox(containerId: string): Promise<void> {
    await this.lifecycle.restart(containerId);
  }

  async pauseSandbox(containerId: string): Promise<void> {
    await this.lifecycle.pause(containerId);
  }

  async unpauseSandbox(containerId: string): Promise<void> {
    await this.lifecycle.unpause(containerId);
  }

  async stopSandbox(containerId: string): Promise<void> {
    await this.lifecycle.stop(containerId);
  }

  private normalizeWorkspaceTargetPath(targetPath: string): string | null {
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
      return null;
    }

    const rawPath = targetPath.trim();
    let candidate = rawPath.replace(/\\/g, '/');
    if (candidate.startsWith('/workspace/')) {
      candidate = candidate.slice('/workspace/'.length);
    } else if (candidate.startsWith('workspace/')) {
      candidate = candidate.slice('workspace/'.length);
    } else if (path.win32.isAbsolute(rawPath) || (path.posix.isAbsolute(candidate) && candidate !== '/workspace')) {
      return null;
    }

    if (candidate === '/workspace' || candidate === 'workspace') {
      return null;
    }
    if (candidate.startsWith('./')) {
      candidate = candidate.slice(2);
    }
    while (candidate.startsWith('/')) {
      candidate = candidate.slice(1);
    }

    const normalized = path.posix.normalize(candidate);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      return null;
    }
    return normalized;
  }

  private async tryMirrorWorkspaceFileFromContainer(
    session: SessionState,
    targetPath: string,
  ): Promise<{ relativePath: string; content: Buffer } | null> {
    if (!session.containerId) {
      return null;
    }

    const relativePath = this.normalizeWorkspaceTargetPath(targetPath);
    if (!relativePath) {
      return null;
    }

    const containerPath = path.posix.join('/workspace', relativePath);
    const fs = await import('fs/promises');
    const os = await import('os');
    const tempFilePath = path.join(os.tmpdir(), `download-${session.id}-${Date.now()}-${path.basename(relativePath)}`);

    try {
      await this.docker.copyFromContainer(session.containerId, {
        hostPath: tempFilePath,
        containerPath,
      });
      const content = await fs.readFile(tempFilePath);
      await this.fsService.writeFile(session, relativePath, content);
      return { relativePath, content };
    } finally {
      await fs.unlink(tempFilePath).catch(() => undefined);
    }
  }

  private resolveSession(session: SessionState | undefined, sessionId: string | undefined): SessionState {
    if (session) {
      return session;
    }
    if (!sessionId) {
      throw new Error('Sandbox session must be provided by object or id.');
    }
    const lookedUp = this.sessionStore?.get(sessionId);
    if (!lookedUp) {
      throw new Error(`Sandbox session ${sessionId} not found.`);
    }
    return lookedUp;
  }

  private async recordExecFinish(
    recorder: SessionTraceRecorder,
    sessionId: string,
    turn: number,
    data: {
      command: string;
      result: {
        exitCode?: number;
        timedOut?: boolean;
        aborted?: boolean;
        bytesOut?: number;
        bytesErr?: number;
        artifacts?: ExecResult['artifacts'];
      };
      mode: 'docker';
    },
  ): Promise<void> {
    const note = summarizeForNote(`${data.mode} exec: ${data.command}`);
    await recorder.write(sessionId, turn, {
      event: 'sandbox.exec.finish',
      severity: data.result.exitCode === 0 ? 'info' : 'warn',
      payload: {
        command: data.command,
        exitCode: data.result.exitCode,
        timedOut: data.result.timedOut,
        aborted: data.result.aborted,
        mode: data.mode,
        bytesOut: data.result.bytesOut,
        bytesErr: data.result.bytesErr,
        artifacts: data.result.artifacts,
      },
      note,
    });

    if (data.result.artifacts) {
      for (const [kind, relativePath] of Object.entries(data.result.artifacts)) {
        if (!relativePath) {
          continue;
        }
        await recorder.write(sessionId, turn, {
          event: 'sandbox.artifact.created',
          severity: 'info',
          payload: {
            path: relativePath,
            kind,
          },
          note: summarizeForNote(`${kind} artifact: ${relativePath}`),
        });
      }
    }
  }
}
