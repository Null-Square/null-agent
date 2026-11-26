import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutomationDecisionEngine, type DecisionContext } from '@/domains/agent-brain/application/orchestration/services/AutomationDecisionEngine';
import type { PendingPlanStep } from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

describe('AutomationDecisionEngine', () => {
  let engine: AutomationDecisionEngine;

  const createContext = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
    sessionId: 'test-session',
    session: {
      id: 'test-session',
      mode: 'automated',
      messages: [],
      plan: [],
      memory: createEmptyMemory(),
      flags: {},
      workspaceDir: '/test',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 1,
      pendingApproval: undefined,
      checkpoints: {},
    } as any,
    turnStatus: 'completed',
    pendingPlanSteps: [],
    hasReport: true,
    requiresReport: true,
    ...overrides,
  });

  beforeEach(() => {
    engine = new AutomationDecisionEngine();
    vi.clearAllMocks();
  });

  describe('Priority 1: blockedReason', () => {
    it('stops when session has blockedReason', () => {
      const ctx = createContext({
        session: { ...createContext().session, blockedReason: 'guard_exhausted' } as any,
        pendingPlanSteps: [{ id: 'step-1' }], // Would normally continue
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('blocked');
    });

    it('takes precedence over guard exhaustion and terminal status', () => {
      const ctx = createContext({
        session: { ...createContext().session, blockedReason: 'sandbox_unhealthy' } as any,
        guardResult: { suppressDone: false, scheduleAutoRetry: false, exhausted: true },
        turnStatus: 'awaiting_user',
        pendingPlanSteps: [{ id: 'step-1' }],
        hasReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('blocked');
      expect(decision.reason).toContain('sandbox_unhealthy');
    });
  });

  describe('Priority 2: mode check', () => {
    it('stops when session is not automated', () => {
      const ctx = createContext({
        session: { ...createContext().session, mode: 'interactive' } as any,
        pendingPlanSteps: [{ id: 'step-1' }],
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('not_automated');
    });

    it('treats undefined mode as not automated', () => {
      const ctx = createContext({
        session: { ...createContext().session, mode: undefined } as any,
        pendingPlanSteps: [{ id: 'step-1' }],
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('not_automated');
    });
  });

  describe('guard degradation', () => {
    it('does not turn exhausted telemetry into a stop authority', () => {
      const ctx = createContext({
        guardResult: { suppressDone: false, scheduleAutoRetry: false, exhausted: true },
        pendingPlanSteps: [{ id: 'step-1' }],
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('pending_steps:1');
    });

    it('still respects a real terminal status when degraded telemetry is present', () => {
      const ctx = createContext({
        guardResult: { suppressDone: false, scheduleAutoRetry: false, exhausted: true },
        turnStatus: 'awaiting_user',
        pendingPlanSteps: [{ id: 'step-1' }],
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('await_user');
      expect(decision.reason).toContain('awaiting_user');
    });
  });

  describe('Priority 4: response and scheduled waits', () => {
    it('awaits a user only for structured user input', () => {
      const decision = engine.decide(createContext({ turnStatus: 'awaiting_user' }));

      expect(decision.action).toBe('await_user');
      expect(decision.reason).toContain('awaiting_user');
    });

    it.each(['credits_exhausted', 'token_limit_exceeded'])(
      'does not reinterpret an already scheduled operational wait as user input: %s',
      (status) => {
        const decision = engine.decide(createContext({ turnStatus: status }));

        expect(decision.action).toBe('stop');
        expect(decision.reason).toContain('durable_wait_scheduled');
      },
    );

    it('stops local continuation after an explicit turn interruption', () => {
      const decision = engine.decide(createContext({ turnStatus: 'aborted' }));

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('turn_aborted');
    });

    it('treats a model deadlock signal as recoverable work', () => {
      const decision = engine.decide(createContext({
        turnStatus: 'deadlock',
        pendingPlanSteps: [{ id: 'step-1' }],
      }));

      expect(decision.action).toBe('continue');
    });
  });

  describe('Priority 5: guard handling', () => {
    it('stops when guard already scheduled retry', () => {
      const ctx = createContext({
        guardResult: { suppressDone: false, scheduleAutoRetry: true, exhausted: false },
        pendingPlanSteps: [{ id: 'step-1' }],
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('guard_handling');
    });
  });

  describe('Priority 6: pending work', () => {
    it('continues when pending steps remain', () => {
      const ctx = createContext({
        pendingPlanSteps: [{ id: 'step-1' }, { id: 'step-2' }],
        hasReport: true,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('pending_steps:2');
      expect(decision.message).toBe('continue');
    });

    it('continues when guard result is undefined and pending work exists', () => {
      const ctx = createContext({
        guardResult: undefined,
        pendingPlanSteps: [{ id: 'step-1' }],
        hasReport: true,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('pending_steps:1');
    });

    it('continues when required report is missing', () => {
      const ctx = createContext({
        pendingPlanSteps: [],
        hasReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('report_missing');
    });

    it('does not continue when report is missing but not required', () => {
      const ctx = createContext({
        pendingPlanSteps: [],
        hasReport: false,
        requiresReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('task_complete');
    });

    it('stops phase sessions after a handoff is accepted even when work appears pending', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          flags: {
            securityops: {
              activePhaseId: 'phase-1',
              activePhaseKey: 'recon',
              phaseHandoffSubmitted: true,
              phaseHandoffStatus: 'completed',
            },
          },
        } as any,
        pendingPlanSteps: [{ id: 'step-1' }],
        hasReport: false,
        requiresReport: true,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('phase_handoff_submitted');
    });

    it('allows reporting sessions to continue after handoff when final artifacts are still missing', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          flags: {
            securityops: {
              activePhaseId: 'phase-reporting',
              activePhaseKey: 'reporting',
              phaseHandoffSubmitted: true,
              phaseHandoffStatus: 'completed',
            },
          },
        } as any,
        pendingPlanSteps: [],
        hasReport: false,
        requiresReport: true,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('report_missing');
    });

    it('continues phase sessions until submit_phase_handoff is accepted', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          flags: {
            securityops: {
              activePhaseId: 'phase-validation',
              activePhaseKey: 'validation',
              phaseHandoffSubmitted: false,
            },
          },
        } as any,
        pendingPlanSteps: [],
        hasReport: false,
        requiresReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('phase_handoff_missing');
      expect(decision.message).toContain('submit_phase_handoff');
    });

    it('continues an automated run planner that reached max_tool_calls before submit_plan', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          agentType: 'planner',
          mode: 'automated',
          flags: {
            securityops: {
              runId: 'run-1',
              activePhaseKey: 'planning',
            },
          },
        } as any,
        turnStatus: 'max_tool_calls',
        pendingPlanSteps: [],
        hasReport: true,
        requiresReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('planner_submit_required');
      expect(decision.reason).not.toContain('phase_handoff_missing');
      expect(decision.message).toContain('Call submit_plan now');
    });

    it('continues exposure verification toward its terminal tool, never submit_plan', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          agentType: 'planner',
          mode: 'automated',
          flags: {
            securityops: {
              runId: 'run-exposure',
              activePhaseKey: 'planning',
              runTrigger: 'exposure_verification',
            },
          },
        } as any,
        turnStatus: 'max_tool_calls',
        pendingPlanSteps: [],
        hasReport: true,
        requiresReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('exposure_verification');
      expect(decision.message).toContain('submit_exposure_verification');
      expect(decision.message).toContain('Do not call submit_plan');
      expect(decision.message).not.toContain('Call submit_plan now');
    });

    it('stops planner submit continuation once the planner has submitted a plan', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          agentType: 'planner',
          completed: true,
          flags: {
            securityops: {
              runId: 'run-1',
            },
            session: {
              completed: true,
            },
            plannerSubmitRetry: {
              count: 1,
            },
          },
        } as any,
        turnStatus: 'completed',
        pendingPlanSteps: [],
        hasReport: true,
        requiresReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('session_completed');
    });

    it('never continues a completed session from stale handoff and report state', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          completed: true,
          flags: {
            session: { completed: true },
            securityops: {
              runId: 'run-1',
              activePhaseId: 'phase-reporting',
              activePhaseKey: 'reporting',
              phaseHandoffSubmitted: false,
            },
          },
        } as any,
        pendingPlanSteps: [{ id: 'stale-step' }],
        hasReport: false,
        requiresReport: true,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('session_completed');
      expect(decision.reason).not.toContain('phase_handoff_missing');
    });

    it('backs off without blocking after fast planner submit continuations are exhausted', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          agentType: 'planner',
          flags: {
            securityops: {
              runId: 'run-1',
            },
            plannerSubmitRetry: {
              count: 3,
            },
          },
        } as any,
        turnStatus: 'max_tool_calls',
        pendingPlanSteps: [],
        hasReport: true,
        requiresReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('planner_submit_required');
      expect(decision.delayMs).toBe(30_000);
      expect(decision.payload).toEqual(
        expect.objectContaining({
          degradedBackoff: true,
          fastContinuationBudget: 3,
        }),
      );
    });

    it('keeps verification-specific terminal nudges on degraded backoff', () => {
      const base = createContext();
      const ctx = createContext({
        session: {
          ...base.session,
          agentType: 'planner',
          flags: {
            securityops: {
              runId: 'run-exposure',
              runTrigger: 'exposure_verification',
            },
            plannerSubmitRetry: { count: 3 },
          },
        } as any,
        turnStatus: 'max_tool_calls',
        requiresReport: false,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('continue');
      expect(decision.reason).toContain('planner_submit_required:exposure_verification');
      expect(decision.message).toContain('submit_exposure_verification');
      expect(decision.message).toContain('Do not call submit_plan');
      expect(decision.delayMs).toBe(30_000);
    });

    it('treats undefined pendingPlanSteps as empty', () => {
      const ctx = createContext({
        pendingPlanSteps: undefined as unknown as PendingPlanStep[],
        hasReport: true,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('task_complete');
    });
  });

  describe('Priority 7: task complete', () => {
    it('stops when no pending steps and report exists', () => {
      const ctx = createContext({
        pendingPlanSteps: [],
        hasReport: true,
      });

      const decision = engine.decide(ctx);

      expect(decision.action).toBe('stop');
      expect(decision.reason).toContain('task_complete');
    });
  });
});
