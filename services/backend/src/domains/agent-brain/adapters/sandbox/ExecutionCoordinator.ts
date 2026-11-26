import type { ExecService } from './ExecService';
import type { SandboxStreamCallbacks, ExecOptions } from './types';
import type { SessionState } from '../../domain/types';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { ExecResult } from './types';
import type { SandboxLifecycle } from './SandboxLifecycle';
import type { AppLogger } from '@/shared/logger';

type ActiveExecution = { stop: (reason?: string) => void };
const getAbortReason = (signal: AbortSignal): string | undefined => {
  const reason = (signal as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
};

export class ExecutionCoordinator {
  constructor(
    private readonly execService: ExecService,
    private readonly lifecycle: SandboxLifecycle,
    private readonly shellTimeoutMs: number,
    private readonly activeExecutions: Map<string, ActiveExecution>,
    private readonly recordExecFinish: (
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
    ) => Promise<void> | void,
    private readonly log: AppLogger,
    private readonly traceRecorder?: SessionTraceRecorder,
  ) { }

  async execute(
    session: SessionState,
    command: string,
    callbacks: SandboxStreamCallbacks,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    await this.lifecycle.ensureContainer(session);

    const abortController = new AbortController();
    const stopExecution = (reason?: string) => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason ?? 'Aborted by operator');
      }
    };

    let externalAbortHandler: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        stopExecution(getAbortReason(signal));
      } else {
        externalAbortHandler = () => stopExecution(getAbortReason(signal));
        signal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }

    this.activeExecutions.set(session.id, { stop: stopExecution });

    try {
      const execResult = await this.execService.run({
        session,
        containerId: session.containerId!,
        cmd: command,
        timeoutMs,
        signal: abortController.signal,
        onStdout: callbacks.onStdout,
        onStderr: callbacks.onStderr,
      });

      const recorder = this.traceRecorder;
      const turn = (session.turn ?? 0) + 1;
      if (recorder) {
        await this.recordExecFinish(session.id, turn, {
          command,
          result: {
            exitCode: execResult.exitCode,
            timedOut: execResult.timedOut,
            aborted: execResult.aborted,
            bytesOut: execResult.bytesOut,
            bytesErr: execResult.bytesErr,
            artifacts: execResult.artifacts,
          },
          mode: 'docker',
        });
      }

      return execResult;
    } finally {
      this.activeExecutions.delete(session.id);
      if (signal && externalAbortHandler) {
        signal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }

  async exec(
    options: ExecOptions & { session?: SessionState; sessionId?: string; containerId?: string },
  ): Promise<ExecResult> {
    const { sessionId: _sessionId, session: providedSession, containerId, signal, onStdout, onStderr, ...rest } =
      options;

    const session = providedSession as SessionState;
    await this.lifecycle.ensureContainer(session);
    const resolvedContainerId = containerId ?? session.containerId;

    if (!resolvedContainerId) {
      throw new Error(`Session ${session.id} does not have an active container.`);
    }
    this.lifecycle.markSessionActive(session.id);

    return this.execService.run({
      session,
      containerId: resolvedContainerId,
      cmd: rest.cmd,
      timeoutMs: rest.timeoutMs ?? this.shellTimeoutMs,
      signal,
      onStdout,
      onStderr,
    });
  }

  stop(sessionId: string, reason?: string): void {
    const active = this.activeExecutions.get(sessionId);
    if (!active) {
      return;
    }

    try {
      active.stop(reason ?? 'Aborted by operator');
    } catch (error: unknown) {
      this.log.warn({ err: error, sessionId }, 'Failed to stop active execution');
    }
  }
}
