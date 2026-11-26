import { describe, expect, it, vi } from 'vitest';

import { SystemRecoveryWorker } from '@/domains/security-ops/runs/SystemRecoveryWorker';

const dueSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  mode: 'automated',
  completed: false,
  blockedReason: 'guard_retry:pending_steps',
  metadata: {},
  nextAttemptAt: new Date('2026-08-15T10:00:00.000Z'),
  ...overrides,
});

const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  organizationId: 'org-1',
  status: 'running',
  executionTarget: 'local',
  admissionEpoch: 0,
  ...overrides,
});

const databaseReturning = (...rows: unknown[][]) => {
  let index = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows[index++] ?? []),
        })),
      })),
    })),
  };
};

const buildHarness = (options: {
  session?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
  capacity?: 'owned' | 'not_required' | 'missing' | 'wrong_host' | 'runner_unavailable';
  closeout?: 'completed' | 'retry';
  interruptedTurn?: boolean;
  journal?: {
    desiredExecution: 'running' | 'stopped';
    continuation:
      | 'none'
      | 'wait_for_approval'
      | 'execute_approved_tool'
      | 'start_pending_input'
      | 'continue_turn'
      | 'restart_turn';
    issues?: Array<{ detail: string }>;
    pendingCloseout?: boolean;
    pendingStart?: boolean;
    pendingInputMessage?: {
      id: string;
      metadata?: Record<string, unknown>;
    };
    pendingToolRequest?: {
      turnId: string;
      toolCallId: string;
      toolName: string;
      modelRequestId?: string;
      arguments?: string;
      requestedSequence: number;
    };
  };
} = {}) => {
  let offered = false;
  const session = options.session === null ? null : dueSession(options.session);
  const journal: NonNullable<typeof options.journal> = options.journal ?? {
    desiredExecution: 'running' as const,
    continuation: 'continue_turn' as const,
  };
  const sessions = {
    claimDueRecovery: vi.fn(async () => {
      if (offered || !session) return null;
      offered = true;
      return { session, interruptedTurn: options.interruptedTurn ?? false };
    }),
    renewExecutionClaim: vi.fn(async () => true),
    releaseExecutionClaim: vi.fn(async () => true),
    acknowledgeClaimedContinuation: vi.fn(async () => true),
    deferClaimedContinuation: vi.fn(async () => true),
    beginClaimedContinuation: vi.fn(async () => true),
  };
  const run = options.run === null ? null : options.run ? runRow(options.run) : null;
  const db = databaseReturning(run ? [run] : []);
  const runService = {
    onSessionStatusChange: vi.fn(async (_sessionId: string, _status: string) => undefined),
    transitionStatusIfCurrent: vi.fn(async () => run),
    authorizeRecoveryExecution: vi.fn(async (_params: {
      orgId: string;
      runId: string;
      allowedStatuses: string[];
    }) => run),
    recordRunEvent: vi.fn(async () => undefined),
  };
  const orchestrator = {
    processClaimedMessage: vi.fn(async () => undefined),
    handleClaimedApprovalResume: vi.fn(async () => undefined),
    recoverClaimedCloseout: vi.fn(async () => options.closeout ?? 'completed'),
  };
  const leases = {
    ensurePlatformCloudRunner: vi.fn(async () => undefined),
    verifyLocalRecoveryOwnership: vi.fn(async () => options.capacity ?? 'owned'),
  };
  const sessionStore = {
    get: vi.fn(() => undefined),
    getOrHydrate: vi.fn(async () => undefined),
    setAsync: vi.fn(async () => undefined),
    ensureJournalForRecoveryAsync: vi.fn(async () => undefined),
    applyJournalProjectionAsync: vi.fn(async () => undefined),
    recordExecutionDeferredAsync: vi.fn(async () => undefined),
  };
  const replans = { claimDue: vi.fn(async () => null) };
  const reconcile = vi.fn(async () => ({
    fold: {
      desiredExecution: journal.desiredExecution,
      issues: journal.issues ?? [],
      ...(journal.pendingStart ? { pendingStartSequence: 3 } : {}),
      ...(journal.pendingCloseout
        ? { pendingCloseout: { reason: 'closeout pending', requestedSequence: 2 } }
        : {}),
      pendingInputMessageIds: journal.pendingInputMessage ? [journal.pendingInputMessage.id] : [],
      messages: journal.pendingInputMessage ? [journal.pendingInputMessage] : [],
      pendingToolRequests: journal.pendingToolRequest ? [journal.pendingToolRequest] : [],
    },
    continuation: journal.continuation === 'wait_for_approval'
      ? { kind: 'wait_for_approval', actionId: 'approval-1' }
      : journal.continuation === 'execute_approved_tool'
        ? { kind: 'execute_approved_tool', actionId: 'approval-1', toolCallId: 'call-1' }
      : journal.continuation === 'start_pending_input'
        ? { kind: 'start_pending_input', messageIds: ['user-1'] }
      : journal.continuation === 'continue_turn'
        ? { kind: 'continue_turn', turnId: 'turn-1' }
        : journal.continuation === 'restart_turn'
          ? { kind: 'restart_turn', turnId: 'turn-1' }
          : { kind: 'none' },
    repairedEventCount: 0,
    repairedToolExecutionCount: 0,
    repairedProviderAttemptCount: 0,
  }));
  const worker = new SystemRecoveryWorker({
    db: db as never,
    sessions: sessions as never,
    replans: replans as never,
    runService: runService as never,
    startRunService: { dispatchClaimedPhaseReplan: vi.fn() } as never,
    leases: leases as never,
    config: { queueCloudRuns: true } as never,
    agentServices: {
      sessionStore,
      orchestrator,
    } as never,
    journalRecovery: { reconcile } as never,
    workerId: 'test-worker',
    now: () => new Date('2026-08-15T10:00:01.000Z'),
    random: () => 0.5,
  });
  return { worker, sessions, runService, orchestrator, leases, sessionStore, reconcile };
};

