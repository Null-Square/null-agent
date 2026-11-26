import type { SessionState } from '../../domain/types';
import type { ExecOptions, ExecResult } from './types';
import { type DockerDriver } from './DockerDriver';
import { type FSService } from './FSService';
import { logger } from '@/shared/logger';

type StreamCallbacks = {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type ExecRequest = ExecOptions & {
  session: SessionState;
  containerId: string;
};

type ExecDependencies = {
  docker: DockerDriver;
  fs: FSService;
  stdoutLimitBytes: number;
};

export class ExecService {
  constructor(private readonly deps: ExecDependencies) {}

  async run(options: ExecRequest): Promise<ExecResult> {
    const { session, containerId, cmd, timeoutMs, signal, onStdout, onStderr, user, cwd, env } =
      options;

    if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
      throw new Error('ExecService.run requires a non-empty cmd string.');
    }

    const callbacks: StreamCallbacks = {
      onStdout: onStdout
        ? (chunk) => {
            try {
              onStdout(chunk);
            } catch (error) {
              logger.warn({ err: error }, 'ExecService.onStdout handler failed');
            }
          }
        : undefined,
      onStderr: onStderr
        ? (chunk) => {
            try {
              onStderr(chunk);
            } catch (error) {
              logger.warn({ err: error }, 'ExecService.onStderr handler failed');
            }
          }
        : undefined,
    };

    const dockerResult = await this.deps.docker.exec(containerId, {
      cmd,
      user,
      cwd,
      env,
      timeoutMs,
      signal,
      onStdout: callbacks.onStdout,
      onStderr: callbacks.onStderr,
    });

    const stdoutBuffer = Buffer.from(dockerResult.stdout ?? '', 'utf8');
    const stderrBuffer = Buffer.from(dockerResult.stderr ?? '', 'utf8');
    const stdoutLimit = this.deps.stdoutLimitBytes;

    let stdoutTail = stdoutBuffer;
    let stderrTail = stderrBuffer;

    const artifacts: ExecResult['artifacts'] = {};
    let hasArtifacts = false;

    if (Number.isFinite(stdoutLimit) && stdoutLimit >= 0 && stdoutBuffer.byteLength > stdoutLimit) {
      const artifact = await this.deps.fs.writeArtifact(session, {
        prefix: 'stdout',
        extension: 'log',
        content: stdoutBuffer,
      });
      artifacts.stdoutPath = artifact.relativePath;
      stdoutTail = stdoutBuffer.subarray(stdoutBuffer.byteLength - stdoutLimit);
      hasArtifacts = true;
    }

    if (Number.isFinite(stdoutLimit) && stdoutLimit >= 0 && stderrBuffer.byteLength > stdoutLimit) {
      const artifact = await this.deps.fs.writeArtifact(session, {
        prefix: 'stderr',
        extension: 'log',
        content: stderrBuffer,
      });
      artifacts.stderrPath = artifact.relativePath;
      stderrTail = stderrBuffer.subarray(stderrBuffer.byteLength - stdoutLimit);
      hasArtifacts = true;
    }

    return {
      exitCode: dockerResult.exitCode,
      stdout: stdoutTail.toString('utf8'),
      stderr: stderrTail.toString('utf8'),
      artifacts: hasArtifacts ? artifacts : undefined,
      bytesOut: dockerResult.bytesOut,
      bytesErr: dockerResult.bytesErr,
      timedOut: dockerResult.timedOut,
      aborted: dockerResult.aborted,
      abortReason: dockerResult.abortReason,
    };
  }

  async abort(_containerId: string): Promise<void> {
    throw new Error('ExecService.abort is not implemented yet.');
  }
}

