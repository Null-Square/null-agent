import { randomUUID } from 'crypto';
import path from 'path';
import type { SessionState } from '../../domain/types';
import type {
  ManagedShellJobCheckOptions,
  ManagedShellJobResult,
  ManagedShellJobStartOptions,
  ManagedShellJobStatus,
} from './types';
import type { RemoteExecAdapter } from '@/domains/security-ops/runners/RemoteExecAdapter';
import { resolveRunnerWorkspaceKey } from '@/domains/security-ops/runners/runnerSession';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { AppLogger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';

const DEFAULT_WAIT_BUDGET_MS = 15_000;
const DEFAULT_NEXT_CHECK_AFTER_MS = 2_000;
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 250;
const OUTPUT_TAIL_BYTES = 65_536;

const createAbortError = (reason?: unknown): Error => {
  const message = reason?.toString().trim() || 'aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

type JobPaths = {
  base: string;
  command: string;
  runner: string;
  status: string;
  stdout: string;
  stderr: string;
  pid: string;
};

type StatusFile = {
  jobId?: string;
  sessionId?: string;
  status?: ManagedShellJobStatus;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  cancellationReason?: string;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(createAbortError(signal.reason));
      },
      { once: true },
    );
  });

const isTerminalStatus = (status: ManagedShellJobStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

const normalizeWaitBudget = (value: number | undefined): number =>
  Math.max(0, Math.min(DEFAULT_WAIT_BUDGET_MS, Math.floor(value ?? DEFAULT_WAIT_BUDGET_MS)));

const normalizeCheckWaitBudget = (value: number | undefined): number =>
  Math.max(0, Math.min(DEFAULT_WAIT_BUDGET_MS, Math.floor(value ?? 0)));

const normalizeHardTimeout = (value: number | undefined): number =>
  Math.max(1_000, Math.floor(value ?? DEFAULT_HARD_TIMEOUT_MS));

const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

const tailText = (buffer: Buffer, maxBytes = OUTPUT_TAIL_BYTES): string => {
  if (buffer.byteLength <= maxBytes) {
    return buffer.toString('utf8');
  }
  return buffer.subarray(buffer.byteLength - maxBytes).toString('utf8');
};

export class RemoteManagedShellJobService {
  private readonly emittedTerminalTraceKeys = new Set<string>();

  constructor(
    private readonly deps: {
      remote: RemoteExecAdapter;
      runnerId: string;
      artifactDirName: string;
      traceRecorder?: SessionTraceRecorder;
      log: AppLogger;
    },
  ) {}

  async start(
    session: SessionState,
    command: string,
    options: ManagedShellJobStartOptions = {},
  ): Promise<ManagedShellJobResult> {
    const jobId = `shelljob-${randomUUID()}`;
    const paths = this.paths(jobId);
    const startedAt = new Date().toISOString();
    const hardTimeoutMs = normalizeHardTimeout(options.hardTimeoutMs);

    await this.writeInitialFiles(session, paths, {
      jobId,
      sessionId: session.id,
      command,
      startedAt,
      hardTimeoutMs,
    });

    await this.deps.remote.exec({
      runnerId: this.deps.runnerId,
      sessionId: session.id,
      workspaceKey: this.workspaceKey(session),
      cmd: `nohup bash ${shellSingleQuote(paths.runner)} >/dev/null 2>&1 &`,
      timeoutMs: 5_000,
      signal: options.signal,
    });

    await this.recordTrace(session, 'shell_job.started', {
      jobId,
      command,
      outputPath: paths.base,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      statusPath: paths.status,
      waitBudgetMs: normalizeWaitBudget(options.waitBudgetMs),
      hardTimeoutMs,
      remoteRunner: true,
    }, `remote shell job ${jobId} started`, 'info', options.turnNumber);

    return this.waitForInitialResult(session, jobId, {
      ...options,
      waitBudgetMs: normalizeWaitBudget(options.waitBudgetMs),
      nextCheckAfterMs: options.nextCheckAfterMs ?? DEFAULT_NEXT_CHECK_AFTER_MS,
    });
  }

  async check(
    session: SessionState,
    jobId: string,
    options: ManagedShellJobCheckOptions = {},
  ): Promise<ManagedShellJobResult> {
    const result = await this.waitForResult(session, jobId, {
      waitBudgetMs: normalizeCheckWaitBudget(options.waitBudgetMs),
      nextCheckAfterMs: DEFAULT_NEXT_CHECK_AFTER_MS,
      signal: options.signal,
    });
    if (isTerminalStatus(result.status)) {
      await this.recordTrace(session, `shell_job.${result.status}`, {
        jobId,
        status: result.status,
        exitCode: result.exitCode,
        stdoutPath: result.stdoutPath,
        stderrPath: result.stderrPath,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        remoteRunner: true,
      }, `remote shell job ${jobId} ${result.status}`, result.status === 'failed' ? 'warn' : 'info', options.turnNumber);
    }
    return result;
  }

  async cancel(
    session: SessionState,
    jobId: string,
    reason = 'cancelled_by_agent',
  ): Promise<ManagedShellJobResult> {
    const paths = this.paths(jobId);
    await this.deps.remote.exec({
      runnerId: this.deps.runnerId,
      sessionId: session.id,
      workspaceKey: this.workspaceKey(session),
      cmd: `if [ -f ${shellSingleQuote(paths.pid)} ]; then kill -TERM "$(cat ${shellSingleQuote(paths.pid)})" 2>/dev/null || true; fi`,
      timeoutMs: 5_000,
    });

    const previous = await this.readStatus(session, paths);
    await this.writeStatus(session, paths, {
      ...previous,
      jobId,
      sessionId: session.id,
      status: 'cancelled',
      exitCode: null,
      completedAt: new Date().toISOString(),
      cancelled: true,
      cancellationReason: reason,
    });

    await this.recordTrace(session, 'shell_job.cancelled', {
      jobId,
      reason,
      remoteRunner: true,
    }, `remote shell job ${jobId} cancelled`, 'warn');

    return this.buildResult(session, jobId, DEFAULT_NEXT_CHECK_AFTER_MS);
  }

  private paths(jobId: string): JobPaths {
    const base = path.posix.join(this.deps.artifactDirName || '.artifacts', 'shell-jobs', jobId);
    return {
      base,
      command: path.posix.join(base, 'command.sh'),
      runner: path.posix.join(base, 'runner.sh'),
      status: path.posix.join(base, 'status.json'),
      stdout: path.posix.join(base, 'stdout.log'),
      stderr: path.posix.join(base, 'stderr.log'),
      pid: path.posix.join(base, 'pid'),
    };
  }

  private async writeInitialFiles(
    session: SessionState,
    paths: JobPaths,
    input: {
      jobId: string;
      sessionId: string;
      command: string;
      startedAt: string;
      hardTimeoutMs: number;
    },
  ): Promise<void> {
    await this.writeFile(session, paths.command, input.command.endsWith('\n') ? input.command : `${input.command}\n`);
    await this.writeFile(session, paths.stdout, '');
    await this.writeFile(session, paths.stderr, '');
    await this.writeStatus(session, paths, {
      jobId: input.jobId,
      sessionId: input.sessionId,
      status: 'running',
      startedAt: input.startedAt,
      exitCode: null,
    });
    await this.writeFile(session, paths.runner, this.buildRunnerScript(paths, input));
  }

  private buildRunnerScript(
    paths: JobPaths,
    input: {
      jobId: string;
      sessionId: string;
      startedAt: string;
      hardTimeoutMs: number;
    },
  ): string {
    const hardTimeoutSeconds = Math.max(1, Math.ceil(input.hardTimeoutMs / 1000));
    return [
      '#!/usr/bin/env bash',
      'set +e',
      `JOB_ID=${shellSingleQuote(input.jobId)}`,
      `SESSION_ID=${shellSingleQuote(input.sessionId)}`,
      `STARTED_AT=${shellSingleQuote(input.startedAt)}`,
      `COMMAND_FILE=${shellSingleQuote(paths.command)}`,
      `STATUS_FILE=${shellSingleQuote(paths.status)}`,
      `STDOUT_FILE=${shellSingleQuote(paths.stdout)}`,
      `STDERR_FILE=${shellSingleQuote(paths.stderr)}`,
      `PID_FILE=${shellSingleQuote(paths.pid)}`,
      'mkdir -p "$(dirname "$STATUS_FILE")"',
      'echo "$$" > "$PID_FILE"',
      'printf \'{"jobId":"%s","sessionId":"%s","status":"running","startedAt":"%s","exitCode":null}\\n\' "$JOB_ID" "$SESSION_ID" "$STARTED_AT" > "$STATUS_FILE"',
      `timeout ${hardTimeoutSeconds}s bash "$COMMAND_FILE" > "$STDOUT_FILE" 2> "$STDERR_FILE"`,
      'CODE=$?',
      'COMPLETED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"',
      'TIMED_OUT=false',
      'STATUS=failed',
      'if [ "$CODE" -eq 0 ]; then STATUS=completed; fi',
      'if [ "$CODE" -eq 124 ]; then TIMED_OUT=true; fi',
      'printf \'{"jobId":"%s","sessionId":"%s","status":"%s","startedAt":"%s","completedAt":"%s","exitCode":%s,"timedOut":%s}\\n\' "$JOB_ID" "$SESSION_ID" "$STATUS" "$STARTED_AT" "$COMPLETED_AT" "$CODE" "$TIMED_OUT" > "$STATUS_FILE"',
      'exit 0',
      '',
    ].join('\n');
  }

  private async waitForInitialResult(
    session: SessionState,
    jobId: string,
    options: ManagedShellJobStartOptions & { waitBudgetMs: number; nextCheckAfterMs: number },
  ): Promise<ManagedShellJobResult> {
    return this.waitForResult(session, jobId, options);
  }

  private async waitForResult(
    session: SessionState,
    jobId: string,
    options: {
      waitBudgetMs: number;
      nextCheckAfterMs: number;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ): Promise<ManagedShellJobResult> {
    const deadline = Date.now() + options.waitBudgetMs;
    let stdoutOffset = 0;
    let stderrOffset = 0;

    while (Date.now() <= deadline) {
      const result = await this.buildResult(session, jobId, options.nextCheckAfterMs);
      const stdoutDelta = result.stdout.slice(stdoutOffset);
      const stderrDelta = result.stderr.slice(stderrOffset);
      stdoutOffset = result.stdout.length;
      stderrOffset = result.stderr.length;
      if (stdoutDelta) {
        options.onStdout?.(stdoutDelta);
      }
      if (stderrDelta) {
        options.onStderr?.(stderrDelta);
      }
      if (isTerminalStatus(result.status)) {
        return result;
      }
      if (options.waitBudgetMs === 0) {
        break;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), options.signal);
    }

    return this.buildResult(session, jobId, options.nextCheckAfterMs);
  }

  private async buildResult(
    session: SessionState,
    jobId: string,
    nextCheckAfterMs: number,
  ): Promise<ManagedShellJobResult> {
    const paths = this.paths(jobId);
    const status = await this.readStatus(session, paths);
    const stdout = await this.readText(session, paths.stdout);
    const stderr = await this.readText(session, paths.stderr);
    const stdoutSize = await this.sizeOf(session, paths.stdout, stdout);
    const stderrSize = await this.sizeOf(session, paths.stderr, stderr);
    const resolvedStatus = status.status ?? 'unknown';
    const terminal = isTerminalStatus(resolvedStatus);
    const exitCode = typeof status.exitCode === 'number' ? status.exitCode : null;

    return {
      jobId,
      sessionId: status.sessionId ?? session.id,
      command: await this.readText(session, paths.command),
      status: resolvedStatus,
      stdout,
      stderr,
      exitCode,
      success: resolvedStatus === 'running' || (resolvedStatus === 'completed' && exitCode === 0),
      commandFinished: terminal,
      outputPath: paths.base,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      statusPath: paths.status,
      pidPath: paths.pid,
      startedAt: status.startedAt ?? new Date(0).toISOString(),
      completedAt: status.completedAt,
      nextCheckAfterMs: terminal ? undefined : nextCheckAfterMs,
      bytesOut: stdoutSize,
      bytesErr: stderrSize,
      timedOut: status.timedOut,
      cancelled: status.cancelled,
      cancellationReason: status.cancellationReason,
    };
  }

  private async readStatus(session: SessionState, paths: JobPaths): Promise<StatusFile> {
    const raw = await this.readText(session, paths.status);
    if (!raw.trim()) {
      return { status: 'unknown', sessionId: session.id };
    }
    try {
      return JSON.parse(raw) as StatusFile;
    } catch {
      return { status: 'unknown', sessionId: session.id };
    }
  }

  private async writeStatus(session: SessionState, paths: JobPaths, status: StatusFile): Promise<void> {
    await this.writeFile(session, paths.status, `${JSON.stringify(status)}\n`);
  }

  private async writeFile(session: SessionState, relativePath: string, content: string | Buffer): Promise<void> {
    await this.deps.remote.writeFile({
      runnerId: this.deps.runnerId,
      sessionId: session.id,
      workspaceKey: this.workspaceKey(session),
      path: relativePath,
      content,
    });
  }

  private async readText(session: SessionState, relativePath: string): Promise<string> {
    try {
      const data = await this.deps.remote.readFile({
        runnerId: this.deps.runnerId,
        sessionId: session.id,
        workspaceKey: this.workspaceKey(session),
        path: relativePath,
      });
      return tailText(data);
    } catch {
      return '';
    }
  }

  private async sizeOf(session: SessionState, relativePath: string, fallback: string): Promise<number> {
    try {
      const stat = await this.deps.remote.statFile({
        runnerId: this.deps.runnerId,
        sessionId: session.id,
        workspaceKey: this.workspaceKey(session),
        path: relativePath,
      });
      return stat.sizeBytes;
    } catch {
      return Buffer.byteLength(fallback, 'utf8');
    }
  }

  private async recordTrace(
    session: SessionState,
    event: string,
    payload: Record<string, unknown>,
    note: string,
    severity: 'debug' | 'info' | 'warn' | 'error' = 'info',
    turnNumber?: number,
  ): Promise<void> {
    if (!this.deps.traceRecorder) {
      return;
    }
    if (!this.shouldRecordTrace(session.id, event, payload)) {
      return;
    }
    try {
      await this.deps.traceRecorder.write(session.id, turnNumber ?? (session.turn ?? 0) + 1, {
        event,
        severity,
        payload,
        note: summarizeForNote(note),
      });
    } catch (error) {
      this.deps.log.warn({ err: error, sessionId: session.id, event }, 'Failed to record remote managed shell job trace');
    }
  }

  private shouldRecordTrace(sessionId: string, event: string, payload: Record<string, unknown>): boolean {
    if (!event.startsWith('shell_job.')) {
      return true;
    }
    const status = event.slice('shell_job.'.length);
    if (!['completed', 'failed', 'cancelled'].includes(status)) {
      return true;
    }
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
    if (!jobId) {
      return true;
    }
    const key = `${sessionId}:${jobId}:${status}`;
    if (this.emittedTerminalTraceKeys.has(key)) {
      return false;
    }
    this.emittedTerminalTraceKeys.add(key);
    return true;
  }

  private workspaceKey(session: SessionState): string | undefined {
    return resolveRunnerWorkspaceKey(session);
  }
}
