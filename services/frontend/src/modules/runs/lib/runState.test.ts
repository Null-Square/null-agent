import { describe, expect, it } from 'vitest';

import { isRunAwaitingPlanApproval, resolveRunSessionId } from './runState';

describe('isRunAwaitingPlanApproval', () => {
  it('uses the explicit backend flag when present', () => {
    expect(
      isRunAwaitingPlanApproval({
        goal: 'Assess API auth flow',
        status: 'paused',
        executorSessionId: 'executor-1',
        plan: '# Plan',
        awaitingPlanApproval: true,
      }),
    ).toBe(true);
  });

  it('falls back to planner approval semantics for older payloads', () => {
    expect(
      isRunAwaitingPlanApproval({
        goal: 'Assess API auth flow',
        status: 'paused',
        interactionType: 'plan_approval',
        executorSessionId: null,
        plan: '# Plan',
      }),
    ).toBe(true);
  });

  it('does not treat generic executor waits as plan approval', () => {
    expect(
      isRunAwaitingPlanApproval({
        goal: 'Assess API auth flow',
        status: 'paused',
        interactionType: 'none',
        executorSessionId: 'executor-1',
        plan: '# Plan',
      }),
    ).toBe(false);
  });

  it('does not treat a running planner revision as plan approval even with a stale flag', () => {
    expect(
      isRunAwaitingPlanApproval({
        goal: 'Assess API auth flow',
        status: 'running',
        interactionType: 'plan_approval',
        executorSessionId: null,
        plan: '# Plan',
        awaitingPlanApproval: true,
      }),
    ).toBe(false);
  });
});

describe('resolveRunSessionId', () => {
  it('prefers the executor session for terminal runs', () => {
    expect(
      resolveRunSessionId({
        status: 'completed',
        activeSessionId: 'planner-1',
        sessionId: 'planner-1',
        plannerSessionId: 'planner-1',
        executorSessionId: 'executor-1',
      }),
    ).toBe('executor-1');
  });

  it('prefers the executor session while a run is still in flight', () => {
    expect(
      resolveRunSessionId({
        status: 'running',
        activeSessionId: 'planner-1',
        sessionId: 'planner-1',
        plannerSessionId: 'planner-1',
        executorSessionId: 'executor-1',
      }),
    ).toBe('executor-1');
  });

  it('falls back to the active session when no executor exists yet', () => {
    expect(
      resolveRunSessionId({
        status: 'running',
        activeSessionId: 'planner-1',
        sessionId: 'planner-1',
        plannerSessionId: 'planner-1',
        executorSessionId: undefined,
      }),
    ).toBe('planner-1');
  });
});
