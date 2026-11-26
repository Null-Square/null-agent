import { describe, expect, it, vi } from 'vitest';

import { RunPhaseWorkflowService } from '@/domains/security-ops/runs/RunPhaseWorkflowService';

describe('RunPhaseWorkflowService replanning', () => {
  it('rejects a revised plan that drops an unfinished stable mission id', async () => {
    const run = {
      id: 'run-1',
      goal: 'Assess the public application',
      status: 'running',
      title: 'Public Application Assessment',
      plannerSessionId: 'planner-1',
      executorSessionId: null,
    };
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([run]),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);

    const db = {
      select: vi.fn().mockReturnValue(selectChain),
      update: vi.fn(),
    };
    const runPhaseRepository = {
      hasSessionHistory: vi.fn().mockResolvedValue(true),
      listByRunId: vi.fn().mockResolvedValue([
        {
          id: 'phase-enum',
          phaseKey: 'enumeration',
          status: 'pending',
          sessionId: null,
          stepIds: ['mission-enum-stable'],
        },
      ]),
    };
    const service = new RunPhaseWorkflowService(db as never, {
      runPhaseRepository: runPhaseRepository as never,
      runPhaseReplanRepository: {} as never,
      validationQueueRepository: {} as never,
    });

    await expect(service.markPlanningComplete(
      'run-1',
      '# Revised Public Application Assessment\n\nContinue with the reachable surface.',
      [],
      'planner-1',
      {
        missions: [{
          id: 'mission-recon-new',
          phase: 'recon',
          question: 'What hosts remain reachable?',
          why_ready_now: 'The earlier phase was blocked.',
          required_evidence: ['Fresh reachability evidence'],
          expected_artifact: 'Updated recon handoff',
          stop_condition: 'Reachability is resolved.',
        }],
      },
    )).rejects.toThrow(
      'Replan cannot remove unfinished mission obligations: mission-enum-stable',
    );

    expect(db.update).not.toHaveBeenCalled();
  });
});
