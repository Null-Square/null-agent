export const EMPTY_COMPLETION_RETRY_MESSAGE =
  'Your previous response was empty or no-op. Continue the current task with a tool call or a meaningful completion message.';

export const DIMINISHING_RETURNS_NUDGE =
  'DIMINISHING RETURNS REPAIR: the last continuations produced little new signal. ' +
  'Before continuing, use the phase preflight tool, close the active lifecycle item, checkpoint with a blocker, or submit an interim/blocked handoff.';

export const RECOVERABLE_GUARD_NUDGE =
  'RECOVERABLE GUARD: a safety guard blocked the current pattern. Stop repeating that pattern. ' +
  'Move to a different evidence path, checkpoint the blocker, or submit the active phase handoff as interim/blocked if you cannot proceed.';

export type PrematureStopCorrectivePromptInput = {
  terminalKind?: string;
  isTerminal: boolean;
  activePhaseKey?: string | null;
  requiresReport: boolean;
};

export const buildPrematureStopCorrectivePrompt = (
  input: PrematureStopCorrectivePromptInput,
): string => {
  if (input.terminalKind === 'worker_result_submitted') {
    return 'Your worker result is already submitted and recorded. Do not call submit_worker_result again; stop this worker session.';
  }
  if (input.isTerminal) {
    return 'This session already submitted its terminal result. Do not call terminal tools again; stop this session.';
  }
  if (input.activePhaseKey && input.activePhaseKey !== 'reporting') {
    return 'You stopped before closing the active phase. If work remains, continue immediately with a tool call. If the phase is complete, call submit_phase_handoff with completed objectives, unresolved questions, artifacts, canonical writes, and evidence references.';
  }
  return input.requiresReport
    ? 'You stopped before all required tasks are complete. If there is still work to do, continue immediately with a tool call. If all tasks are truly finished, ensure approach.tried notes, run.digest, authored summary.md/report.md, and finalize_run_artifacts are complete, then stop.'
    : 'You stopped before the delegated task is complete. If work remains, continue immediately with a tool call. If the task is complete, submit_worker_result with a structured artifact and then stop.';
};
