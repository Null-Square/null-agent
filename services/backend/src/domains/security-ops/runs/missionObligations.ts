/**
 * D13 — deterministic plan invariants must not be discovered by expensive model trial.
 *
 * The replan in production run r1 was rejected twice before it succeeded: nine occurrences of
 * *"cannot remove unfinished mission obligations: task-final"* and eight of *"submit_plan
 * blocked: skill routing is missing"*, with two `submit_plan.gate_blocked` events. That cost
 * roughly 414k input tokens, 28k output tokens and several minutes.
 *
 * Both are schema invariants the system can evaluate before it dispatches. Skill routing was
 * already checked locally and returned a repairable result; the mission-obligation rule was
 * only enforced downstream, where it threw. One invariant, two shapes of rejection.
 *
 * This module is the shared rule, so `submit_plan` can refuse repairably and the workflow
 * service can keep throwing as a backstop.
 */

/** The parts of a run phase this rule reads. */
export interface MissionObligationPhase {
  /** Present once a phase has been dispatched to a session. */
  sessionId?: string | null;
  status: string;
  stepIds: readonly string[];
}

/**
 * Mission ids a replan may not drop: those belonging to phases that are still pending and
 * have never been dispatched. A phase that already ran has had its obligation discharged.
 */
export const collectUnfinishedMissionObligations = (
  phases: readonly MissionObligationPhase[],
): string[] => Array.from(new Set(
  phases
    .filter((phase) => !phase.sessionId && phase.status === 'pending')
    .flatMap((phase) => phase.stepIds),
));

/** Unfinished obligations the revised plan no longer carries. Empty means the replan is legal. */
export const findOmittedMissionObligations = (
  phases: readonly MissionObligationPhase[],
  revisedMissionIds: Iterable<string>,
): string[] => {
  const revised = new Set(revisedMissionIds);
  return collectUnfinishedMissionObligations(phases)
    .filter((missionId) => !revised.has(missionId));
};

/** One message, so the local refusal and the downstream backstop read identically. */
export const buildOmittedMissionObligationsMessage = (omitted: readonly string[]): string =>
  `Replan cannot remove unfinished mission obligations: ${omitted.join(', ')}. `
  + 'Keep each stable mission id and revise its objective, evidence, or blocker handling in place.';
