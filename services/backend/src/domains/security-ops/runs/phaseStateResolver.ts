/**
 * D9 — one canonical answer to "where is this phase?".
 *
 * At the end of validation Turn 1 in production run r1 the lead queue was effectively
 * resolved: GraphQL false positive, the API and recon lead validated, IDOR blocked on
 * credentials, several leads superseded, the login hypothesis false positive. The turn
 * ended reporting `plan 0/4`, after 69 requested tools and more than 2.28M input tokens.
 *
 * The lead model believed the work was done. The plan model believed nothing was complete.
 * The automation continued because the handoff was missing, and Turn 2 spent a 127-second
 * call querying findings, a 101-second call rewriting a finding, another rejected outcome
 * submission and another long call — all to rediscover a state that is a pure function of
 * records the system already holds.
 *
 * This module is that function. It has no clock, no I/O and no model call.
 */

import type { EnumerationBlockerCodeV1 } from '@/domains/agent-brain/domain/types/session';

/** Lead statuses that are settled. Anything else is still open work. */
export const TERMINAL_LEAD_STATUSES = new Set([
  'validated',
  'false_positive',
  'blocked',
  'deferred',
  'superseded',
]);

/**
 * Blockers a human can clear. A phase held only by these is waiting on the operator, which
 * is a different thing from a phase that is still working.
 *
 * `satisfies` holds these against the vocabulary the enumeration contract defines, so a code
 * that is misspelled or retired fails the typecheck instead of silently never matching — a
 * blocker nobody recognises reads as "still working", which holds a finished phase open.
 */
const OPERATOR_RESOLVABLE_BLOCKER_CODES = [
  'credential_required',
  'auth_required',
  'account_state_required',
  'out_of_scope',
] as const satisfies readonly EnumerationBlockerCodeV1[];

export const OPERATOR_RESOLVABLE_BLOCKERS = new Set<string>(OPERATOR_RESOLVABLE_BLOCKER_CODES);

export interface PhaseLeadRecord {
  id: string;
  status: string;
  blockerCode?: string | null;
}

export interface PhasePlanStep {
  id: string;
  status: string;
  /** A step the phase cannot close without. Defaults to true. */
  mandatory?: boolean;
  /** Leads this step is satisfied by, when the plan names them. */
  leadIds?: readonly string[];
}

export interface PhaseFindingRecord {
  id: string;
  state: string;
  reportable: boolean;
}

export interface PhaseStateInputs {
  leads: readonly PhaseLeadRecord[];
  planSteps: readonly PhasePlanStep[];
  findings?: readonly PhaseFindingRecord[];
  /** Gate failures the phase's own preflight already computed. */
  gateFailureCodes?: readonly string[];
}

export type PhaseCompletionStatus =
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'needs_operator_input'
  /** Nothing is open, and some plan steps have no record explaining what settled them. */
  | 'needs_reconciliation';

/** What a plan step should say, given the leads that satisfy it. */
export interface PlanStepTransition {
  stepId: string;
  from: string;
  to: 'completed' | 'blocked';
  because: string;
}

export interface ResolvedPhaseState {
  status: PhaseCompletionStatus;
  /** True when nothing in the lead queue is still open. */
  allLeadsTerminal: boolean;
  openLeadIds: string[];
  blockedLeadIds: string[];
  operatorResolvableBlockers: string[];
  unresolvableBlockers: string[];
  /** Plan steps that do not yet agree with the leads that satisfy them. */
  planStepTransitions: PlanStepTransition[];
  /** Steps still incomplete after applying the transitions above. */
  remainingPlanStepIds: string[];
  /**
   * Steps that no lead claims and no record settles. Deriving these as completed would be
   * inventing orchestration state in TypeScript instead of in the model.
   */
  unmappedPlanStepIds: string[];
  reportableFindingCount: number;
  gateFailureCodes: string[];
  /** One sentence an operator or a model can act on without re-deriving anything. */
  reason: string;
}

const isTerminal = (status: string): boolean => TERMINAL_LEAD_STATUSES.has(status);

const isSettledStep = (status: string): boolean =>
  status === 'completed' || status === 'blocked' || status === 'cancelled';

/**
 * Derives the phase's position from the records that already exist. Pure: the same inputs
 * always give the same answer, so it can be recomputed anywhere without drifting.
 */
