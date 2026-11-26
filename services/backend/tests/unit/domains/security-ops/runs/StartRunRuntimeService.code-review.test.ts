import { describe, expect, it, vi } from 'vitest';

import {
  CODE_REVIEW_PLANNER_KICKOFF_PROMPT,
  COMPLIANCE_PLANNER_KICKOFF_PROMPT,
  EXPOSURE_VERIFICATION_KICKOFF_PROMPT,
  PLANNER_KICKOFF_PROMPT,
} from '@/domains/security-ops/runs/StartRunPromptHelpers';
import {
  resolvePlannerKickoffPrompt,
  StartRunRuntimeService,
} from '@/domains/security-ops/runs/StartRunRuntimeService';
import { assertCodeReviewLaunchAvailable } from '@/domains/security-ops/runs/StartRunService';

const createRuntime = (params: {
  scheduled?: boolean;
  sessionId?: string;
  createdAt?: number;
} = {}) => {
  const sessionId = params.sessionId ?? 'planner-1';
  const session = {
    id: sessionId,
    createdAt: params.createdAt ?? 1_725_000_000_000,
  };
  const recordInternalContinuationInputAsync = vi.fn(async () => params.scheduled ?? true);
  const processMessage = vi.fn(async () => undefined);
  const service = new StartRunRuntimeService({
    runService: {} as never,
    runnerService: {} as never,
    agentServices: {
      sessionStore: {
        get: vi.fn(() => session),
        getOrHydrate: vi.fn(async () => session),
        recordInternalContinuationInputAsync,
      } as never,
      orchestrator: { processMessage } as never,
    },
  });
  return { service, session, recordInternalContinuationInputAsync, processMessage };
};

describe('planner kickoff workflow routing', () => {
  it('routes all three disciplines to distinct planner contracts', () => {
    expect(resolvePlannerKickoffPrompt('pentest')).toBe(PLANNER_KICKOFF_PROMPT);
    expect(resolvePlannerKickoffPrompt('compliance')).toBe(COMPLIANCE_PLANNER_KICKOFF_PROMPT);
    expect(resolvePlannerKickoffPrompt('code_review')).toBe(CODE_REVIEW_PLANNER_KICKOFF_PROMPT);
  });

  it('routes exposure verification away from every planner contract', () => {
    expect(resolvePlannerKickoffPrompt('pentest', 'exposure_verification')).toBe(
      EXPOSURE_VERIFICATION_KICKOFF_PROMPT,
    );
    expect(EXPOSURE_VERIFICATION_KICKOFF_PROMPT).toContain('submit_exposure_verification');
    expect(EXPOSURE_VERIFICATION_KICKOFF_PROMPT).toContain('do not call submit_plan');
    expect(EXPOSURE_VERIFICATION_KICKOFF_PROMPT).not.toContain('query_notes');
  });

  it('fails closed instead of falling back to Pentest for an unknown discipline', () => {
    expect(() => resolvePlannerKickoffPrompt('unknown')).toThrow(
      'Unknown workflow discipline cannot fall back to the Pentest planner',
    );
  });

  it('allows read-only review launch while keeping the fix child workflow gated', () => {
    expect(() => assertCodeReviewLaunchAvailable('code_review', 'repository_review')).not.toThrow();
    expect(() => assertCodeReviewLaunchAvailable('code_review', 'pull_request_review')).not.toThrow();
    expect(() => assertCodeReviewLaunchAvailable('code_review', 'finding_fix')).toThrow(
      'separate patch approval and pull-request publication workflow',
    );
    expect(() => assertCodeReviewLaunchAvailable('pentest')).not.toThrow();
    expect(() => assertCodeReviewLaunchAvailable('compliance')).not.toThrow();
  });

  it('persists planner kickoff before returning and leaves execution to the continuation worker', async () => {
    const runtime = createRuntime();

    await runtime.service.kickoffPlanner('run-1', runtime.session.id, {
      workflowDiscipline: 'code_review',
    });

    expect(runtime.recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      runtime.session.id,
      {
        id: `run-kickoff:run-1:${runtime.session.id}`,
        role: 'user',
        content: CODE_REVIEW_PLANNER_KICKOFF_PROMPT,
        timestamp: runtime.session.createdAt,
        metadata: {
          visibility: 'internal',
          source: 'planner_kickoff',
        },
      },
    );
    expect(runtime.processMessage).not.toHaveBeenCalled();
  });

  it('persists the dedicated exposure verification kickoff', async () => {
    const runtime = createRuntime({ sessionId: 'session-exposure' });

    await runtime.service.kickoffPlanner('run-exposure', runtime.session.id, {
      workflowDiscipline: 'pentest',
      trigger: 'exposure_verification',
    });

    expect(runtime.recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      runtime.session.id,
      expect.objectContaining({
        content: EXPOSURE_VERIFICATION_KICKOFF_PROMPT,
        metadata: {
          visibility: 'internal',
          source: 'planner_kickoff',
        },
      }),
    );
    expect(runtime.processMessage).not.toHaveBeenCalled();
  });

  it('uses the same durable seam for executor kickoff', async () => {
    const runtime = createRuntime({ sessionId: 'executor-1' });

    await runtime.service.kickoffExecutor('run-1', runtime.session.id, 'Start recon.');

    expect(runtime.recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      runtime.session.id,
      expect.objectContaining({
        id: `run-kickoff:run-1:${runtime.session.id}`,
        content: 'Start recon.',
        metadata: {
          visibility: 'internal',
          source: 'executor_kickoff',
        },
      }),
    );
    expect(runtime.processMessage).not.toHaveBeenCalled();
  });

  it('keeps direct orchestration only as the journal-less embedded fallback', async () => {
    const runtime = createRuntime({ scheduled: false });

    await runtime.service.kickoffPlanner('run-embedded', runtime.session.id, {
      workflowDiscipline: 'pentest',
    });

    expect(runtime.processMessage).toHaveBeenCalledWith(
      runtime.session.id,
      PLANNER_KICKOFF_PROMPT,
      undefined,
      undefined,
      {
        visibility: 'internal',
        source: 'planner_kickoff',
      },
    );
  });

  it('replays the same journal command when concurrent repair attempts race', async () => {
    const runtime = createRuntime();

    await Promise.all([
      runtime.service.kickoffExecutor('run-1', runtime.session.id, 'Start recon.'),
      runtime.service.kickoffExecutor('run-1', runtime.session.id, 'Start recon.'),
    ]);

    const calls = runtime.recordInternalContinuationInputAsync.mock.calls as unknown as Array<
      [string, unknown]
    >;
    const firstMessage = calls[0]?.[1];
    const secondMessage = calls[1]?.[1];
    expect(firstMessage).toEqual(secondMessage);
    expect(runtime.processMessage).not.toHaveBeenCalled();
  });
});
