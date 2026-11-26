import { describe, expect, it } from 'vitest';
import {
  buildTerminalObligationNudge,
  countPendingPlanSteps,
  decideObligationYield,
  findTerminalObligation,
  sessionHasReportArtifact,
  TERMINAL_OBLIGATION_GRACE_CALLS,
} from '@/domains/agent-brain/application/orchestration/execution/terminalObligations';
import type { SessionState } from '@/domains/agent-brain/domain/types';

/**
 * D11 and D12 — the same guard-ordering defect twice in production run r1.
 *
 * `phase_handoff_missing` fired **six times**: preflight approved the close, the turn spent
 * its budget elsewhere and ended, and the automation opened a whole new turn to make one
 * tool call. Reporting Turn 1 yielded on `context.diminishing_returns_nudge` **before
 * `summary.md` or `report.md` existed**, and `report_missing` opened Turn 2.
 *
 * A turn that owes a required artifact or an approved terminal call is not eligible to yield
 * on productivity grounds — but the grace it gets must be bounded, or a phase that cannot
 * close becomes a phase that never ends.
 */
const session = (overrides: Record<string, unknown> = {}): SessionState => ({
  id: 'session-1',
  plan: [],
  flags: {},
  ...overrides,
} as unknown as SessionState);

const reportingSession = (overrides: Record<string, unknown> = {}) => session({
  flags: {
    securityops: { activePhaseKey: 'reporting' },
    ...(overrides.flags as Record<string, unknown> ?? {}),
  },
  ...overrides,
});

describe('terminal obligations outrank a productivity yield', () => {
  describe('finding the obligation', () => {
    it('names the missing report before anything else', () => {
      const obligation = findTerminalObligation({
        session: reportingSession(),
        requiresReport: true,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      });

      expect(obligation?.kind).toBe('report_artifacts_missing');
    });

    it('names the unmade handoff once the plan is complete', () => {
      const obligation = findTerminalObligation({
        session: session({ flags: { securityops: { activePhaseKey: 'recon' } } }),
        requiresReport: false,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      });

      expect(obligation?.kind).toBe('phase_handoff_missing');
      expect(obligation?.dischargeTool).toBe('submit_phase_handoff');
      expect(obligation?.detail).toContain('recon');
    });

    it('owes nothing while the plan still has work', () => {
      // A phase mid-flight is free to yield. This is what keeps the guard from becoming a
      // reason never to stop.
      expect(findTerminalObligation({
        session: session({ flags: { securityops: { activePhaseKey: 'recon' } } }),
        requiresReport: false,
        pendingPlanStepCount: 2,
        totalPlanStepCount: 4,
      })).toBeNull();
    });

    it('owes nothing once the handoff is submitted', () => {
      expect(findTerminalObligation({
        session: session({
          flags: { securityops: { activePhaseKey: 'recon', phaseHandoffSubmitted: true } },
        }),
        requiresReport: false,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      })).toBeNull();
    });

    it('owes nothing once the report exists', () => {
      expect(findTerminalObligation({
        session: reportingSession({ flags: { artifacts: { hasReport: true } } }),
        requiresReport: true,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      })).toBeNull();
    });

    it('does not read a session with no plan as a session whose plan is complete', () => {
      // Both have `pendingPlanStepCount: 0`; only one of them has actually finished a plan.
      expect(findTerminalObligation({
        session: session({ flags: { securityops: { activePhaseKey: 'validation' } } }),
        requiresReport: false,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 0,
      })).toBeNull();
    });

    it('never holds the planning phase open for a handoff it does not make', () => {
      expect(findTerminalObligation({
        session: session({ flags: { securityops: { activePhaseKey: 'planning' } } }),
        requiresReport: false,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      })).toBeNull();
    });

    it('lets a caller with a fresher artifact scan override the session flag', () => {
      // The authoritative scan runs after the turn; a turn in flight reads the flag. With the
      // report accounted for, what remains is the handoff — reporting still has to close.
      expect(findTerminalObligation({
        session: reportingSession(),
        requiresReport: true,
        hasReport: true,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      })?.kind).toBe('phase_handoff_missing');
    });

    it('owes nothing once both the report and the handoff are done', () => {
      expect(findTerminalObligation({
        session: reportingSession({
          flags: {
            securityops: { activePhaseKey: 'reporting', phaseHandoffSubmitted: true },
            artifacts: { hasReport: true },
          },
        }),
        requiresReport: true,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      })).toBeNull();
    });
  });

  describe('bounding the grace', () => {
    it('refuses the first yield while an obligation stands', () => {
      const obligation = findTerminalObligation({
        session: reportingSession(),
        requiresReport: true,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      });

      expect(decideObligationYield(obligation, 0).mayYield).toBe(false);
    });

    it('allows the yield once the grace is spent', () => {
      const obligation = findTerminalObligation({
        session: reportingSession(),
        requiresReport: true,
        pendingPlanStepCount: 0,
        totalPlanStepCount: 4,
      });

      expect(decideObligationYield(obligation, TERMINAL_OBLIGATION_GRACE_CALLS).mayYield).toBe(true);
    });

    it('always allows the yield when nothing is owed', () => {
      expect(decideObligationYield(null, 0).mayYield).toBe(true);
    });

    it('reports what it counted, so a trace can be read', () => {
      const decision = decideObligationYield(
        { kind: 'phase_handoff_missing', dischargeTool: 'submit_phase_handoff', detail: 'x' },
        1,
      );

      expect(decision).toMatchObject({
        mayYield: false,
        graceCallsUsed: 1,
        graceCallsAllowed: TERMINAL_OBLIGATION_GRACE_CALLS,
      });
    });
  });

  describe('reading the session', () => {
    it('counts only plan steps still awaiting work', () => {
      const withPlan = session({
        plan: [
          { id: 'a', status: 'completed' },
          { id: 'b', status: 'blocked' },
          { id: 'c', status: 'pending' },
          { id: 'd', status: 'running' },
          { id: 'e', status: 'error' },
        ],
      });

      expect(countPendingPlanSteps(withPlan)).toBe(2);
    });

    it('treats a session with no plan as owing no plan work', () => {
      expect(countPendingPlanSteps(session())).toBe(0);
      expect(countPendingPlanSteps(undefined)).toBe(0);
    });

    it('reads the report artifact flag without assuming its shape', () => {
      expect(sessionHasReportArtifact(session({ flags: { artifacts: { hasReport: true } } }))).toBe(true);
      expect(sessionHasReportArtifact(session({ flags: { artifacts: {} } }))).toBe(false);
      expect(sessionHasReportArtifact(session({ flags: { artifacts: 'yes' } }))).toBe(false);
      expect(sessionHasReportArtifact(undefined)).toBe(false);
    });
  });

  it('names the tool that discharges the obligation in the nudge', () => {
    const nudge = buildTerminalObligationNudge({
      kind: 'phase_handoff_missing',
      dischargeTool: 'submit_phase_handoff',
      detail: 'The recon phase plan is complete but the phase is not closed.',
    });

    expect(nudge).toContain('submit_phase_handoff');
    expect(nudge).toContain('recon');
  });
});
