import type { SessionState, SandboxPolicySummary } from '../../domain/types';
import type {
  SandboxStreamCallbacks,
  ExecOptions,
  ExecResult,
  ManagedShellJobCheckOptions,
  ManagedShellJobResult,
  ManagedShellJobStartOptions,
  RuntimeBundleOwnership,
  SandboxDestroyOptions,
  SandboxListEntry,
} from './types';
import { type SandboxManager } from './SandboxManager';
import type { SessionStore } from '../../application/core/SessionStore';
import { logger } from '@/shared/logger';
import { toSafeError } from '@/shared/errors';
import {
  remoteExecAdapter,
  type RemoteExecAdapter,
  RunnerTimeoutError,
  RunnerDisconnectedError,
} from '@/domains/security-ops/runners/RemoteExecAdapter';
import {
  isScopeRunnerBinding,
  resolveRunnerWorkspaceKey,
  resolveRunnerSessionBinding,
} from '@/domains/security-ops/runners/runnerSession';
import { RemoteManagedShellJobService } from './RemoteManagedShellJobService';

/**
 * Adapter that exposes SandboxManager through port interfaces.
 */
export class SandboxAdapter {
  private healthy = true;
  private lastError?: string;
  private readonly log = logger.child({ scope: 'SandboxAdapter' });
  private sessionStore?: SessionStore;

  constructor(
    private readonly manager: SandboxManager,
    private readonly remote: RemoteExecAdapter = remoteExecAdapter,
  ) {}

  private async ensureHealthy(): Promise<void> {
    if (!this.healthy) {
      // Health is a circuit, not a permanent process-wide fuse. A provisioning operation can
      // lose a race with container teardown even though Docker itself is healthy a moment later.
      // Re-probe before rejecting new work so the normal lifecycle retry can recover.
      try {
        await this.preflight();
      } catch {
        const error = new Error('sandbox_unavailable') as Error & {
          details?: string;
        };
        error.details = this.lastError;
        throw error;
      }
    }
  }