const buildReplanHarness = (options: {
  runStatus?: string;
  dispatchAttempts?: number;
  dispatchError?: Error;
} = {}) => {
  const run = runRow({ status: options.runStatus ?? 'running' });
  const phase = { id: 'phase-1', runId: 'run-1', phaseKey: 'enumeration', status: 'completed' };
  const replan = {
    id: 'replan-1',
    runId: 'run-1',
    phaseId: 'phase-1',
    status: 'open',
    dispatchAttempts: options.dispatchAttempts ?? 1,
  };
  let offered = false;
  const replans = {
    claimDue: vi.fn(async () => {
      if (offered) return null;
      offered = true;
      return replan;
    }),
    findOpen: vi.fn(async () => null),
    renewClaim: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => true),
    failClaimed: vi.fn(async () => true),
    scheduleClaimedRetry: vi.fn(async () => true),
    deferClaimWithoutAttempt: vi.fn(async () => true),
  };
  const runService = {
    authorizeRecoveryExecution: vi.fn(async () => run),
    transitionStatusIfCurrent: vi.fn(async () => run),
    recordRunEvent: vi.fn(async () => undefined),
    onSessionStatusChange: vi.fn(async () => undefined),
  };
  const dispatchClaimedPhaseReplan = options.dispatchError
    ? vi.fn(async () => { throw options.dispatchError; })
    : vi.fn(async () => undefined);
  const worker = new SystemRecoveryWorker({
    db: databaseReturning([run], [phase], [run]) as never,
    sessions: { claimDueRecovery: vi.fn(async () => null) } as never,
    replans: replans as never,
    runService: runService as never,
    startRunService: { dispatchClaimedPhaseReplan } as never,
    leases: {
      ensurePlatformCloudRunner: vi.fn(async () => undefined),
      verifyLocalRecoveryOwnership: vi.fn(async () => 'owned'),
    } as never,
    config: { queueCloudRuns: true } as never,
    agentServices: {} as never,
    journalRecovery: { reconcile: vi.fn() } as never,
    workerId: 'replan-worker',
    now: () => new Date('2026-08-15T10:00:01.000Z'),
    random: () => 0.5,
  });
  return { worker, run, phase, replan, replans, runService, dispatchClaimedPhaseReplan };
};

