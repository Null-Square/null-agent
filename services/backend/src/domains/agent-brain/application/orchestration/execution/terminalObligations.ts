/**
 * D11 and D12 — mandatory terminal obligations outrank a productivity yield.
 *
 * Two guard-ordering defects in production run r1, the same shape twice:
 *
 * - `phase_handoff_missing` fired **six times**. Recon is representative: preflight reported
 *   every mandatory condition satisfied, the turn spent its remaining tool budget on
 *   ingestion, and ended without calling `submit_phase_handoff`. The automation opened a
 *   second turn purely to re-run preflight and make the call preflight had already approved.
 *
 * - Reporting Turn 1 read its methodology, ran the finalizer preflight, prepared context and
 *   read the brief. Then `context.diminishing_returns_nudge` fired and the turn ended —
 *   **before `summary.md` or `report.md` existed**. The guard noticed `report_missing` and
 *   opened Turn 2.
 *
 * A turn that still owes a required artifact or an approved terminal call is not eligible to
 * yield on productivity grounds. It is eligible to yield once it has been given a bounded
 * chance to discharge that obligation and has not — otherwise a stuck phase would never end.
 */

import type { SessionState } from '../../../domain/types';

export type TerminalObligationKind =
  /** A phase whose plan is complete has not made the terminal call preflight approved. */
  | 'phase_handoff_missing'
  /** A phase that must produce a report has not written it. */
  | 'report_artifacts_missing';

export interface TerminalObligation {
  kind: TerminalObligationKind;
  /** The tool that discharges it, named so the nudge can be specific. */
  dischargeTool: string;
  detail: string;
};

/**
 * How many further model calls a turn may spend discharging an obligation before a yield is
 * allowed anyway. Small on purpose: the work is one tool call, not a new phase of thinking.
 */
export const TERMINAL_OBLIGATION_GRACE_CALLS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readSecurityOpsFlags = (session: SessionState | undefined): Record<string, unknown> => {
  const flags = session?.flags;
  return isRecord(flags) && isRecord(flags.securityops) ? flags.securityops : {};
};

const readActivePhaseKey = (session: SessionState | undefined): string | null => {
  const value = readSecurityOpsFlags(session).activePhaseKey;
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
};

export interface TerminalObligationInputs {
  session: SessionState | undefined;
  /** True when this session must produce a customer report before it can close. */
  requiresReport: boolean;
  /**
   * True when the required report artifacts already exist. Omitted means "read it from the
   * session", which is what a turn in flight has to do — the authoritative artifact scan
   * happens after the turn ends.
   */
  hasReport?: boolean;
  /** Plan steps still outstanding. A phase with pending work owes nothing terminal yet. */
  pendingPlanStepCount: number;
  /**
   * Plan steps in total. A session with no plan at all has no completion signal, so it must
   * not be read as a session whose plan is complete — `pendingPlanStepCount === 0` is true of
   * both, and only one of them owes a handoff.
   */
  totalPlanStepCount: number;
};

/** `session.flags.artifacts.hasReport`, the signal a turn in flight can see. */
export const sessionHasReportArtifact = (session: SessionState | undefined): boolean => {
  const artifacts = session?.flags?.artifacts;
  return isRecord(artifacts) && artifacts.hasReport === true;
};

/** Plan steps still awaiting work. A step that errored or is blocked is not pending work. */
const SETTLED_PLAN_STEP_STATUSES = new Set(['completed', 'blocked', 'error', 'cancelled']);

export const countPlanSteps = (session: SessionState | undefined): number =>
  Array.isArray(session?.plan) ? session.plan.length : 0;

export const countPendingPlanSteps = (session: SessionState | undefined): number => {
  const plan = session?.plan;
  if (!Array.isArray(plan)) return 0;
  return plan.filter((step) => {
    const status = isRecord(step) && typeof step.status === 'string' ? step.status : 'pending';
    return !SETTLED_PLAN_STEP_STATUSES.has(status);
  }).length;
};;

/**
 * The one outstanding mandatory obligation, or null when the turn is free to yield.
 *
 * Report artifacts are checked first: a phase that owes its customer-facing output owes that
 * before it owes a handoff, and closing the phase without it is the worse outcome.
 */
export const findTerminalObligation = (
  inputs: TerminalObligationInputs,
): TerminalObligation | null => {
  const { session, requiresReport, pendingPlanStepCount, totalPlanStepCount } = inputs;
  const hasReport = inputs.hasReport ?? sessionHasReportArtifact(session);

  if (requiresReport && !hasReport) {
    return {
      kind: 'report_artifacts_missing',
      dischargeTool: 'file_write',
      detail: 'This session must write its required report artifacts before it can yield.',
    };
  }

  const activePhaseKey = readActivePhaseKey(session);
  if (
    activePhaseKey !== null
    && activePhaseKey !== 'planning'
    && readSecurityOpsFlags(session).phaseHandoffSubmitted !== true
    && totalPlanStepCount > 0
    && pendingPlanStepCount === 0
  ) {
    return {
      kind: 'phase_handoff_missing',
      dischargeTool: 'submit_phase_handoff',
      detail:
        `The ${activePhaseKey} phase plan is complete but the phase is not closed. `
        + 'Close it in this turn rather than yielding and being reopened.',
    };
  }

  return null;
};

export interface ObligationYieldDecision {
  /** True when the turn may yield despite the obligation, because the grace is spent. */
  mayYield: boolean;
  obligation: TerminalObligation | null;
  graceCallsUsed: number;
  graceCallsAllowed: number;
};

/**
 * Decides whether a productivity yield may proceed.
 *
 * `modelCallsSinceObligation` is how many model calls have already run while this obligation
 * stood. Once the grace is spent the turn yields anyway: a phase that cannot close must not
 * become a phase that never ends.
 */
export const decideObligationYield = (
  obligation: TerminalObligation | null,
  modelCallsSinceObligation: number,
  graceCallsAllowed: number = TERMINAL_OBLIGATION_GRACE_CALLS,
): ObligationYieldDecision => ({
  mayYield: obligation === null || modelCallsSinceObligation >= graceCallsAllowed,
  obligation,
  graceCallsUsed: Math.max(0, modelCallsSinceObligation),
  graceCallsAllowed,
});

/** The nudge a turn is given instead of being allowed to yield. */
export const buildTerminalObligationNudge = (obligation: TerminalObligation): string =>
  `${obligation.detail} Call ${obligation.dischargeTool} now. Do not stop for any other reason `
  + 'until this is done.';
