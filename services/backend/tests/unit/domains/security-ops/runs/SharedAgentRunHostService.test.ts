import { describe, expect, it, vi } from 'vitest';

import {
  buildHostedAssignedMethodContext,
  evaluateHostedBudget,
  resolveHostedUsdGuardrail,
  SharedAgentRunHostService,
} from '@/domains/security-ops/runs/SharedAgentRunHostService';

describe('SharedAgentRunHostService context delivery', () => {
  it('points hosted recipients at only their assigned methodology files', () => {
    expect(buildHostedAssignedMethodContext([' XSS ', 'xss', 'source-aware-whitebox'])).toBe([
      '=== ASSIGNED METHODOLOGIES ===',
      '- xss: /workspace/.skills/xss/methodology.md',
      '- source-aware-whitebox: /workspace/.skills/source-aware-whitebox/methodology.md',
    ].join('\n'));
  });

  it('gives a hosted phase one mission rendering and no full approved-plan copy', () => {
    const service = new SharedAgentRunHostService({} as any, { runId: 'run-1' } as any);
    const context = (service as any).buildPhaseContext({
      context: {
        objective: 'Review the pinned repository',
        repository: { url: 'https://example.test/repo.git', ref: 'main', commit: 'abc123' },
      },
      phase: {
        id: 'phase-1',
        ordinal: 1,
        phaseKey: 'validation',
        assignedSkillSlugs: ['source-aware-whitebox'],
      },
      phaseMissions: [{ id: 'validate-path', phase: 'validation' }],
      planDocument: '# Full Approved Plan\n\n1. Duplicate mission body.',
    }) as string;

    expect(context).toContain('=== TARGET CONTEXT ===');
    expect(context).toContain('/workspace/.skills/source-aware-whitebox/methodology.md');
    expect(context.match(/=== PHASE MISSIONS ===/gu)).toHaveLength(1);
    expect(context).not.toContain('Full Approved Plan');
    expect(context).not.toContain('Duplicate mission body');
  });

  it('preserves the Code Review host boundary in hosted phase context', () => {
    const service = new SharedAgentRunHostService({} as any, { runId: 'run-1' } as any);
    (service as any).codeReviewContext = { repository: 'local-review' };
    const context = (service as any).buildPhaseContext({
      context: {
        objective: 'Review the pinned repository',
        repository: { url: 'https://example.test/repo.git', ref: 'main', commit: 'abc123' },
      },
      phase: {
        id: 'phase-1',
        ordinal: 1,
        phaseKey: 'review',
        assignedSkillSlugs: ['source-aware-whitebox'],
      },
      phaseMissions: [{ id: 'review-path', phase: 'review' }],
      planDocument: '# Full Approved Plan',
    }) as string;

    expect(context).toContain('=== CODE REVIEW RUN CONTEXT ===');
    expect(context).toContain('=== HOST BOUNDARY ===');
    expect(context).toContain('No GitHub credential, network target, repository write, or publication authority');
  });
});

describe('SharedAgentRunHostService budget guardrails', () => {
  it('keeps a provider-response reserve below the user hard cap', () => {
    expect(resolveHostedUsdGuardrail(0.5)).toEqual({
      userLimit: 0.5,
      safetyReserve: 0.1,
      stopAt: 0.4,
    });
    expect(resolveHostedUsdGuardrail(2)).toEqual({
      userLimit: 2,
      safetyReserve: 0.1,
      stopAt: 1.9,
    });
  });

  it('asks planning to close out before downstream phase budget is consumed', () => {
    const decision = evaluateHostedBudget(
      'planning',
      { maxWallSeconds: 600, maxModelRequests: 40, maxUsd: 0.5 },
      { modelRequests: 10, recordedCost: 0.1 },
    );

    expect(decision.closeout).toBe(true);
    expect(decision.stopReason).toBeUndefined();
  });

  it('stops at the protected USD threshold rather than after overspending', () => {
    const decision = evaluateHostedBudget(
      'validation',
      { maxWallSeconds: 600, maxModelRequests: 40, maxUsd: 0.5 },
      { modelRequests: 25, recordedCost: 0.4 },
    );

    expect(decision.closeout).toBe(true);
    expect(decision.stopReason).toBe('max_usd_safety_reserve_reached');
  });

  it('does not allow one extra model request beyond the configured cap', () => {
    const decision = evaluateHostedBudget(
      'reporting',
      { maxWallSeconds: 600, maxModelRequests: 40 },
      { modelRequests: 40, recordedCost: 0 },
    );

    expect(decision.stopReason).toBe('max_model_requests_exceeded');
  });
});

describe('SharedAgentRunHostService execution tracking', () => {
  it('does not create a detached rejection while releasing a failed execution', async () => {
    const service = new SharedAgentRunHostService({} as any, { runId: 'run-1' } as any);
    let rejectExecution!: (reason: Error) => void;
    const execution = new Promise<any>((_resolve, reject) => {
      rejectExecution = reject;
    });
    vi.spyOn(service, 'execute').mockReturnValue(execution);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await service.start({} as any, async () => undefined);
      const waited = service.wait();
      rejectExecution(new Error('hosted execution failed'));
      await expect(waited).rejects.toThrow('hosted execution failed');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