describe('SystemRecoveryWorker', () => {
  it('acknowledges durable Stop intent without interpreting legacy recovery action', async () => {
    const harness = buildHarness({
      session: { blockedReason: 'user_paused' },
      journal: { desiredExecution: 'stopped', continuation: 'restart_turn' },
      interruptedTurn: true,
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.sessions.acknowledgeClaimedContinuation).toHaveBeenCalledTimes(1);
    expect(harness.sessions.beginClaimedContinuation).not.toHaveBeenCalled();
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
  });

  it('acknowledges a stale due projection when the journal has no unfinished work', async () => {
    const harness = buildHarness({
      session: {},
      journal: { desiredExecution: 'running', continuation: 'none' },
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.sessions.beginClaimedContinuation).not.toHaveBeenCalled();
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
    expect(harness.sessions.acknowledgeClaimedContinuation).toHaveBeenCalledTimes(1);
  });

  it('continues journal work with only the lease and never creates a synthetic system pause', async () => {
    const harness = buildHarness({
      session: {},
      journal: { desiredExecution: 'running', continuation: 'continue_turn' },
      interruptedTurn: true,
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.sessions.beginClaimedContinuation).toHaveBeenCalledTimes(1);
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledTimes(1);
    expect(harness.sessions.acknowledgeClaimedContinuation).toHaveBeenCalledTimes(1);
    expect(harness.runService.onSessionStatusChange).not.toHaveBeenCalledWith('session-1', 'system_paused');
  });

  it('replays durable per-turn profile and context overrides after a restart', async () => {
    const harness = buildHarness({
      session: {},
      journal: {
        desiredExecution: 'running',
        continuation: 'start_pending_input',
        pendingInputMessage: {
          id: 'user-1',
          metadata: {
            visibility: 'public',
            source: 'human',
            turnExecution: {
              profileKey: 'security-assistant',
              extraContext: 'One-turn operator context',
            },
          },
        },
      },
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      '',
      'security-assistant',
      'One-turn operator context',
      expect.objectContaining({ source: 'human' }),
    );
  });

  it('executes a durably granted tool under the recovery lease exactly once', async () => {
    const harness = buildHarness({
      session: {},
      journal: {
        desiredExecution: 'running',
        continuation: 'execute_approved_tool',
        pendingToolRequest: {
          turnId: 'turn-1',
          toolCallId: 'call-1',
          toolName: 'shell',
          modelRequestId: 'request-1',
          arguments: '{"command":"pwd"}',
          requestedSequence: 4,
        },
      },
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.orchestrator.handleClaimedApprovalResume).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      {
        actionId: 'approval-1',
        toolCallId: 'call-1',
        modelRequestId: 'request-1',
        toolName: 'shell',
        args: { command: 'pwd' },
      },
    );
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
    expect(harness.sessions.acknowledgeClaimedContinuation).toHaveBeenCalledOnce();
  });

  it('records another durable due event instead of terminalizing a failed continuation attempt', async () => {
    const harness = buildHarness({
      session: {},
      journal: { desiredExecution: 'running', continuation: 'continue_turn' },
    });
    harness.orchestrator.processClaimedMessage.mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await harness.worker.tick();

    expect(result.sessionsDeferred).toBe(1);
    expect(harness.sessionStore.recordExecutionDeferredAsync).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('provider unavailable'),
      new Date('2026-08-15T10:00:31.000Z'),
      expect.stringContaining('continuation:'),
      expect.any(String),
    );
    expect(harness.sessions.deferClaimedContinuation).not.toHaveBeenCalled();
  });

  it('executes one claimed recovery once across concurrent workers', async () => {
    const harness = buildHarness();
    const second = new SystemRecoveryWorker({
      ...(harness.worker as any).deps,
      workerId: 'second-worker',
    });

    await Promise.all([harness.worker.tick(), second.tick()]);

    expect(harness.sessions.claimDueRecovery).toHaveBeenCalled();
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledTimes(1);
    expect(harness.sessions.acknowledgeClaimedContinuation).toHaveBeenCalledTimes(1);
  });

  it('drains independent session recoveries with a small concurrency limit', async () => {
    const harness = buildHarness();
    let offered = 0;
    let active = 0;
    let maxActive = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    harness.sessions.claimDueRecovery.mockImplementation(async () => {
      if (offered >= 5) return null;
      offered += 1;
      return {
        session: dueSession({ id: `session-${offered}` }),
        interruptedTurn: false,
      };
    });
    harness.orchestrator.processClaimedMessage.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
    });

    const tick = harness.worker.tick();
    await vi.waitFor(() => {
      expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledTimes(3);
    });
    releaseGate?.();
    const result = await tick;

    expect(result.sessionsRecovered).toBe(5);
    expect(maxActive).toBe(3);
  });

  it('keeps recovery pending while a run is still queued for admission', async () => {
    const harness = buildHarness({ run: { status: 'queued' } });

    const result = await harness.worker.tick();

    expect(result.sessionsDeferred).toBe(1);
    expect(harness.sessionStore.recordExecutionDeferredAsync).toHaveBeenCalledWith(
      'session-1',
      'run_queued',
      new Date('2026-08-15T10:00:31.000Z'),
      expect.stringContaining('continuation:'),
      expect.any(String),
    );
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
  });

  it('continues unfinished session history without reopening a terminal business run', async () => {
    const harness = buildHarness({ run: { status: 'failed' }, interruptedTurn: true });
    const live = {
      id: 'session-1',
      turn: 2,
      completed: false,
      blockedReason: 'system_paused' as string | undefined,
      flags: { securityops: { runId: 'run-1' } } as Record<string, unknown>,
      stateMachine: { stopProcessing: vi.fn() },
    };
    harness.sessionStore.getOrHydrate.mockResolvedValue(live as never);

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.sessions.acknowledgeClaimedContinuation).toHaveBeenCalledOnce();
    expect(live.completed).toBe(false);
    expect(live.blockedReason).toBeUndefined();
    expect(harness.sessionStore.setAsync).toHaveBeenCalled();
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
    );
    expect(harness.runService.authorizeRecoveryExecution).not.toHaveBeenCalled();
    expect(harness.leases.verifyLocalRecoveryOwnership).not.toHaveBeenCalled();
  });

  it('does not execute queued work when recording its durable deferral', async () => {
    const harness = buildHarness({ run: { status: 'queued' } });

    const result = await harness.worker.tick();

    expect(result.sessionsDeferred).toBe(1);
    expect(result.sessionsFailed).toBe(0);
    expect(harness.runService.onSessionStatusChange).not.toHaveBeenCalled();
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
  });

  it('defers without spending an attempt when the capacity lease belongs to another host', async () => {
    const harness = buildHarness({
      run: { executionTarget: 'cloud', admissionEpoch: 3 },
      capacity: 'wrong_host',
    });

    const result = await harness.worker.tick();

    expect(result.sessionsDeferred).toBe(1);
    expect(harness.sessionStore.recordExecutionDeferredAsync).toHaveBeenCalledWith(
      'session-1',
      'capacity:wrong_host',
      new Date('2026-08-15T10:00:16.000Z'),
      expect.stringContaining('continuation:'),
      expect.any(String),
    );
    expect(harness.runService.authorizeRecoveryExecution).not.toHaveBeenCalled();
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
  });

  it('keeps recovery queued while the run waits for a user prerequisite', async () => {
    const harness = buildHarness({ run: { status: 'user_paused' } });

    const result = await harness.worker.tick();

    expect(result.sessionsDeferred).toBe(1);
    expect(harness.sessionStore.recordExecutionDeferredAsync).toHaveBeenCalledWith(
      'session-1',
      'run_prerequisite:user_paused',
      new Date('2026-08-15T10:00:31.000Z'),
      expect.stringContaining('continuation:'),
      expect.any(String),
    );
    expect(harness.sessions.acknowledgeClaimedContinuation).not.toHaveBeenCalled();
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
  });

  it.each(['credits_exhausted', 'runner_unavailable'] as const)(
    'automatically rechecks the %s prerequisite without requiring Start',
    async (blockedReason) => {
      const harness = buildHarness({ run: { status: blockedReason } });
      const live = {
        id: 'session-1',
        blockedReason: blockedReason as string | undefined,
        blockedMeta: { reason: blockedReason } as Record<string, unknown> | undefined,
        flags: { [blockedReason]: true } as Record<string, unknown>,
      };
      harness.sessionStore.getOrHydrate.mockResolvedValue(live as never);

      const result = await harness.worker.tick();

      expect(result.sessionsRecovered).toBe(1);
      expect(harness.runService.authorizeRecoveryExecution).toHaveBeenCalledWith({
        orgId: 'org-1',
        runId: 'run-1',
        allowedStatuses: [blockedReason],
      });
      expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledOnce();
      expect(live.blockedReason).toBeUndefined();
      expect(live.blockedMeta).toBeUndefined();
      expect(live.flags).not.toHaveProperty(blockedReason);
    },
  );

  it('automatically retries a provider subscription prerequisite while the run remains running', async () => {
    const harness = buildHarness({ run: { status: 'running' } });
    const live = {
      id: 'session-1',
      blockedReason: 'provider_quota_exhausted' as string | undefined,
      blockedMeta: { reason: 'provider_quota_exhausted' } as Record<string, unknown> | undefined,
      flags: {} as Record<string, unknown>,
    };
    harness.sessionStore.getOrHydrate.mockResolvedValue(live as never);

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.runService.authorizeRecoveryExecution).toHaveBeenCalledWith({
      orgId: 'org-1',
      runId: 'run-1',
      allowedStatuses: ['running'],
    });
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledOnce();
    expect(live.blockedReason).toBeUndefined();
    expect(live.blockedMeta).toBeUndefined();
  });

  it('uses a durable Start fact to release the matching run prerequisite', async () => {
    const harness = buildHarness({
      run: { status: 'user_paused' },
      journal: {
        desiredExecution: 'running',
        continuation: 'restart_turn',
        pendingStart: true,
      },
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.runService.authorizeRecoveryExecution).toHaveBeenCalledWith({
      orgId: 'org-1',
      runId: 'run-1',
      allowedStatuses: ['user_paused'],
    });
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledOnce();
  });

  it('records provider failure as another durable journal retry', async () => {
    const harness = buildHarness();
    harness.orchestrator.processClaimedMessage.mockRejectedValue(new Error('dispatch failed'));

    const result = await harness.worker.tick();

    expect(result.sessionsDeferred).toBe(1);
    expect(harness.sessionStore.recordExecutionDeferredAsync).toHaveBeenCalledWith(
      'session-1',
      'continuation_error:dispatch failed',
      expect.any(Date),
      expect.stringContaining('continuation:'),
      expect.any(String),
    );
  });

  it('continues an expired turn lease directly from journal state', async () => {
    const harness = buildHarness({ run: {}, interruptedTurn: true });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.reconcile).toHaveBeenCalledWith('session-1', {
      executionInterrupted: true,
      interruptedAt: new Date('2026-08-15T10:00:01.000Z'),
    });
    expect(harness.sessions.beginClaimedContinuation).toHaveBeenCalledOnce();
    expect(harness.runService.onSessionStatusChange).not.toHaveBeenCalledWith('session-1', 'system_paused');
    expect(harness.runService.authorizeRecoveryExecution).toHaveBeenCalledWith({
      orgId: 'org-1',
      runId: 'run-1',
      allowedStatuses: ['running'],
    });
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledOnce();
  });

  it('recovers interrupted sibling sessions without mutating their shared run status', async () => {
    const harness = buildHarness({ run: {}, interruptedTurn: true });
    const run = runRow();
    let offered = 0;
    const runStatus = 'running';

    harness.sessions.claimDueRecovery.mockImplementation(async () => {
      if (offered >= 2) return null;
      offered += 1;
      return {
        session: dueSession({ id: `session-${offered}` }),
        interruptedTurn: true,
      };
    });
    (harness.worker as any).deps.db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ ...run, status: runStatus }]),
          })),
        })),
      })),
    };
    harness.runService.authorizeRecoveryExecution.mockImplementation(async ({ allowedStatuses }) => {
      if (!allowedStatuses.includes(runStatus)) return null;
      return { ...run, status: runStatus };
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(2);
    expect(result.sessionsFailed).toBe(0);
    expect(harness.orchestrator.processClaimedMessage).toHaveBeenCalledTimes(2);
    expect(harness.runService.onSessionStatusChange).not.toHaveBeenCalledWith(
      expect.any(String),
      'system_paused',
    );
    expect(runStatus).toBe('running');
  });

  it('reconciles closeout directly without model, tool, or capacity execution', async () => {
    const harness = buildHarness({
      session: { blockedReason: 'system_paused' },
      run: {},
      closeout: 'completed',
      journal: { desiredExecution: 'running', continuation: 'none', pendingCloseout: true },
    });

    const result = await harness.worker.tick();

    expect(result.sessionsRecovered).toBe(1);
    expect(harness.orchestrator.recoverClaimedCloseout).toHaveBeenCalledOnce();
    expect(harness.orchestrator.processClaimedMessage).not.toHaveBeenCalled();
    expect(harness.leases.verifyLocalRecoveryOwnership).not.toHaveBeenCalled();
  });

  it('dispatches a claimed phase replan through the same recovery worker', async () => {
    const run = runRow();
    const phase = { id: 'phase-1', runId: 'run-1', phaseKey: 'enumeration', status: 'completed' };
    const replan = {
      id: 'replan-1',
      runId: 'run-1',
      phaseId: 'phase-1',
      status: 'open',
      dispatchAttempts: 1,
    };
    let offered = false;
    const replans = {
      claimDue: vi.fn(async () => {
        if (offered) return null;
        offered = true;
        return replan;
      }),
      findOpen: vi.fn(async () => null),
      renewClaim: vi.fn(async () => true),
      releaseClaim: vi.fn(async () => true),
      failClaimed: vi.fn(async () => true),
      scheduleClaimedRetry: vi.fn(async () => true),
      deferClaimWithoutAttempt: vi.fn(async () => true),
    };
    const dispatchClaimedPhaseReplan = vi.fn(async () => undefined);
    const worker = new SystemRecoveryWorker({
      db: databaseReturning([run], [phase]) as never,
      sessions: { claimDueRecovery: vi.fn(async () => null) } as never,
      replans: replans as never,
      runService: {
        authorizeRecoveryExecution: vi.fn(async () => run),
        transitionStatusIfCurrent: vi.fn(async () => run),
        recordRunEvent: vi.fn(async () => undefined),
        onSessionStatusChange: vi.fn(async () => undefined),
      } as never,
      startRunService: { dispatchClaimedPhaseReplan } as never,
      leases: {
        ensurePlatformCloudRunner: vi.fn(async () => undefined),
        verifyLocalRecoveryOwnership: vi.fn(async () => 'owned'),
      } as never,
      config: { queueCloudRuns: true } as never,
      agentServices: {} as never,
      journalRecovery: { reconcile: vi.fn() } as never,
      workerId: 'replan-worker',
      now: () => new Date('2026-08-15T10:00:01.000Z'),
    });

    const result = await worker.tick();

    expect(result.replansDispatched).toBe(1);
    expect(dispatchClaimedPhaseReplan).toHaveBeenCalledWith({ run, phase, replan });
    expect(replans.renewClaim).toHaveBeenCalledTimes(2);
    expect(replans.releaseClaim).toHaveBeenCalledOnce();
  });

  it('does not dispatch a replan after losing its durable claim', async () => {
    const run = runRow();
    const phase = { id: 'phase-1', runId: 'run-1', phaseKey: 'enumeration', status: 'completed' };
    const replan = {
      id: 'replan-1',
      runId: 'run-1',
      phaseId: 'phase-1',
      status: 'open',
      dispatchAttempts: 1,
    };
    let offered = false;
    const replans = {
      claimDue: vi.fn(async () => {
        if (offered) return null;
        offered = true;
        return replan;
      }),
      renewClaim: vi.fn(async () => false),
      releaseClaim: vi.fn(async () => false),
      failClaimed: vi.fn(async () => false),
      scheduleClaimedRetry: vi.fn(async () => false),
      deferClaimWithoutAttempt: vi.fn(async () => false),
    };
    const dispatchClaimedPhaseReplan = vi.fn();
    const worker = new SystemRecoveryWorker({
      db: databaseReturning([run], [phase]) as never,
      sessions: { claimDueRecovery: vi.fn(async () => null) } as never,
      replans: replans as never,
      runService: {
        authorizeRecoveryExecution: vi.fn(),
        transitionStatusIfCurrent: vi.fn(),
        recordRunEvent: vi.fn(),
        onSessionStatusChange: vi.fn(),
      } as never,
      startRunService: { dispatchClaimedPhaseReplan } as never,
      leases: {
        ensurePlatformCloudRunner: vi.fn(async () => undefined),
        verifyLocalRecoveryOwnership: vi.fn(async () => 'owned'),
      } as never,
      config: { queueCloudRuns: true } as never,
      agentServices: {} as never,
      journalRecovery: { reconcile: vi.fn() } as never,
      workerId: 'replan-worker',
      now: () => new Date('2026-08-15T10:00:01.000Z'),
    });

    const result = await worker.tick();

    expect(result.replansDeferred).toBe(1);
    expect(dispatchClaimedPhaseReplan).not.toHaveBeenCalled();
  });

  it('dispatches a replan while the run is in a typed system pause', async () => {
    const harness = buildReplanHarness({ runStatus: 'system_paused' });

    const result = await harness.worker.tick();

    expect(result.replansDispatched).toBe(1);
    expect(harness.runService.authorizeRecoveryExecution).toHaveBeenCalledWith({
      orgId: 'org-1',
      runId: 'run-1',
      allowedStatuses: ['system_paused'],
    });
  });

  it('backs off a failed replan dispatch and pauses the run conditionally', async () => {
    const harness = buildReplanHarness({ dispatchError: new Error('planner unavailable') });

    const result = await harness.worker.tick();

    expect(result.replansDeferred).toBe(1);
    expect(harness.replans.scheduleClaimedRetry).toHaveBeenCalledWith(expect.objectContaining({
      error: 'planner unavailable',
    }));
    expect(harness.runService.transitionStatusIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      expectedStatuses: ['running'],
      nextStatus: 'system_paused',
    }));
  });

  it('closes an exhausted replan and fails its run', async () => {
    const harness = buildReplanHarness({ dispatchAttempts: 4 });

    const result = await harness.worker.tick();

    expect(result.replansFailed).toBe(1);
    expect(harness.replans.failClaimed).toHaveBeenCalledOnce();
    expect(harness.runService.transitionStatusIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      expectedStatuses: ['running', 'system_paused'],
      nextStatus: 'failed',
    }));
    expect(harness.dispatchClaimedPhaseReplan).not.toHaveBeenCalled();
  });
});
