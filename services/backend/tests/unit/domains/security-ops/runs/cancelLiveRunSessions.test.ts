import { describe, expect, it, vi } from 'vitest';
import { abortLiveRunSessions } from '@/domains/security-ops/runs/cancelLiveRunSessions';

describe('abortLiveRunSessions', () => {
  it('stops live sessions before cleaning the shared run workspace', async () => {
    const session = {
      id: 'session-1',
      turn: 3,
      blockedReason: undefined,
      blockedMeta: undefined,
      stateMachine: { getState: vi.fn(() => 'processing'), stopProcessing: vi.fn() },
    };
    const order: string[] = [];
    const services: any = {
      sessionStore: {
        abortCurrentTurnAsync: vi.fn(async () => {
          order.push('abort');
        }),
        waitForCurrentTurnToSettleAsync: vi.fn(async () => {
          order.push('settled');
          return true;
        }),
        getOrHydrate: vi.fn(async () => session),
        recordStopRequestedAsync: vi.fn(async () => undefined),
        setAsync: vi.fn(async () => {
          order.push('set');
        }),
        cleanupRunWorkspaceAsync: vi.fn(async () => {
          order.push('cleanup');
          return {
            cleaned: true,
            workspaceDirs: ['/tmp/ns-run-run-1'],
            activeSessionIds: [],
            errors: 0,
          };
        }),
      },
      agentEngine: {
        stopSandbox: vi.fn(async () => {
          order.push('stopSandbox');
        }),
      },
    };
    const sessionRepository = {
      listIdsByRunId: vi.fn(async () => ['session-1']),
      setBlockedReason: vi.fn(async () => true),
    };

    await abortLiveRunSessions({
      runId: 'run-1',
      services,
      sessionRepository,
      caller: 'test',
      publishSignal: false,
    });

    expect(services.agentEngine.stopSandbox).toHaveBeenCalledWith(session, 'run_cancelled_by_operator');
    expect(services.sessionStore.recordStopRequestedAsync).toHaveBeenCalledWith(
      'session-1',
      'run_cancelled_by_operator',
      'test',
    );
    expect(session.stateMachine.stopProcessing).toHaveBeenCalledWith('aborted_by_user', 3, 'test');
    expect(services.sessionStore.cleanupRunWorkspaceAsync).toHaveBeenCalledWith('run-1', {
      reason: 'run_cancelled_by_operator',
      force: true,
    });
    expect(order).toEqual(['abort', 'set', 'stopSandbox', 'settled', 'cleanup']);
  });

  it('treats a replayed cancellation for an idle session as an idempotent stop', async () => {
    const stopProcessing = vi.fn();
    const session = {
      id: 'session-idle',
      turn: 4,
      stateMachine: { getState: vi.fn(() => 'idle'), stopProcessing },
    };
    const services: any = {
      sessionStore: {
        abortCurrentTurnAsync: vi.fn(async () => undefined),
        getOrHydrate: vi.fn(async () => session),
        setAsync: vi.fn(async () => undefined),
        waitForCurrentTurnToSettleAsync: vi.fn(async () => true),
        cleanupRunWorkspaceAsync: vi.fn(async () => undefined),
      },
      agentEngine: { stopSandbox: vi.fn(async () => undefined) },
    };

    await abortLiveRunSessions({
      runId: 'run-cancelled',
      services,
      sessionRepository: {
        listIdsByRunId: vi.fn(async () => ['session-idle']),
        setBlockedReason: vi.fn(async () => true),
      },
      caller: 'run_control_signal',
      publishSignal: false,
    });

    expect(stopProcessing).not.toHaveBeenCalled();
    expect(services.sessionStore.setAsync).toHaveBeenCalled();
    expect(session).toMatchObject({ blockedReason: 'aborted_by_user' });
  });

  it('does not append a second Stop fact when a cancellation signal replays', async () => {
    const recordStopRequestedAsync = vi.fn(async () => true);
    const session = {
      id: 'session-stopped',
      turn: 4,
      stateMachine: { getState: vi.fn(() => 'idle'), stopProcessing: vi.fn() },
    };
    const services: any = {
      sessionStore: {
        abortCurrentTurnAsync: vi.fn(async () => undefined),
        getOrHydrate: vi.fn(async () => session),
        getJournalProjection: vi.fn(async () => ({
          desiredExecution: 'stopped',
          condition: 'idle',
        })),
        recordStopRequestedAsync,
        setAsync: vi.fn(async () => undefined),
        waitForCurrentTurnToSettleAsync: vi.fn(async () => true),
        cleanupRunWorkspaceAsync: vi.fn(async () => undefined),
      },
      agentEngine: { stopSandbox: vi.fn(async () => undefined) },
    };

    await abortLiveRunSessions({
      runId: 'run-cancelled',
      services,
      sessionRepository: {
        listIdsByRunId: vi.fn(async () => ['session-stopped']),
        setBlockedReason: vi.fn(async () => true),
      },
      caller: 'run_control_signal',
      publishSignal: false,
    });

    expect(recordStopRequestedAsync).not.toHaveBeenCalled();
  });

  it('does not clean the workspace when an active provider turn cannot settle', async () => {
    const services: any = {
      sessionStore: {
        abortCurrentTurnAsync: vi.fn(async () => undefined),
        getOrHydrate: vi.fn(async () => ({
          id: 'session-1',
          turn: 1,
          stateMachine: { getState: vi.fn(() => 'processing'), stopProcessing: vi.fn() },
        })),
        setAsync: vi.fn(async () => undefined),
        waitForCurrentTurnToSettleAsync: vi.fn(async () => false),
        cleanupRunWorkspaceAsync: vi.fn(async () => undefined),
      },
      agentEngine: { stopSandbox: vi.fn(async () => undefined) },
    };
    const sessionRepository = {
      listIdsByRunId: vi.fn(async () => ['session-1']),
      setBlockedReason: vi.fn(async () => true),
    };

    await expect(abortLiveRunSessions({
      runId: 'run-1',
      services,
      sessionRepository,
      caller: 'test',
      publishSignal: false,
    })).rejects.toThrow('run_sessions_did_not_settle');
    expect(services.sessionStore.cleanupRunWorkspaceAsync).not.toHaveBeenCalled();
  });
});
