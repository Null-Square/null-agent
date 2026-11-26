import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import { ShellRun, WaitForShellJob } from '@/domains/agent-brain/adapters/tools/builtins';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir: '/tmp/workspace',
    sandbox: { exec: vi.fn() } as any,
    sessionStore: { get: vi.fn() } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 2, timeoutMs: 5000 },
    flags: {},
    planRuntime: { appendProvenanceSnippet: vi.fn() } as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  }) as ToolContext;

const managedResult = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'shelljob-1',
  sessionId: 'session-1',
  command: 'sleep 60',
  status: 'running',
  stdout: '',
  stderr: '',
  exitCode: null,
  success: true,
  commandFinished: false,
  outputPath: '.artifacts/shell-jobs/shelljob-1',
  stdoutPath: '.artifacts/shell-jobs/shelljob-1/stdout.log',
  stderrPath: '.artifacts/shell-jobs/shelljob-1/stderr.log',
  statusPath: '.artifacts/shell-jobs/shelljob-1/status.json',
  pidPath: '.artifacts/shell-jobs/shelljob-1/pid',
  startedAt: '2026-04-18T00:00:00.000Z',
  nextCheckAfterMs: 5000,
  bytesOut: 0,
  bytesErr: 0,
  ...overrides,
});

describe('ShellRun', () => {
  it('rejects empty commands', async () => {
    const ctx = makeContext();

    const result = await ShellRun.run({ command: '   ' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ success: false, error: 'command is required' });
  });

  it('returns error when session is missing', async () => {
    const ctx = makeContext({ sessionStore: { get: vi.fn().mockReturnValue(undefined) } as any });

    const result = await ShellRun.run({ command: 'ls' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({
      success: false,
      error: 'Session session-1 not found',
    });
  });

  it('blocks private network targets in SecurityOps cloud sessions', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run({ command: 'nmap -sV 192.168.1.0/24' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: expect.stringContaining('private runner'),
    });
    expect(ctx.guards.cmdGuard.validate).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.startManagedShellJob).not.toHaveBeenCalled();
  });

  it('blocks alternate private address forms in SecurityOps cloud shell commands', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run({ command: 'curl http://0x7f000001/' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: expect.stringContaining('0x7f000001'),
    });
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.startManagedShellJob).not.toHaveBeenCalled();
  });

  it('streams stdout chunks and records trace output', async () => {
    const session = { id: 'session-1', turn: 1 } as any;
    const streamBroker = { emit: vi.fn() } as any;
    const planRuntime = { appendProvenanceSnippet: vi.fn() } as any;
    const trace = { write: vi.fn().mockResolvedValue(undefined) } as any;
    const sandbox = {
      exec: vi.fn(async ({ onStdout, onStderr }) => {
        onStdout?.('abcd');
        onStderr?.('ERR');
        return {
          stdout: 'abcd',
          stderr: 'ERR',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          abortReason: undefined,
          artifacts: [],
        };
      }),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
      streamBroker,
      planRuntime,
      trace,
    });

    const result = await ShellRun.run({ command: 'echo ok' }, ctx);

    expect(ctx.guards.cmdGuard.validate).toHaveBeenCalledWith('echo ok');
    expect(streamBroker.emit).toHaveBeenCalledWith('session-1', {
      type: 'tool_output',
      data: { name: 'shell_run', chunk: 'ab' },
    });
    expect(streamBroker.emit).toHaveBeenCalledWith('session-1', {
      type: 'tool_output',
      data: { name: 'shell_run', chunk: 'cd' },
    });
    expect(streamBroker.emit).toHaveBeenCalledWith('session-1', {
      type: 'tool_output',
      data: { name: 'shell_run', chunk: 'ER' },
    });
    expect(streamBroker.emit).toHaveBeenCalledWith('session-1', {
      type: 'tool_output',
      data: { name: 'shell_run', chunk: 'R' },
    });
    expect(planRuntime.appendProvenanceSnippet).toHaveBeenCalledWith('session-1', 'ab');
    expect(planRuntime.appendProvenanceSnippet).toHaveBeenCalledWith('session-1', 'cd');
    expect(planRuntime.appendProvenanceSnippet).not.toHaveBeenCalledWith('session-1', 'ER');
    expect(planRuntime.appendProvenanceSnippet).not.toHaveBeenCalledWith('session-1', 'R');
    expect(trace.write).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('throws AbortError when sandbox reports aborted', async () => {
    const session = { id: 'session-1', turn: 0 } as any;
    const sandbox = {
      exec: vi.fn(async () => ({
        stdout: '',
        stderr: '',
        exitCode: 1,
        timedOut: false,
        aborted: true,
        abortReason: 'cancelled',
        artifacts: [],
      })),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    await expect(ShellRun.run({ command: 'sleep 1' }, ctx)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'cancelled',
    });
  });

  it('starts long-running commands as managed shell jobs', async () => {
    vi.useFakeTimers();
    const session = { id: 'session-1', turn: 0 } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      turnNumber: 4,
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run({ command: 'sleep 60', waitMs: 250, hardTimeoutMs: 120_000 }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      jobId: 'shelljob-1',
      status: 'running',
      commandFinished: false,
      outcome: 'running',
      nextAction: 'wait_again',
    });
    expect(sandbox.startManagedShellJob).toHaveBeenCalledWith(
      session,
      'sleep 60',
      expect.objectContaining({ waitBudgetMs: 250, hardTimeoutMs: 120_000, turnNumber: 4 }),
    );
    expect(sandbox.exec).not.toHaveBeenCalled();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not force sandbox HTTP proxy env into shell jobs unless explicitly enabled', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        httpProxy: {
          enabled: true,
          url: 'http://127.0.0.1:8080',
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command: 'ffuf -u https://example.com/FUZZ',
      })),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    await ShellRun.run({ command: 'ffuf -u https://example.com/FUZZ' }, ctx);

    expect(sandbox.startManagedShellJob).toHaveBeenCalledWith(
      session,
      'ffuf -u https://example.com/FUZZ',
      expect.any(Object),
    );
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('can opt shell jobs into the sandbox HTTP proxy env', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        httpProxy: {
          enabled: true,
          shellEnv: true,
          url: 'http://127.0.0.1:8080',
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command: 'curl https://example.com',
      })),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    await ShellRun.run({ command: 'curl https://example.com' }, ctx);

    expect(sandbox.startManagedShellJob.mock.calls[0]?.[1]).toContain("export HTTP_PROXY='http://127.0.0.1:8080'");
    expect(sandbox.startManagedShellJob.mock.calls[0]?.[1]).toContain("export NO_PROXY='127.0.0.1,localhost,::1'");
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('syncs referenced skill assets into the sandbox before starting a shell job', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'nullai-shell-'));
    try {
      await mkdir(join(workspaceDir, '.skills', 'broad-surface-scan', 'wordlists'), { recursive: true });
      await writeFile(
        join(workspaceDir, '.skills', 'broad-surface-scan', 'wordlists', 'raft-medium-directories.txt'),
        'admin\nlogin\n',
        'utf8',
      );

      const session = { id: 'session-1', turn: 0, workspaceDir } as any;
      const sandbox = {
        exec: vi.fn(),
        writeFile: vi.fn(async () => undefined),
        startManagedShellJob: vi.fn().mockResolvedValue(managedResult({
          command: 'ffuf -w /workspace/.skills/broad-surface-scan/wordlists/raft-medium-directories.txt',
        })),
        checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
        cancelManagedShellJob: vi.fn(),
      } as any;
      const ctx = makeContext({
        workspaceDir,
        sandbox,
        sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
      });

      const result = await ShellRun.run(
        { command: 'ffuf -w /workspace/.skills/broad-surface-scan/wordlists/raft-medium-directories.txt' },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(sandbox.writeFile).toHaveBeenCalledWith(
        session,
        '.skills/broad-surface-scan/wordlists/raft-medium-directories.txt',
        expect.any(Buffer),
      );
      expect(sandbox.startManagedShellJob).toHaveBeenCalled();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('records managed shell job state in session flags', async () => {
    vi.useFakeTimers();
    const session = { id: 'session-1', turn: 0, flags: {} } as any;
    const sessionStore = {
      get: vi.fn().mockReturnValue(session),
      setAsync: vi.fn(async (_id: string, updated: any) => Object.assign(session, updated)),
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command: 'nuclei -u https://api.example.com',
      })),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({ sandbox, sessionStore });

    await ShellRun.run({ command: 'nuclei -u https://api.example.com' }, ctx);

    expect(sessionStore.setAsync).toHaveBeenCalledWith('session-1', expect.any(Object), 'shell.job_state');
    expect(session.flags.shellJobs['shelljob-1']).toMatchObject({
      jobId: 'shelljob-1',
      command: 'nuclei -u https://api.example.com',
      status: 'running',
      outcome: 'running',
      commandFinished: false,
      scannerFingerprint: 'nuclei:https://api.example.com',
    });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('caps scanner managed job lifetime to the active phase scanner budget', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: { securityops: { activePhaseKey: 'validation' } },
    } as any;
    const sessionStore = {
      get: vi.fn().mockReturnValue(session),
      setAsync: vi.fn(async (_id: string, updated: any) => Object.assign(session, updated)),
    } as any;
    const command = 'nuclei -u https://api.example.com -jsonl -o /workspace/.artifacts/phases/validation/nuclei.jsonl';
    const startedAt = new Date().toISOString();
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn().mockResolvedValue(managedResult({ command, startedAt })),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({ sandbox, sessionStore });

    const result = await ShellRun.run({ command, hardTimeoutMs: 900_000 }, ctx);

    expect(result.ok).toBe(true);
    expect(sandbox.startManagedShellJob).toHaveBeenCalledWith(
      session,
      command,
      expect.objectContaining({ hardTimeoutMs: 180_000 }),
    );
    expect((result.data as any).scannerBudget).toMatchObject({
      scannerFamily: 'nuclei',
      phaseKey: 'validation',
      maxScannerWallSeconds: 180,
      budgetExceeded: false,
    });
    expect(session.flags.securityops.scannerBudget['shelljob-1']).toMatchObject({
      scannerFamily: 'nuclei',
      phaseKey: 'validation',
      maxScannerWallSeconds: 180,
    });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('fails scanner artifact commands early when output flags are not ingestable', async () => {
    const session = { id: 'session-1', turn: 0, flags: { securityops: { activePhaseKey: 'enumeration' } } } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn(),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run(
      { command: 'ffuf -u https://example.com/FUZZ -of html -o /workspace/.artifacts/phases/enumeration/ffuf.html' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      code: 'scanner_output_contract_invalid',
      scannerFamily: 'ffuf',
    });
    expect(ctx.guards.cmdGuard.validate).not.toHaveBeenCalled();
    expect(sandbox.startManagedShellJob).not.toHaveBeenCalled();
  });

  it('checks and cancels managed shell jobs through the same tool', async () => {
    const session = { id: 'session-1', turn: 0 } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        status: 'completed',
        exitCode: 0,
        commandFinished: true,
      })),
      cancelManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        status: 'cancelled',
        success: false,
        commandFinished: true,
        cancelled: true,
      })),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const checked = await ShellRun.run({ action: 'check', jobId: 'shelljob-1', waitMs: 5000 }, ctx);
    const cancelled = await ShellRun.run({ action: 'cancel', jobId: 'shelljob-1' }, ctx);

    expect(checked.ok).toBe(true);
    expect(checked.data).toMatchObject({
      outcome: 'completed_no_reportable_output',
      nextAction: 'read_output',
    });
    expect(sandbox.checkManagedShellJob).toHaveBeenCalledWith(session, 'shelljob-1', expect.objectContaining({
      waitBudgetMs: 5000,
    }));
    expect(cancelled.ok).toBe(false);
    expect(cancelled.data).toMatchObject({
      outcome: 'cancelled',
      nextAction: 'record_blocked',
    });
    expect(sandbox.cancelManagedShellJob).toHaveBeenCalledWith(session, 'shelljob-1', 'cancelled_by_agent');
  });

  it('waits for a managed shell job with a bounded timeout', async () => {
    const session = { id: 'session-1', turn: 0 } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        status: 'completed',
        exitCode: 0,
        commandFinished: true,
      })),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await WaitForShellJob.run({ jobId: 'shelljob-1', timeoutSec: 2 }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      jobId: 'shelljob-1',
      status: 'completed',
      waitTimedOut: false,
      outcome: 'completed_no_reportable_output',
      nextAction: 'read_output',
    });
    expect(sandbox.checkManagedShellJob).toHaveBeenCalledWith(session, 'shelljob-1', expect.objectContaining({
      waitBudgetMs: expect.any(Number),
    }));
    expect((sandbox.checkManagedShellJob.mock.calls[0][2] as { waitBudgetMs: number }).waitBudgetMs).toBeLessThanOrEqual(2000);
  });

  it('rejects unknown managed shell job waits without sleeping when the session tracks jobs', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        shellJobs: {
          'shelljob-known': {
            jobId: 'shelljob-known',
            command: 'ffuf -u https://example.com/FUZZ',
            status: 'running',
          },
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn(),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await WaitForShellJob.run({ jobId: 'shelljob-missing', timeoutSec: 60 }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      jobId: 'shelljob-missing',
      knownJobIds: ['shelljob-known'],
      failureKind: 'unknown_job_id',
    });
    expect(sandbox.checkManagedShellJob).not.toHaveBeenCalled();
  });

  it('suggests partial scanner ingestion before repeated waits', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: { securityops: { activePhaseKey: 'validation' } },
    } as any;
    const sessionStore = {
      get: vi.fn().mockReturnValue(session),
      setAsync: vi.fn(async (_id: string, updated: any) => Object.assign(session, updated)),
    } as any;
    const command = 'nuclei -u https://api.example.com -jsonl -o /workspace/.artifacts/phases/validation/nuclei.jsonl';
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command,
        status: 'running',
        commandFinished: false,
      })),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({ sandbox, sessionStore });

    const result = await WaitForShellJob.run({ jobId: 'shelljob-1', timeoutSec: 0.0001 }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      waitTimedOut: true,
      partialIngestion: {
        suggested: true,
        tool: 'ingest_scan_artifact',
        args: {
          parser: 'nuclei',
          artifactPath: '.artifacts/phases/validation/nuclei.jsonl',
          partial: true,
        },
      },
    });
    expect(session.flags.securityops.scannerBudget['shelljob-1']).toMatchObject({
      waitCount: 1,
      partialIngestionSuggestedAt: expect.any(String),
    });
  });

  it('reports missing scanner output artifacts instead of encouraging raw reads', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: { securityops: { activePhaseKey: 'enumeration' } },
    } as any;
    const command = 'ffuf -u https://example.com/FUZZ -of json -o /workspace/.artifacts/scans/ffuf/result.json';
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command,
        status: 'completed',
        exitCode: 0,
        commandFinished: true,
      })),
      cancelManagedShellJob: vi.fn(),
      statFile: vi.fn(async () => ({
        exists: false,
        isFile: false,
        sizeBytes: 0,
        mtimeMs: null,
      })),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await WaitForShellJob.run({ jobId: 'shelljob-1', timeoutSec: 1 }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      scannerFamily: 'ffuf',
      digestPath: '/workspace/scans/digest.md',
      rawReadPolicy: expect.stringContaining('Read /workspace/scans/digest.md'),
      artifactExists: false,
      recommendedNextAction: 'record_scan_blocked_or_retry_once_with_smaller_scope',
      scannerArtifacts: [
        expect.objectContaining({
          artifactPath: '.artifacts/scans/ffuf/result.json',
          exists: false,
          missingHint: expect.stringContaining('Do not file_read this path'),
        }),
      ],
    });
  });

  it('blocks new scanner starts when workspace storage is critically low', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: { securityops: { activePhaseKey: 'enumeration' } },
    } as any;
    const sandbox = {
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: '1024 99\n',
        stderr: '',
        bytesOut: 8,
        bytesErr: 0,
      })),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn(),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const trace = { write: vi.fn().mockResolvedValue(undefined) } as any;
    const ctx = makeContext({
      sandbox,
      trace,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run(
      { command: 'ffuf -u https://example.com/FUZZ -of json -o /workspace/.artifacts/scans/ffuf/result.json' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      code: 'workspace_storage_pressure',
      storagePreflight: {
        checked: true,
        ok: false,
        severity: 'critical',
        freeMb: 1,
        usedPercent: 99,
      },
      nextAction: 'ingest_digest_existing_artifacts_or_record_blocked_coverage',
    });
    expect(sandbox.startManagedShellJob).not.toHaveBeenCalled();
    expect(trace.write).toHaveBeenCalledWith(
      'session-1',
      expect.any(Number),
      expect.objectContaining({ event: 'scanner.storage_preflight_blocked' }),
    );
  });

  it('blocks new scanner starts when active scanner jobs already meet the run cap', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        securityops: { activePhaseKey: 'enumeration', maxActiveScannerJobs: 1 },
        shellJobs: {
          'shelljob-active': {
            jobId: 'shelljob-active',
            command: 'nuclei -u https://api.example.com -jsonl -o /workspace/.artifacts/scans/nuclei/api.jsonl',
            status: 'running',
            commandFinished: false,
          },
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: '999999 10\n',
        stderr: '',
        bytesOut: 10,
        bytesErr: 0,
      })),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn(),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const trace = { write: vi.fn().mockResolvedValue(undefined) } as any;
    const ctx = makeContext({
      sandbox,
      trace,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run(
      { command: 'ffuf -u https://other.example.com/FUZZ -of json -o /workspace/.artifacts/scans/ffuf/other.json' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      code: 'scanner_concurrency_pressure',
      activeScannerJobCount: 1,
      maxActiveScannerJobs: 1,
      activeJobIds: ['shelljob-active'],
      nextAction: 'wait_for_shell_job',
    });
    expect(sandbox.startManagedShellJob).not.toHaveBeenCalled();
    expect(trace.write).toHaveBeenCalledWith(
      'session-1',
      expect.any(Number),
      expect.objectContaining({ event: 'scanner.admission_blocked' }),
    );
  });

  it('classifies no-space scanner failures as storage pressure', async () => {
    const session = { id: 'session-1', turn: 0 } as any;
    const command = 'ffuf -u https://example.com/FUZZ -of json -o /workspace/.artifacts/scans/ffuf/result.json';
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command,
        status: 'failed',
        exitCode: 1,
        success: false,
        commandFinished: true,
        stderr: 'write /workspace/.artifacts/scans/ffuf/result.json: No space left on device',
      })),
      cancelManagedShellJob: vi.fn(),
      statFile: vi.fn(async () => ({ exists: false, isFile: false, sizeBytes: 0, mtimeMs: null })),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await WaitForShellJob.run({ jobId: 'shelljob-1', timeoutSec: 1 }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      failureKind: 'workspace_storage',
      nextAction: 'record_blocked',
      recommendedNextAction: 'record_scan_blocked_due_to_storage_pressure',
    });
  });

  it('emits scanner budget-exceeded telemetry when a scanner runs past its phase budget', async () => {
    const startedAt = new Date(Date.now() - 61_000).toISOString();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: { securityops: { activePhaseKey: 'reporting' } },
    } as any;
    const sessionStore = {
      get: vi.fn().mockReturnValue(session),
      setAsync: vi.fn(async (_id: string, updated: any) => Object.assign(session, updated)),
    } as any;
    const trace = { write: vi.fn().mockResolvedValue(undefined) } as any;
    const command = 'nuclei -u https://api.example.com -jsonl -o /workspace/.artifacts/report/nuclei.jsonl';
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command,
        status: 'running',
        startedAt,
        commandFinished: false,
      })),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({ sandbox, sessionStore, trace });

    const result = await ShellRun.run({ action: 'check', jobId: 'shelljob-1' }, ctx);

    expect(result.ok).toBe(true);
    expect((result.data as any).scannerBudget).toMatchObject({
      scannerFamily: 'nuclei',
      phaseKey: 'reporting',
      maxScannerWallSeconds: 60,
      budgetExceeded: true,
    });
    expect(trace.write).toHaveBeenCalledWith(
      'session-1',
      expect.any(Number),
      expect.objectContaining({
        event: 'scanner.budget_exceeded',
        severity: 'warn',
      }),
    );
  });

  it('truncates large managed shell job output and points to the saved files', async () => {
    const session = { id: 'session-1', turn: 0 } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        status: 'completed',
        exitCode: 0,
        commandFinished: true,
        stdout: 'x'.repeat(6_000),
        stderr: 'y'.repeat(6_000),
        bytesOut: 6_000,
        bytesErr: 6_000,
      })),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      turnNumber: 4,
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await WaitForShellJob.run({ jobId: 'shelljob-1', timeoutSec: 2 }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: true,
      bytesOut: 6000,
      bytesErr: 6000,
    });
    expect((result.data as any).stdout.length).toBeLessThanOrEqual(4096);
    expect((result.data as any).stderr.length).toBeLessThanOrEqual(4096);
    expect((result.data as any).stdout).toContain('.artifacts/shell-jobs/shelljob-1/stdout.log');
    expect((result.data as any).stderr).toContain('.artifacts/shell-jobs/shelljob-1/stderr.log');
  });

  it('classifies obvious scanner config failures instead of returning wait_again', async () => {
    vi.useFakeTimers();
    const session = { id: 'session-1', turn: 0, flags: {} } as any;
    const sessionStore = {
      get: vi.fn().mockReturnValue(session),
      setAsync: vi.fn(async (_id: string, updated: any) => Object.assign(session, updated)),
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command: 'nuclei -l /workspace/.artifacts/targets.txt -t exposures/',
        stdout: "[ERR] Could not find template 'exposures/': could not find template file: no such path found: exposures/",
      })),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({ sandbox, sessionStore });

    const result = await ShellRun.run({ command: 'nuclei -l /workspace/.artifacts/targets.txt -t exposures/' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      outcome: 'failed',
      nextAction: 'retry_once',
      fatalConfigError: true,
      failureKind: 'scanner_config',
      scannerFamily: 'nuclei',
    });
    expect((result.data as any).failureReason).toContain('Could not find template');
    expect(session.flags.shellJobs['shelljob-1']).toMatchObject({
      fatalConfigError: true,
      failureKind: 'scanner_config',
      outcome: 'failed',
    });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('requires a job id for managed shell job checks', async () => {
    const session = { id: 'session-1', turn: 0 } as any;
    const ctx = makeContext({
      sandbox: {
        exec: vi.fn(),
        startManagedShellJob: vi.fn(),
        checkManagedShellJob: vi.fn(),
        cancelManagedShellJob: vi.fn(),
      } as any,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run({ action: 'check' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ success: false, error: 'jobId is required for shell job check/cancel' });
  });

  it('rejects unknown managed shell job checks when the session tracks other jobs', async () => {
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        shellJobs: {
          'shelljob-known': {
            jobId: 'shelljob-known',
            command: 'katana -u https://example.com',
            status: 'running',
          },
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn(),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run({ action: 'check', jobId: 'shelljob-missing' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      jobId: 'shelljob-missing',
      knownJobIds: ['shelljob-known'],
      failureKind: 'unknown_job_id',
      nextAction: 'record_blocked',
    });
    expect(sandbox.checkManagedShellJob).not.toHaveBeenCalled();
  });

  it('reuses an active scanner job instead of starting a duplicate command', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        shellJobs: {
          'shelljob-existing': {
            jobId: 'shelljob-existing',
            command: 'nuclei -u https://api.example.com',
            status: 'running',
            commandFinished: false,
            success: true,
            stdoutPath: '.artifacts/shell-jobs/shelljob-existing/stdout.log',
            stderrPath: '.artifacts/shell-jobs/shelljob-existing/stderr.log',
            statusPath: '.artifacts/shell-jobs/shelljob-existing/status.json',
            pidPath: '.artifacts/shell-jobs/shelljob-existing/pid',
            scannerFingerprint: 'nuclei:https://api.example.com',
            startedAt: '2026-04-18T00:00:00.000Z',
            bytesOut: 0,
            bytesErr: 0,
          },
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn(),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult({ jobId: 'shelljob-existing' })),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session), setAsync: vi.fn() } as any,
    });

    const result = await ShellRun.run({ command: 'nuclei -u https://api.example.com' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      jobId: 'shelljob-existing',
      reusedExistingJob: true,
      outcome: 'running',
      nextAction: 'wait_again',
    });
    expect(sandbox.startManagedShellJob).not.toHaveBeenCalled();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not reuse an active scanner job already marked as config-bad', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        shellJobs: {
          'shelljob-existing': {
            jobId: 'shelljob-existing',
            command: 'nuclei -u https://api.example.com -t exposures/',
            status: 'running',
            outcome: 'failed',
            fatalConfigError: true,
            commandFinished: false,
            success: true,
            stdoutPath: '.artifacts/shell-jobs/shelljob-existing/stdout.log',
            stderrPath: '.artifacts/shell-jobs/shelljob-existing/stderr.log',
            statusPath: '.artifacts/shell-jobs/shelljob-existing/status.json',
            pidPath: '.artifacts/shell-jobs/shelljob-existing/pid',
            scannerFingerprint: 'nuclei:https://api.example.com',
            startedAt: '2026-04-18T00:00:00.000Z',
            bytesOut: 0,
            bytesErr: 0,
          },
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(),
      startManagedShellJob: vi.fn().mockResolvedValue(managedResult({
        command: 'nuclei -u https://api.example.com',
      })),
      checkManagedShellJob: vi.fn().mockResolvedValue(managedResult()),
      cancelManagedShellJob: vi.fn(),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session), setAsync: vi.fn() } as any,
    });

    const result = await ShellRun.run({ command: 'nuclei -u https://api.example.com' }, ctx);

    expect(result.ok).toBe(true);
    expect((result.data as any).reusedExistingJob).toBe(false);
    expect(sandbox.startManagedShellJob).toHaveBeenCalled();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('falls back to legacy exec when managed jobs are unsupported by the runtime', async () => {
    const session = { id: 'session-1', turn: 0 } as any;
    const sandbox = {
      startManagedShellJob: vi.fn().mockRejectedValue(new Error('managed_shell_jobs_not_supported_on_remote_runner')),
      checkManagedShellJob: vi.fn(),
      cancelManagedShellJob: vi.fn(),
      exec: vi.fn().mockResolvedValue({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        artifacts: [],
      }),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await ShellRun.run({ command: 'echo ok' }, ctx);

    expect(result.ok).toBe(true);
    expect(sandbox.startManagedShellJob).toHaveBeenCalled();
    expect(sandbox.exec).toHaveBeenCalled();
  });
});
