import { describe, expect, it } from 'vitest';
import {
  buildOmittedMissionObligationsMessage,
  collectUnfinishedMissionObligations,
  findOmittedMissionObligations,
} from '@/domains/security-ops/runs/missionObligations';

/**
 * D13 — the replan in production run r1 was rejected twice before it succeeded: nine
 * occurrences of *"cannot remove unfinished mission obligations: task-final"* and eight of
 * *"submit_plan blocked: skill routing is missing"*, plus two `submit_plan.gate_blocked`
 * events, for roughly 414k input tokens and several minutes.
 *
 * Both are schema invariants the system can evaluate before dispatching. This one used to be
 * enforced only downstream, where it threw — so the planner discovered it by being rejected.
 */
const phase = (
  status: string,
  stepIds: string[],
  sessionId: string | null = null,
) => ({ status, stepIds, sessionId });

describe('mission obligations a replan may not drop', () => {
  it('reproduces the r1 rejection', () => {
    const omitted = findOmittedMissionObligations(
      [phase('pending', ['task-final']), phase('completed', ['task-1'], 'session-1')],
      ['task-3', 'task-4', 'task-5', 'task-6'],
    );

    expect(omitted).toEqual(['task-final']);
    expect(buildOmittedMissionObligationsMessage(omitted)).toContain('task-final');
    expect(buildOmittedMissionObligationsMessage(omitted)).toContain('Keep each stable mission id');
  });

  it('accepts a replan that keeps every unfinished obligation', () => {
    expect(findOmittedMissionObligations(
      [phase('pending', ['task-final'])],
      ['task-3', 'task-final'],
    )).toEqual([]);
  });

  it('does not hold a replan to an obligation that has already been dispatched', () => {
    // A phase with a session has had its obligation discharged; the replan may reshape it.
    expect(findOmittedMissionObligations(
      [phase('pending', ['task-2'], 'session-7')],
      ['task-9'],
    )).toEqual([]);
  });

  it('does not hold a replan to a phase that is no longer pending', () => {
    expect(findOmittedMissionObligations(
      [phase('completed', ['task-2']), phase('blocked', ['task-3'])],
      ['task-9'],
    )).toEqual([]);
  });

  it('reports each obligation once even when several phases carry it', () => {
    expect(collectUnfinishedMissionObligations([
      phase('pending', ['task-final', 'task-x']),
      phase('pending', ['task-final']),
    ])).toEqual(['task-final', 'task-x']);
  });

  it('treats a run with no phases as owing nothing', () => {
    expect(findOmittedMissionObligations([], ['task-1'])).toEqual([]);
  });

  it('names every dropped obligation, not just the first', () => {
    const omitted = findOmittedMissionObligations(
      [phase('pending', ['task-final', 'task-report'])],
      ['task-3'],
    );

    expect(omitted).toEqual(['task-final', 'task-report']);
    expect(buildOmittedMissionObligationsMessage(omitted)).toContain('task-final, task-report');
  });
});
