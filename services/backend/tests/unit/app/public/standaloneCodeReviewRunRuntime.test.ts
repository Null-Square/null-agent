import { describe, expect, it, vi } from 'vitest';

import { StandaloneCodeReviewRunRuntime } from '@/app/public/standaloneCodeReviewRunRuntime';

const runtimeWith = (overrides: Record<string, unknown> = {}) => Object.assign(
  Object.create(StandaloneCodeReviewRunRuntime.prototype),
  {
    ...overrides,
  },
) as StandaloneCodeReviewRunRuntime;

describe('StandaloneCodeReviewRunRuntime live controls', () => {
  it('passes the caller-owned plan approval policy into the shared run lifecycle', async () => {
    const startPlannerRun = vi.fn().mockResolvedValue({ run: { id: 'run-1' } });
    const runtime = runtimeWith({
      startRunService: { startPlannerRun },
      subscriptionPort: {
        resolveOrganizationSubscription: vi.fn().mockResolvedValue({
          plan: { slug: 'control', limits: { maxConcurrentRuns: 2 } },
        }),
      },
    });

    await runtime.startRepositoryReview({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Review the repository',
      modelId: 'model-1',
      codeReviewContext: {} as never,
      manifestFiles: [],
      autoApproveOnPlanning: true,
    });

    expect(startPlannerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowDiscipline: 'code_review',
        autoApproveOnPlanning: true,
        maxConcurrentRuns: 2,
        schedulingClass: 'paid',
      }),
    );
  });

  it('stops the active turn before marking the product run stopped', async () => {
    const stopProcessing = vi.fn();
    const session = {
      id: 'session-1',
      turn: 4,
      stateMachine: {
        isProcessing: () => true,
        stopProcessing,
      },
    };
    const setAsync = vi.fn().mockResolvedValue(undefined);
    const recordStopRequestedAsync = vi.fn().mockResolvedValue(true);
    const setBlockedReason = vi.fn().mockResolvedValue(true);
    const abortCurrentTurnAsync = vi.fn().mockResolvedValue(undefined);
    const stopSandbox = vi.fn().mockResolvedValue(undefined);
    const transitionStatus = vi.fn().mockResolvedValue(undefined);
    const runtime = runtimeWith({
      app: {
        sessionStore: { listByRunId: () => [session], setAsync },
      },
      services: {
        sessionStore: { abortCurrentTurnAsync, recordStopRequestedAsync },
        agentEngine: { stopSandbox },
      },
      sessionRepository: { setBlockedReason },
      runService: {
        getById: vi.fn().mockResolvedValue({ status: 'running' }),
        transitionStatus,
      },
    });

    await runtime.stopRun('org-1', 'run-1');

    expect(stopProcessing).toHaveBeenCalledWith(
      'user_paused',
      4,
      'standalone_code_review_runtime.stop',
    );
    expect(session).toMatchObject({ blockedReason: 'user_paused' });
    expect(recordStopRequestedAsync).toHaveBeenCalledWith(
      'session-1',
      'standalone_code_review_stopped',
      'org-1',
    );
    expect(setBlockedReason).not.toHaveBeenCalled();
    expect(abortCurrentTurnAsync).toHaveBeenCalledWith(
      'session-1',
      'standalone_code_review_stopped',
    );
    expect(stopSandbox).toHaveBeenCalledWith(
      session,
      'standalone_code_review_stopped',
    );
    expect(transitionStatus).toHaveBeenCalledWith('org-1', 'run-1', 'user_paused');
  });

  it('records durable Start intent for every owned session', async () => {
    const listIdsByRunId = vi.fn().mockResolvedValue(['session-1']);
    const recordStartRequestedAsync = vi.fn().mockResolvedValue(true);
    const runtime = runtimeWith({
      services: { sessionStore: { recordStartRequestedAsync } },
      sessionRepository: { listIdsByRunId },
      runService: { transitionStatus: vi.fn() },
    });

    await runtime.startRun('org-1', 'run-1');

    expect(listIdsByRunId).toHaveBeenCalledWith('run-1');
    expect(recordStartRequestedAsync).toHaveBeenCalledWith(
      'session-1',
      'evaluation lab run run-1 started',
      'org-1',
    );
  });

  it('starts the ready phase when Stop landed between sessions', async () => {
    const startReadyPhaseForRun = vi.fn().mockResolvedValue(null);
    const runtime = runtimeWith({
      sessionRepository: {
        listIdsByRunId: vi.fn().mockResolvedValue([]),
      },
      runService: {
        transitionStatus: vi.fn().mockResolvedValue(undefined),
        getById: vi.fn().mockResolvedValue({ userId: 'user-1' }),
      },
      startRunService: { startReadyPhaseForRun },
    });

    await runtime.startRun('org-1', 'run-1');

    expect(startReadyPhaseForRun).toHaveBeenCalledWith({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });
  });

  it('cancels live session work before terminalizing the durable run', async () => {
    const session = {
      id: 'session-1',
      turn: 2,
      stateMachine: { getState: () => 'processing', stopProcessing: vi.fn() },
    };
    const recordStopRequestedAsync = vi.fn().mockResolvedValue(true);
    const abortCurrentTurnAsync = vi.fn().mockResolvedValue(undefined);
    const waitForCurrentTurnToSettleAsync = vi.fn().mockResolvedValue(true);
    const stopSandbox = vi.fn().mockResolvedValue(undefined);
    const cleanupRunWorkspaceAsync = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const runtime = runtimeWith({
      services: {
        sessionStore: {
          abortCurrentTurnAsync,
          waitForCurrentTurnToSettleAsync,
          getOrHydrate: vi.fn().mockResolvedValue(session),
          recordStopRequestedAsync,
          setAsync: vi.fn().mockResolvedValue(undefined),
          cleanupRunWorkspaceAsync,
        },
        agentEngine: { stopSandbox },
      },
      sessionRepository: {
        listIdsByRunId: vi.fn().mockResolvedValue(['session-1']),
        setBlockedReason: vi.fn().mockResolvedValue(true),
      },
      runService: { cancel },
    });

    await runtime.cancelRun('org-1', 'run-1', 'operator_stop');

    expect(abortCurrentTurnAsync).toHaveBeenCalledWith(
      'session-1',
      'run_cancelled_by_operator',
    );
    expect(stopSandbox).toHaveBeenCalledWith(
      session,
      'run_cancelled_by_operator',
    );
    expect(cleanupRunWorkspaceAsync).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ force: true }),
    );
    expect(waitForCurrentTurnToSettleAsync).toHaveBeenCalledWith('session-1');
    expect(cancel).toHaveBeenCalledWith('org-1', 'run-1');
    expect(waitForCurrentTurnToSettleAsync.mock.invocationCallOrder[0]).toBeLessThan(
      cancel.mock.invocationCallOrder[0]!,
    );
  });
});
