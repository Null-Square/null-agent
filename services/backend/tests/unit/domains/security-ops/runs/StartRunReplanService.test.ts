import { describe, expect, it, vi } from 'vitest';

import { StartRunReplanService } from '@/domains/security-ops/runs/StartRunReplanService';

describe('StartRunReplanService durable dispatch', () => {
  it('schedules a claimed phase replan through the session journal', async () => {
    const requestedAt = new Date('2026-08-29T12:00:00.000Z');
    const plannerSession = {
      id: 'planner-1',
      flags: { session: { completed: true } },
      completed: true,
      blockedReason: 'phase_terminalized',
      blockedMeta: { phaseId: 'phase-1' },
    };
    const recordInternalContinuationInputAsync = vi.fn().mockResolvedValue(true);
    const processMessage = vi.fn().mockResolvedValue(undefined);
    const setAsync = vi.fn().mockResolvedValue(undefined);
    const clearBlockedReason = vi.fn().mockResolvedValue(true);
    const setCompleted = vi.fn().mockResolvedValue(true);
    const service = new StartRunReplanService({
      runService: {} as never,
      agentServices: {
        sessionStore: {
          get: vi.fn(() => plannerSession),
          getOrHydrate: vi.fn(async () => plannerSession),
          setAsync,
          recordInternalContinuationInputAsync,
        } as never,
        orchestrator: { processMessage } as never,
      },
      sessionRepository: {
        setCompleted,
        clearBlockedReason,
      },
    });

    await service.dispatchClaimedPhaseReplan({
      run: {
        id: 'run-1',
        plannerSessionId: plannerSession.id,
        plan: '# Existing plan',
      } as never,
      phase: {
        id: 'phase-1',
        sessionId: null,
        phaseKey: 'recon',
      } as never,
      replan: {
        id: 'replan-1',
        dispatchAttempts: 1,
        requestedAt,
        requestedPhaseStatus: 'completed',
        handoffRef: null,
        reason: 'New routes changed the remaining plan.',
      } as never,
    });

    expect(recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      plannerSession.id,
      expect.objectContaining({
        id: 'phase-replan:replan-1',
        role: 'user',
        timestamp: requestedAt.getTime(),
        content: expect.stringContaining('New routes changed the remaining plan.'),
        metadata: {
          visibility: 'internal',
          source: 'phase_replan_request',
          dispatchSource: 'system_recovery_worker',
          replanId: 'replan-1',
        },
      }),
    );
    expect(processMessage).not.toHaveBeenCalled();
    expect(setAsync).not.toHaveBeenCalled();
    expect(setCompleted).not.toHaveBeenCalled();
    expect(plannerSession.blockedReason).toBe('phase_terminalized');
    expect(clearBlockedReason).not.toHaveBeenCalled();
  });
});
