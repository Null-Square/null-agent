import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerDelegationService } from '@/domains/agent-brain/application/services/WorkerDelegationService';
import { B1_ACCEPTED_CATALOG_VERSION } from '@/domains/agent-brain/domain/workers/enumerationContracts';

const attempt = {
  reservationFingerprint: 'a'.repeat(64),
  fingerprintsByTechnique: { 'T-IDOR': 'b'.repeat(64) },
  surfaceRef: '/api/users/{id}',
  toolClass: 'http_payload',
  actionClass: 'GET',
  personaClass: 'anonymous',
  requestCount: 1,
  reservedAt: 1_000,
  status: 'reserved' as const,
};

const buildTask = (overrides: Record<string, unknown> = {}): any => ({
  taskId: 'task-1',
  parentSessionId: 'parent',
  workerSessionId: 'child',
  workerType: 'enumeration_worker',
  status: 'blocked',
  reason: 'bounded hunt',
  task: 'check one endpoint',
  expectedArtifactType: 'enumeration_result/v1',
  executionMode: 'blocking',
  dependencyMode: 'dependency',
  continuationMode: 'spawn',
  budget: {
    maxToolCalls: 22,
    maxTargetRequests: 40,
    maxRequestConcurrency: 2,
    maxWallSeconds: 360,
  },
  continuationCount: 0,
  retryIndex: 0,
  targetRequestsUsed: 1,
  enumerationAttempts: [{ ...attempt, status: 'completed', completedAt: 2_000 }],
  deadlineAt: Date.now() + 60_000,
  createdAt: 1,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('enumeration worker lifecycle', () => {
  it('continues once with recalculated budgets and prior attempt receipts in context, with no credit state', async () => {
    const task = buildTask();
    const parent: any = {
      id: 'parent',
      turn: 3,
      flags: {},
      coordination: { role: 'direct' },
      workerTasks: [task],
    };
    const child: any = { id: 'child', coordination: { role: 'worker' } };
    const sessions: Record<string, any> = { parent, child };
    const store = {
      get: vi.fn((id: string) => sessions[id]),
      setAsync: vi.fn(async (id: string, session: any) => {
        sessions[id] = session;
      }),
    } as any;
    const service = new WorkerDelegationService(store);
    service.bindRuntime({
      agentEngine: {} as any,
      orchestrator: { processMessage: vi.fn() },
    });
    (service as any).syncWorkerState = vi.fn(async () => parent.workerTasks[0]);
    const prompts: string[] = [];
    (service as any).runWorkerTaskLoop = vi.fn(async (nextTask: any, prompt: string) => {
      prompts.push(prompt);
      return nextTask;
    });

    const result = await service.continueWorker({
      parentSessionId: 'parent',
      taskId: 'task-1',
      instruction: 'The account prerequisite is resolved; test only the alternate object ID.',
    });

    expect(result.task.continuationCount).toBe(1);
    expect(prompts[0]).toContain(
      'Parent bounded continuation input: The account prerequisite is resolved; test only the alternate object ID.',
    );
    expect(prompts[0]).toContain('Remaining target-request budget: 39.');
    expect(prompts[0]).toContain(attempt.reservationFingerprint);
    expect(prompts[0]).toContain(`T-IDOR:${attempt.fingerprintsByTechnique['T-IDOR']}`);

    await expect(service.continueWorker({
      parentSessionId: 'parent',
      taskId: 'task-1',
      instruction: 'Try once more.',
    })).rejects.toThrow('continuation_limit_reached');
  });

  it('cancels idempotently and releases active request reservations exactly once', async () => {
    const task = buildTask({
      status: 'running',
      targetRequestsUsed: 1,
      enumerationAttempts: [],
    });
    const parent: any = {
      id: 'parent',
      turn: 1,
      coordination: {
        role: 'direct',
      },
      workerTasks: [task],
    };
    const child: any = {
      id: 'child',
      turn: 1,
      coordination: {
        role: 'worker',
        parentSessionId: 'parent',
        parentTaskId: 'task-1',
        workerType: 'enumeration_worker',
        targetRequestsUsed: 1,
        activeTargetRequests: 1,
        enumerationAttemptReservations: {
          [attempt.reservationFingerprint]: attempt,
        },
        enumerationAttempts: [],
      },
    };
    const sessions: Record<string, any> = { parent, child };
    const store = {
      get: vi.fn((id: string) => sessions[id]),
      setAsync: vi.fn(async (id: string, session: any) => {
        sessions[id] = session;
      }),
      abortCurrentTurnAsync: vi.fn(),
      updateSessionAsync: vi.fn(async (
        id: string,
        mutator: (session: any) => unknown,
      ) => mutator(sessions[id])),
    } as any;
    const service = new WorkerDelegationService(store);
    (service as any).syncWorkerState = vi.fn(async () => parent.workerTasks[0]);

    const first = await service.stopWorker({
      parentSessionId: 'parent',
      taskId: 'task-1',
      reason: 'scope revoked',
    });
    const second = await service.stopWorker({
      parentSessionId: 'parent',
      taskId: 'task-1',
      reason: 'scope revoked',
    });

    expect(first.task.status).toBe('cancelled');
    expect(second.task.status).toBe('cancelled');
    expect(child.coordination.activeTargetRequests).toBe(0);
    expect(child.coordination.enumerationAttemptReservations).toBeUndefined();
    expect(child.coordination.enumerationAttempts).toEqual([
      expect.objectContaining({
        reservationFingerprint: attempt.reservationFingerprint,
        status: 'failed',
        completedAt: expect.any(Number),
      }),
    ]);
    expect(parent.workerTasks[0].enumerationAttempts).toHaveLength(1);
    expect(store.setAsync.mock.calls.filter(([id]: [string]) => id === 'child')).toHaveLength(1);
  });

  it('marks wall_timeout even when the orchestrator resolves after watchdog abort', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED', 'true');
    const task = buildTask({
      status: 'running',
      deadlineAt: Date.now() + 10,
    });
    const parent: any = {
      id: 'parent',
      turn: 1,
      flags: {
        securityops: {
          activePhaseKey: 'enumeration',
          enumerationWorkerV1: {
            capability: 'enumeration_worker_v1',
            enabled: true,
            cohort: 'allowlist',
            policyVersion: 1,
            catalogVersion: B1_ACCEPTED_CATALOG_VERSION,
          },
        },
      },
      workerTasks: [task],
    };
    const child: any = {
      id: 'child',
      turn: 1,
      coordination: { role: 'worker', workerType: 'enumeration_worker' },
    };
    const sessions: Record<string, any> = { parent, child };
    const store = {
      get: vi.fn((id: string) => sessions[id]),
      setAsync: vi.fn(async (id: string, session: any) => {
        sessions[id] = session;
      }),
      abortCurrentTurnAsync: vi.fn(async () => undefined),
    } as any;
    const processMessage = vi.fn(
      async () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
    );
    const service = new WorkerDelegationService(store);
    service.bindRuntime({
      agentEngine: {} as any,
      orchestrator: { processMessage },
    });
    (service as any).policyResolver.assertWorkerCanRunTurn = vi.fn();
    (service as any).syncWorkerState = vi.fn(async () => task);

    const turn = (service as any).runWorkerTurn(task, 'bounded prompt');
    await vi.advanceTimersByTimeAsync(25);
    await turn;

    expect(store.abortCurrentTurnAsync).toHaveBeenCalledWith('child', 'wall_timeout');
    expect(child.blockedReason).toBe('wall_timeout');
    expect(store.setAsync).toHaveBeenCalledWith(
      'child',
      child,
      'worker_wall_timeout',
    );
  });
});