  private markUnhealthy(error: unknown): void {
    this.healthy = false;
    this.lastError = toSafeError(error).message;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  getManager(): SandboxManager {
    return this.manager;
  }

  async preflight(): Promise<void> {
    try {
      const managerWithPreflight = this.manager as SandboxManager & {
        preflight?: () => Promise<void>;
      };
      if (typeof managerWithPreflight.preflight === 'function') {
        await managerWithPreflight.preflight();
      }
      this.healthy = true;
    } catch (error: unknown) {
      this.markUnhealthy(error);
      throw error;
    }
  }

  bindSessionStore(sessionStore: SessionStore): void {
    this.sessionStore = sessionStore;
    const managerWithBinder = this.manager as SandboxManager & {
      bindSessionStore?: (store: SessionStore) => void;
    };
    if (typeof managerWithBinder.bindSessionStore === 'function') {
      managerWithBinder.bindSessionStore(sessionStore);
    }
  }

  async create(session: SessionState): Promise<void> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      await this.remote.sessionInit({
        runnerId: remoteRunner,
        sessionId: session.id,
        workspaceKey: this.resolveRemoteWorkspaceKey(session),
      });
      return;
    }
    try {
      await this.manager.create(session);
    } catch (error: unknown) {
      const originalMessage = toSafeError(error).message;
      this.log.error(
        {
          err: error,
          sessionId: session.id,
          sandboxImage: session.sandboxImage,
        },
        '[SandboxAdapter] Failed to create sandbox - ORIGINAL CAUSE: ' + originalMessage,
      );
      this.markUnhealthy(error);
      const sandboxError = new Error(`sandbox_unavailable: ${originalMessage}`) as Error & {
        cause?: unknown;
        sessionId?: string;
        sandboxImage?: string;
      };
      sandboxError.cause = error;
      sandboxError.sessionId = session.id;
      sandboxError.sandboxImage = session.sandboxImage;
      throw sandboxError;
    }
  }

  async getPolicy(sessionId: string): Promise<SandboxPolicySummary | undefined> {
    await this.ensureHealthy();
    return this.manager.getAppliedPolicy(sessionId);
  }

  async destroy(session: SessionState, options: SandboxDestroyOptions = {}): Promise<void> {
    // Teardown must remain available after an execution/provisioning fault.
    // Health gates protect new work; using them to skip destroy silently leaks
    // the very resource that may have caused the adapter to become unhealthy.
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      await this.remote
        .sessionDestroy({
          runnerId: remoteRunner,
          sessionId: session.id,
          workspaceKey: this.resolveRemoteWorkspaceKey(session),
        })
        .catch((error) => {
          this.log.warn(
            { err: error, sessionId: session.id, runnerId: remoteRunner },
            '[SandboxAdapter] Failed to destroy remote runner session',
          );
        });
      return;
    }
    await this.manager.destroy(session, options);
  }

  async stopSandbox(containerIdOrSession: string | SessionState, reason?: string): Promise<void> {
    await this.ensureHealthy();
    if (typeof containerIdOrSession === 'string') {
      return this.manager.stopSandbox(containerIdOrSession);
    }
    if (this.resolveRemoteRunner(containerIdOrSession)) {
      return;
    }
    return this.manager.stop(containerIdOrSession, reason);
  }

  async destroySandbox(session: SessionState): Promise<void> {
    if (this.resolveRemoteRunner(session)) {
      await this.destroy(session);
      return;
    }
    await this.manager.destroy(session);
  }

  async destroyOwnedBundleAndVerify(ownership: RuntimeBundleOwnership): Promise<void> {
    await this.manager.destroyOwnedBundleAndVerify(ownership);
  }

  async listSandboxes(): Promise<SandboxListEntry[]> {
    await this.ensureHealthy();
    return this.manager.listSandboxes();
  }

  async restartSandbox(containerId: string): Promise<void> {
    await this.ensureHealthy();
    return this.manager.restartSandbox(containerId);
  }

  async pauseSandbox(containerId: string): Promise<void> {
    await this.ensureHealthy();
    return this.manager.pauseSandbox(containerId);
  }

  async unpauseSandbox(containerId: string): Promise<void> {
    await this.ensureHealthy();
    return this.manager.unpauseSandbox(containerId);
  }

  async getSandboxLogs(containerId: string, options: { tail?: number; since?: string } = {}): Promise<string> {
    await this.ensureHealthy();
    // Call docker driver directly through manager since SandboxManager exposes it via getManager
    const manager = this.manager as unknown as {
      docker: {
        logs: (id: string, opts: { tail?: number; since?: string }) => Promise<string>;
      };
    };
    return manager.docker.logs(containerId, options);
  }

  getContainerId(sessionId: string): string | undefined {
    if (!this.healthy) return undefined;
    return this.manager.getContainerId(sessionId);
  }

  getAppliedPolicy(sessionId: string) {
    return this.manager.getAppliedPolicy(sessionId);
  }

  // passthrough exec helpers
  async execute(
    session: SessionState,
    command: string,
    callbacks: SandboxStreamCallbacks = {},
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut?: boolean | undefined;
    aborted?: boolean | undefined;
    abortReason?: string | undefined;
    artifacts?: ExecResult['artifacts'];
  }> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      try {
        const result = await this.remote.exec({
          runnerId: remoteRunner,
          sessionId: session.id,
          workspaceKey: this.resolveRemoteWorkspaceKey(session),
          cmd: command,
          timeoutMs,
          signal,
          onStdout: callbacks.onStdout,
          onStderr: callbacks.onStderr,
        });
        return {
          success: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.exitCode,
          artifacts: result.artifacts,
        };
      } catch (error) {
        if (error instanceof RunnerTimeoutError) {
          return {
            success: false,
            stdout: '',
            stderr: error.message,
            code: null,
            timedOut: true,
          };
        }
        if (error instanceof RunnerDisconnectedError) {
          return {
            success: false,
            stdout: '',
            stderr: error.message,
            code: null,
            aborted: true,
            abortReason: 'runner_disconnected',
          };
        }
        throw error;
      }
    }

    try {
      return await this.manager.execute(session, command, callbacks, timeoutMs, signal);
    } catch (error: unknown) {
      const originalMessage = toSafeError(error).message;
      this.log.error(
        { err: error, sessionId: session.id },
        '[SandboxAdapter] Failed to execute command - ORIGINAL CAUSE: ' + originalMessage,
      );
      this.markUnhealthy(error);
      const sandboxError = new Error(`sandbox_unavailable: ${originalMessage}`) as Error & { cause?: unknown };
      sandboxError.cause = error;
      throw sandboxError;
    }
  }

  async exec(
    options: ExecOptions & {
      session?: SessionState;
      sessionId?: string;
      containerId?: string;
    },
  ): Promise<ExecResult> {
    await this.ensureHealthy();
    const session = options.session ?? this.resolveSession(options.sessionId);
    const remoteRunner = session ? this.resolveRemoteRunner(session) : null;
    if (session && remoteRunner) {
      try {
        return await this.remote.exec({
          runnerId: remoteRunner,
          sessionId: session.id,
          workspaceKey: this.resolveRemoteWorkspaceKey(session),
          cmd: options.cmd,
          env: options.env,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          onStdout: options.onStdout,
          onStderr: options.onStderr,
        });
      } catch (error) {
        if (error instanceof RunnerTimeoutError) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: error.message,
            bytesOut: 0,
            bytesErr: 0,
            timedOut: true,
          };
        }
        if (error instanceof RunnerDisconnectedError) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: error.message,
            bytesOut: 0,
            bytesErr: 0,
            aborted: true,
            abortReason: 'runner_disconnected',
          };
        }
        throw error;
      }
    }

    try {
      return await this.manager.exec(options);
    } catch (error: unknown) {
      const originalMessage = toSafeError(error).message;
      this.log.error(
        { err: error, sessionId: options.sessionId },
        '[SandboxAdapter] Failed to exec command - ORIGINAL CAUSE: ' + originalMessage,
      );
      this.markUnhealthy(error);
      const sandboxError = new Error(`sandbox_unavailable: ${originalMessage}`) as Error & { cause?: unknown };
      sandboxError.cause = error;
      throw sandboxError;
    }
  }

  async startManagedShellJob(
    session: SessionState,
    command: string,
    options: ManagedShellJobStartOptions = {},
  ): Promise<ManagedShellJobResult> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      return this.createRemoteManagedShellJobs(remoteRunner).start(session, command, options);
    }
    return this.manager.startManagedShellJob(session, command, options);
  }

  async checkManagedShellJob(
    session: SessionState,
    jobId: string,
    options: ManagedShellJobCheckOptions = {},
  ): Promise<ManagedShellJobResult> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      return this.createRemoteManagedShellJobs(remoteRunner).check(session, jobId, options);
    }
    return this.manager.checkManagedShellJob(session, jobId, options);
  }

  async cancelManagedShellJob(session: SessionState, jobId: string, reason?: string): Promise<ManagedShellJobResult> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      return this.createRemoteManagedShellJobs(remoteRunner).cancel(session, jobId, reason);
    }
    return this.manager.cancelManagedShellJob(session, jobId, reason);
  }

  async stop(session: SessionState | string, reason?: string): Promise<void> {
    await this.ensureHealthy();
    if (typeof session !== 'string' && this.resolveRemoteRunner(session)) {
      return;
    }
    return this.manager.stop(session, reason);
  }

  async runSidecar(options: {
    session?: SessionState;
    sessionId?: string;
    name?: string;
    image?: string;
    command?: string[];
    env?: Record<string, string>;
    capabilityProfile?: string;
  }) {
    await this.ensureHealthy();
    const { session, sessionId, ...rest } = options;
    const resolvedSession = session ?? this.resolveSession(sessionId);
    if (resolvedSession && this.resolveRemoteRunner(resolvedSession)) {
      throw new Error('runner_sidecars_not_supported');
    }
    return this.manager.runSidecar({
      session: resolvedSession ?? undefined,
      sessionId,
      ...rest,
    });
  }

  async stopSidecars(sessionId: string, containerId?: string): Promise<void> {
    await this.ensureHealthy();
    const session = this.resolveSession(sessionId);
    if (session && this.resolveRemoteRunner(session)) {
      return;
    }
    return this.manager.stopSidecars(sessionId, containerId);
  }

  async writeFile(session: SessionState, targetPath: string, content: string | Buffer): Promise<void> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      await this.remote.writeFile({
        runnerId: remoteRunner,
        sessionId: session.id,
        workspaceKey: this.resolveRemoteWorkspaceKey(session),
        path: targetPath,
        content,
      });
      // Keep local workspace in sync for artifact collection/report gating.
      await this.manager.writeFile(session, targetPath, content);
      return;
    }
    return this.manager.writeFile(session, targetPath, content);
  }

  async readFile(session: SessionState, targetPath: string, maxBytes?: number): Promise<Buffer> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      const data = await this.remote.readFile({
        runnerId: remoteRunner,
        sessionId: session.id,
        workspaceKey: this.resolveRemoteWorkspaceKey(session),
        path: targetPath,
        maxBytes,
      });
      if (typeof maxBytes === 'number' && maxBytes >= 0 && data.byteLength > maxBytes) {
        return data.subarray(0, maxBytes);
      }
      return data;
    }
    return this.manager.readFile(session, targetPath, maxBytes);
  }

  async statFile(
    session: SessionState,
    targetPath: string,
  ): Promise<{
    exists: boolean;
    isFile: boolean;
    sizeBytes: number;
    mtimeMs: number | null;
    isSymbolicLink: boolean | null;
  }> {
    await this.ensureHealthy();
    const remoteRunner = this.resolveRemoteRunner(session);
    if (remoteRunner) {
      return this.remote.statFile({
        runnerId: remoteRunner,
        sessionId: session.id,
        workspaceKey: this.resolveRemoteWorkspaceKey(session),
        path: targetPath,
      });
    }

    const stat = await this.manager.stat(session, targetPath);
    return {
      exists: true,
      isFile: stat.isDirectory !== true,
      sizeBytes: stat.size,
      mtimeMs: typeof stat.mtimeMs === 'number' ? stat.mtimeMs : null,
      isSymbolicLink: stat.isSymbolicLink,
    };
  }

  private resolveSession(sessionId?: string): SessionState | null {
    if (!sessionId || !this.sessionStore) {
      return null;
    }
    return this.sessionStore.get(sessionId) ?? null;
  }

  private resolveRemoteRunner(session: SessionState): string | null {
    const binding = resolveRunnerSessionBinding(session);
    if (!isScopeRunnerBinding(binding)) {
      return null;
    }
    return binding.runnerId;
  }

  private resolveRemoteWorkspaceKey(session: SessionState): string | undefined {
    return resolveRunnerWorkspaceKey(session);
  }

  private createRemoteManagedShellJobs(runnerId: string): RemoteManagedShellJobService {
    return new RemoteManagedShellJobService({
      remote: this.remote,
      runnerId,
      artifactDirName: (this.manager as unknown as { artifactDirName?: string }).artifactDirName || '.artifacts',
      traceRecorder: (this.manager as unknown as { traceRecorder?: unknown }).traceRecorder as never,
      log: this.log,
    });
  }
}
