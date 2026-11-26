import { describe, it, expect } from 'vitest';
import { AutomationModePolicy, type GuardContext } from '@/domains/agent-brain/application/services/AutomationModePolicy';

const makeCtx = (overrides: Partial<GuardContext> = {}): GuardContext => ({
  mode: 'automated',
  isProcessing: true,
  pendingPlanSteps: [],
  hasReport: false,
  toolCallCount: 0,
  ...overrides,
});

describe('AutomationModePolicy', () => {
  it('exposes configured limits and validates report content', () => {
    const policy = new AutomationModePolicy({ turnTimeoutMs: 42_000, reportMinLength: 10 });

    expect(policy.getTurnTimeoutMs()).toBe(42_000);
    expect(policy.getReportMinLength()).toBe(10);

    expect(policy.validateReportContent(undefined)).toEqual({
      valid: false,
      reason: 'Report content is empty',
    });
    expect(policy.validateReportContent('short')).toEqual({
      valid: false,
      reason: 'Report content too short (5 chars, minimum: 10)',
    });
    expect(policy.validateReportContent('long enough content').valid).toBe(true);
  });

  it('bypasses approval in automated mode but respects base decision otherwise', () => {
    const policy = new AutomationModePolicy();
    expect(policy.shouldAwaitApproval({ mode: 'automated' } as any, true)).toBe(false);
    expect(policy.shouldAwaitApproval({ mode: 'interactive' } as any, true)).toBe(true);
    expect(policy.shouldAwaitApproval(undefined, false)).toBe(false);
  });

  it('keeps guard inactive when not processing', () => {
    const policy = new AutomationModePolicy({ maxGuardRetries: 2 });
    const decision = policy.evaluateGuard(
      makeCtx({
        isProcessing: false,
        pendingPlanSteps: [{ id: 'step-1' }],
        previousRetryCount: 1,
      }),
    );

    expect(decision.active).toBe(false);
    expect(decision.suppressDone).toBe(true);
    expect(decision.nextRetryCount).toBe(1);
    expect(decision.pendingStepIds).toEqual(['step-1']);
  });

  it('activates guard when automated run stalls with pending steps', () => {
    const policy = new AutomationModePolicy({ maxGuardRetries: 2 });
    const decision = policy.evaluateGuard(
      makeCtx({
        pendingPlanSteps: [{ id: 'p1' }, { id: 'p2' }],
        toolCallCount: 0,
        previousRetryCount: 0,
      }),
    );

    expect(decision.active).toBe(true);
    expect(decision.reason).toBe('pending_no_tools');
    expect(decision.pendingStepIds).toEqual(['p1', 'p2']);
    expect(decision.exhausted).toBe(false);
    expect(decision.nextRetryCount).toBe(1);
    expect(decision.autoRetryReason).toBe('guard_retry:pending_no_tools');
    expect(decision.suppressDone).toBe(true);
  });

  it('prompts for report when plan is empty and report missing', () => {
    const policy = new AutomationModePolicy();
    const decision = policy.evaluateGuard(
      makeCtx({
        pendingPlanSteps: [],
        hasReport: false,
        toolCallCount: 0,
      }),
    );

    expect(decision.active).toBe(true);
    expect(decision.reason).toBe('report_missing');
    expect(decision.autoRetryMessage).toContain('report.md');
  });

  it('does not require report for planner sessions', () => {
    const policy = new AutomationModePolicy();
    expect(policy.isReportRequired('planner')).toBe(false);
    expect(policy.isReportRequired('executor')).toBe(true);
    expect(
      policy.isReportRequired({
        agentType: 'executor',
        coordination: { role: 'worker', parentSessionId: 'parent-1' },
      }),
    ).toBe(false);

    const decision = policy.evaluateGuard(
      makeCtx({
        agentType: 'planner',
        pendingPlanSteps: [],
        hasReport: false,
        toolCallCount: 0,
      }),
    );

    expect(decision.active).toBe(false);
    expect(decision.suppressDone).toBe(false);
  });

  it('keeps worker sessions out of report-missing guard flow', () => {
    const policy = new AutomationModePolicy();
    const decision = policy.evaluateGuard(
      makeCtx({
        agentType: {
          agentType: 'executor',
          coordination: { role: 'worker', parentSessionId: 'parent-1' },
        },
        pendingPlanSteps: [],
        hasReport: false,
        toolCallCount: 1,
      }),
    );

    expect(decision.active).toBe(false);
    expect(decision.suppressDone).toBe(false);
  });

  it('supports globally disabling guards and report requirements', () => {
    const policy = new AutomationModePolicy({ guardsEnabled: false });
    expect(policy.isReportRequired('executor')).toBe(false);
    expect(policy.isReportRequired('planner')).toBe(false);

    const decision = policy.evaluateGuard(
      makeCtx({
        pendingPlanSteps: [{ id: 'p1' }],
        hasReport: false,
        toolCallCount: 0,
      }),
    );

    expect(decision.active).toBe(false);
    expect(decision.suppressDone).toBe(false);
  });

  it('slows recovery instead of blocking after exceeding the fast retry budget', () => {
    const policy = new AutomationModePolicy({ maxGuardRetries: 1 });
    const decision = policy.evaluateGuard(
      makeCtx({
        pendingPlanSteps: [{ id: 'p1' }],
        toolCallCount: 0,
        previousRetryCount: 1,
      }),
    );

    expect(decision.active).toBe(true);
    expect(decision.exhausted).toBe(true);
    expect(decision.autoRetryReason).toBe('guard_retry:pending_no_tools');
    expect(decision.autoRetryMessage).toContain('Call tools now');
    expect(decision.autoRetryDelayMs).toBe(30_000);
    expect(decision.nextRetryCount).toBe(2);
  });
});