export const resolvePhaseState = (inputs: PhaseStateInputs): ResolvedPhaseState => {
  const leads = inputs.leads ?? [];
  const planSteps = inputs.planSteps ?? [];
  const findings = inputs.findings ?? [];
  const gateFailureCodes = [...(inputs.gateFailureCodes ?? [])];

  const openLeadIds = leads.filter((lead) => !isTerminal(lead.status)).map((lead) => lead.id);
  const blockedLeads = leads.filter((lead) => lead.status === 'blocked' || lead.status === 'deferred');
  const blockedLeadIds = blockedLeads.map((lead) => lead.id);

  const operatorResolvableBlockers = [...new Set(
    blockedLeads
      .map((lead) => lead.blockerCode)
      .filter((code): code is string => typeof code === 'string' && OPERATOR_RESOLVABLE_BLOCKERS.has(code)),
  )].sort();
  const unresolvableBlockers = [...new Set(
    blockedLeads
      .map((lead) => lead.blockerCode)
      .filter((code): code is string => typeof code === 'string' && !OPERATOR_RESOLVABLE_BLOCKERS.has(code)),
  )].sort();

  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const allLeadsTerminal = openLeadIds.length === 0;

  // A plan step that names its leads follows them.
  //
  // A step that names none is *not* implied by a settled queue. That inference read "every
  // lead finished" as "every task was done", and since the production adapter supplies no
  // lead references at all, it was the only branch that ever ran — so the resolver would have
  // reported all four r1 tasks complete on no evidence whatsoever. Replacing the model's
  // invented state with the resolver's own invented state is not a fix.
  //
  // An unexplained step is reported as unexplained.
  const planStepTransitions: PlanStepTransition[] = [];
  const unmappedPlanStepIds: string[] = [];
  for (const step of planSteps) {
    if (isSettledStep(step.status)) continue;

    const named = (step.leadIds ?? [])
      .map((id) => leadById.get(id))
      .filter((lead): lead is PhaseLeadRecord => lead !== undefined);

    if (named.length > 0) {
      if (named.some((lead) => !isTerminal(lead.status))) continue;
      const blocked = named.filter((lead) => lead.status === 'blocked' || lead.status === 'deferred');
      planStepTransitions.push(blocked.length === named.length
        ? {
          stepId: step.id,
          from: step.status,
          to: 'blocked',
          because: `every lead for this step is blocked (${blocked.map((lead) => lead.id).join(', ')})`,
        }
        : {
          stepId: step.id,
          from: step.status,
          to: 'completed',
          because: `all ${named.length} lead(s) for this step reached a terminal outcome`,
        });
      continue;
    }

    // The one safe inference: if every lead is blocked, nothing could have advanced this
    // step either. Blocked is a statement about what did not happen, so it invents nothing.
    if (allLeadsTerminal && leads.length > 0 && blockedLeads.length === leads.length) {
      planStepTransitions.push({
        stepId: step.id,
        from: step.status,
        to: 'blocked',
        because: 'the whole validation queue is blocked and this step names no leads of its own',
      });
      continue;
    }

    // An optional step holds nothing up and explains nothing either way.
    if (step.mandatory === false) continue;

    // A settled queue beside a step that names none of it is the r1 shape: something closed
    // this step and no record says what. That is a question, not a completion.
    if (allLeadsTerminal && leads.length > 0) {
      unmappedPlanStepIds.push(step.id);
      continue;
    }

    // No queue at all, or a queue still working: the step is simply outstanding work, and
    // `remainingPlanStepIds` below counts it as such.
  }

  const transitionById = new Map(planStepTransitions.map((entry) => [entry.stepId, entry]));
  const unmappedStepIds = new Set(unmappedPlanStepIds);
  const remainingPlanStepIds = planSteps
    .filter((step) => {
      if (isSettledStep(step.status)) return false;
      if (transitionById.has(step.id)) return false;
      // An unexplained step is reported on its own axis rather than counted as outstanding
      // work, because nothing here knows whether work remains or only the record does.
      if (unmappedStepIds.has(step.id)) return false;
      return step.mandatory !== false;
    })
    .map((step) => step.id);

  const reportableFindingCount = findings.filter((finding) => finding.reportable).length;

  const status: PhaseCompletionStatus = (() => {
    if (remainingPlanStepIds.length > 0 || !allLeadsTerminal) return 'in_progress';
    if (gateFailureCodes.length > 0) return 'blocked';
    if (unresolvableBlockers.length > 0) return 'blocked';
    if (operatorResolvableBlockers.length > 0) return 'needs_operator_input';
    // Nothing is open and nothing is blocked, but some steps have no record behind them.
    // That is not the same as done, and it must never be reported as done.
    if (unmappedPlanStepIds.length > 0) return 'needs_reconciliation';
    return 'completed';
  })();

  const reason = (() => {
    switch (status) {
      case 'in_progress':
        return openLeadIds.length > 0
          ? `${openLeadIds.length} validation lead(s) are still open`
          : `${remainingPlanStepIds.length} plan step(s) have no settled work behind them`;
      case 'blocked':
        return gateFailureCodes.length > 0
          ? `the phase gate refuses the handoff: ${gateFailureCodes.join(', ')}`
          : `blocked by ${unresolvableBlockers.join(', ')}`;
      case 'needs_operator_input':
        return unmappedPlanStepIds.length > 0
          ? `waiting on the operator for ${operatorResolvableBlockers.join(', ')}; `
            + `${unmappedPlanStepIds.length} plan step(s) name no lead and nothing records what settled them`
          : `waiting on the operator for ${operatorResolvableBlockers.join(', ')}`;
      case 'needs_reconciliation':
        return `${unmappedPlanStepIds.length} plan step(s) name no lead and nothing records what `
          + 'settled them; say what closed them rather than assuming the settled queue did';
      default:
        return 'every lead reached a terminal outcome and no gate refuses the handoff';
    }
  })();

  return {
    status,
    allLeadsTerminal,
    openLeadIds,
    blockedLeadIds,
    operatorResolvableBlockers,
    unresolvableBlockers,
    planStepTransitions,
    remainingPlanStepIds,
    unmappedPlanStepIds,
    reportableFindingCount,
    gateFailureCodes,
    reason,
  };
};
