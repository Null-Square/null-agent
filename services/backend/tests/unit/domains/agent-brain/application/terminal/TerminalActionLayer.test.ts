import { describe, expect, it, vi } from 'vitest';
import { applyTerminal, checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';

const makeContext = (session: any) => ({
  sessionId: session.id,
  sessionStore: {
    get: vi.fn(() => session),
    recordSessionCompletedAsync: vi.fn(async () => true),
    setAsync: vi.fn(async (_id: string, updated: unknown) => Object.assign(session, updated)),
  },
}) as any;

describe('TerminalActionLayer', () => {
  it('marks terminal actions complete and idempotent without new state columns', async () => {
    const session: any = {
      id: 'worker-1',
      turn: 3,
      flags: {},
      coordination: {
        role: 'worker',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
      },
      stateMachine: {
        stopProcessing: vi.fn(),
      },
    };
    const artifact = {
      taskId: 'task-1',
      workerType: 'recon_worker',
      summary: 'partial result',
      findings: [],
      evidenceRefs: [],
      touchedTargets: [],
    };

    const applied = await applyTerminal(session, makeContext(session), 'worker_result_submitted', artifact);

    expect(applied.alreadyTerminal).toBe(false);
    expect(session.completed).toBe(true);
    expect(session.workerResult).toEqual(artifact);
    expect(session.flags.session.completed).toBe(true);
    expect(session.stateMachine.stopProcessing).toHaveBeenCalledWith(
      'worker_result_submitted',
      3,
      'TerminalActionLayer',
    );
    expect(checkSessionTerminal(session)).toEqual(
      expect.objectContaining({
        isTerminal: true,
        kind: 'worker_result_submitted',
        existingResult: artifact,
      }),
    );
  });

  it('destroys a worker sandbox after worker_result_submitted', async () => {
    const session: any = {
      id: 'worker-cleanup-1',
      turn: 2,
      flags: {},
      coordination: {
        role: 'worker',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
      },
      stateMachine: { stopProcessing: vi.fn() },
    };
    const destroySandbox = vi.fn(async () => undefined);
    const traceWrite = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      ...makeContext(session),
      turnNumber: 2,
      sandbox: { destroySandbox },
      trace: { write: traceWrite },
    } as any;
    const artifact = {
      taskId: 'task-1',
      workerType: 'recon_worker',
      summary: 'done',
      findings: [],
      evidenceRefs: [],
      touchedTargets: [],
    };

    await expect(applyTerminal(session, ctx, 'worker_result_submitted', artifact))
      .resolves.toEqual({ alreadyTerminal: false });

    expect(session.completed).toBe(true);
    expect(destroySandbox).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker-cleanup-1' }));
    expect(traceWrite).toHaveBeenCalledWith(
      'worker-cleanup-1',
      2,
      expect.objectContaining({
        event: 'session.cleanup.completed',
        payload: expect.objectContaining({
          terminalState: 'worker_result_submitted',
          sandboxDestroyed: true,
        }),
      }),
    );
  });

  it('keeps worker_result_submitted terminal when worker sandbox cleanup fails', async () => {
    const session: any = {
      id: 'worker-cleanup-fails',
      turn: 2,
      flags: {},
      coordination: {
        role: 'worker',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
      },
      stateMachine: { stopProcessing: vi.fn() },
    };
    const destroySandbox = vi.fn(async () => {
      throw new Error('docker unavailable');
    });
    const traceWrite = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      ...makeContext(session),
      turnNumber: 2,
      sandbox: { destroySandbox },
      trace: { write: traceWrite },
    } as any;
    const artifact = {
      taskId: 'task-1',
      workerType: 'recon_worker',
      summary: 'done',
      findings: [],
      evidenceRefs: [],
      touchedTargets: [],
    };

    await expect(applyTerminal(session, ctx, 'worker_result_submitted', artifact))
      .resolves.toEqual({ alreadyTerminal: false });

    expect(session.completed).toBe(true);
    expect(checkSessionTerminal(session).kind).toBe('worker_result_submitted');
    expect(traceWrite).toHaveBeenCalledWith(
      'worker-cleanup-fails',
      2,
      expect.objectContaining({
        event: 'session.cleanup.failed',
        severity: 'warn',
        payload: expect.objectContaining({
          terminalState: 'worker_result_submitted',
          reason: 'sandbox_destroy_failed',
        }),
      }),
    );
  });

  it('does not treat reporting phase handoff as session-terminal before finalization', () => {
    const session: any = {
      id: 'reporting-1',
      flags: {
        securityops: {
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: true,
          phaseHandoffRef: '.artifacts/phase-handoffs/reporting.json',
          phaseHandoffStatus: 'completed',
        },
      },
    };

    expect(checkSessionTerminal(session).isTerminal).toBe(false);
  });

  it('marks all cached run sessions complete and destroys sandboxes before deferred workspace cleanup', async () => {
    const reportingSession: any = {
      id: 'reporting-1',
      turn: 6,
      completed: false,
      flags: {
        securityops: {
          runId: 'run-1',
          artifactsFinalizedAt: '2026-05-30T10:00:00.000Z',
          runCompletion: { state: 'completed' },
        },
      },
      stateMachine: { stopProcessing: vi.fn() },
    };
    const workerSession: any = {
      id: 'worker-1',
      turn: 2,
      completed: false,
      flags: { securityops: { runId: 'run-1' } },
      stateMachine: { stopProcessing: vi.fn() },
    };
    const setAsync = vi.fn(async (_id: string, updated: any) => {
      const target = updated.id === workerSession.id ? workerSession : reportingSession;
      Object.assign(target, updated);
    });
    const destroySandbox = vi.fn(async (session: any) => {
      expect(session.completed).toBe(true);
      expect(session.flags.session.completed).toBe(true);
    });
    const cleanupRunWorkspaceAsync = vi.fn(async () => ({
      cleaned: true,
      workspaceDirs: ['/tmp/ns-run-run-1'],
      activeSessionIds: [],
      errors: 0,
    }));
    const traceWrite = vi.fn().mockResolvedValue(undefined);
    const ctx: any = {
      sessionId: reportingSession.id,
      turnNumber: 6,
      sessionStore: {
        get: vi.fn((id: string) => (id === reportingSession.id ? reportingSession : workerSession)),
        listByRunId: vi.fn(() => [reportingSession, workerSession]),
        recordSessionCompletedAsync: vi.fn(async () => true),
        setAsync,
        cleanupRunWorkspaceAsync,
      },
      sandbox: { destroySandbox },
      trace: { write: traceWrite },
    };

    await applyTerminal(reportingSession, ctx, 'run_finalized', {
      mode: 'final',
      runCompletion: { state: 'completed' },
    });

    expect(workerSession.completed).toBe(true);
    expect(workerSession.stateMachine.stopProcessing).toHaveBeenCalledWith(
      'run_finalized.cleanup',
      2,
      'TerminalActionLayer',
    );
    expect(destroySandbox).toHaveBeenCalledTimes(2);
    expect(destroySandbox.mock.calls.map(([session]) => session.id)).toEqual(['reporting-1', 'worker-1']);
    expect(cleanupRunWorkspaceAsync).not.toHaveBeenCalled();
    expect(traceWrite).toHaveBeenCalledWith(
      'reporting-1',
      6,
      expect.objectContaining({
        event: 'session.terminal_applied',
        payload: expect.objectContaining({ terminalState: 'run_finalized' }),
      }),
    );
    expect(traceWrite).toHaveBeenCalledWith(
      'reporting-1',
      6,
      expect.objectContaining({
        event: 'session.cleanup.started',
        payload: expect.objectContaining({ reason: 'run_finalized' }),
      }),
    );
    expect(traceWrite).toHaveBeenCalledWith(
      'reporting-1',
      6,
      expect.objectContaining({
        event: 'session.cleanup.completed',
        payload: expect.objectContaining({
          sandboxDestroyed: true,
          workspaceCleaned: false,
        }),
      }),
    );
  });

  it('does not publish terminal state in memory when the durable fact is unavailable', async () => {
    const session: any = {
      id: 'worker-durable-failure',
      turn: 1,
      flags: {},
      coordination: {
        role: 'worker',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
      },
      stateMachine: { stopProcessing: vi.fn() },
    };
    const ctx = makeContext(session);
    ctx.sessionStore.recordSessionCompletedAsync.mockResolvedValue(false);

    await expect(applyTerminal(session, ctx, 'worker_result_submitted', {
      taskId: 'task-1',
      workerType: 'recon_worker',
      summary: 'done',
      findings: [],
      evidenceRefs: [],
      touchedTargets: [],
    })).rejects.toThrow('durable_terminal_completion_failed');

    expect(session.completed).not.toBe(true);
    expect(session.flags.session).toBeUndefined();
    expect(session.stateMachine.stopProcessing).not.toHaveBeenCalled();
    expect(ctx.sessionStore.setAsync).not.toHaveBeenCalled();
  });
});
