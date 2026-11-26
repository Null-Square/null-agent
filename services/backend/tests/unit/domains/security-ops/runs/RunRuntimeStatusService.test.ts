import { describe, expect, it, vi } from 'vitest';

import { RunRuntimeStatusService } from '@/domains/security-ops/runs/RunRuntimeStatusService';

const buildService = () => new RunRuntimeStatusService({
  runPhaseRepository: {
    listSessionIdsByRunId: vi.fn(async () => []),
    listByRunId: vi.fn(async () => []),
    hasSessionHistory: vi.fn(async () => false),
    hasOpenPhases: vi.fn(async () => false),
  },
  runInactivityFailMs: 60_000,
});

describe('RunRuntimeStatusService planner completion', () => {
  it('keeps a terminal exposure verification run completed without a plan or executor', async () => {
    const status = await buildService().normalizeGoalPlannerCompletionStatusForRuntime({
      id: 'run-exposure',
      goal: 'Verify one CVE exposure',
      trigger: 'exposure_verification',
      plan: null,
      executorSessionId: null,
    } as never, 'completed');

    expect(status).toBe('completed');
  });

  it('preserves the plan gate for ordinary completed planners', async () => {
    const status = await buildService().normalizeGoalPlannerCompletionStatusForRuntime({
      id: 'run-pentest',
      goal: 'Assess a target',
      trigger: 'manual',
      plan: null,
      executorSessionId: null,
    } as never, 'completed');

    expect(status).toBe('failed');
  });

  it('continues a completed initial planner when its durable launch policy auto-approves', async () => {
    const status = await buildService().normalizeGoalPlannerCompletionStatusForRuntime({
      id: 'run-auto-approved',
      goal: 'Assess a verified target',
      trigger: 'manual',
      plan: '# Approved assessment plan',
      executorSessionId: null,
      launchPayload: {
        version: 1,
        kind: 'planner',
        params: { autoApproveOnPlanning: true },
      },
    } as never, 'completed');

    expect(status).toBe('running');
  });

  it('keeps a completed initial planner gated when its durable launch policy requires approval', async () => {
    const status = await buildService().normalizeGoalPlannerCompletionStatusForRuntime({
      id: 'run-approval-required',
      goal: 'Assess a verified target',
      trigger: 'scheduled',
      plan: '# Approval-required assessment plan',
      executorSessionId: null,
      launchPayload: {
        version: 1,
        kind: 'planner',
        params: { autoApproveOnPlanning: false },
      },
    } as never, 'completed');

    expect(status).toBe('awaiting_approval');
  });

  it('continues a legacy unattended Run whose launch payload predates the durable policy', async () => {
    const status = await buildService().normalizeGoalPlannerCompletionStatusForRuntime({
      id: 'run-legacy-watch',
      goal: 'Run Website Watch discovery',
      trigger: 'watch_scheduled',
      plan: '# Website Watch discovery plan',
      executorSessionId: null,
      launchPayload: null,
    } as never, 'completed');

    expect(status).toBe('running');
  });
});
