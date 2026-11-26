/**
 * D23 — one word doing four jobs.
 *
 * In production run r1 the human-facing summary said RunCompletion `not_ready`, because
 * operator input was needed. The finalizer returned `runCompletionState: 'completed'`,
 * `finalized: true`, `mode: 'interim'`.
 *
 * Both are correct about different things. Execution completed. The assessment did not reach
 * a conclusion. The artifacts were written. The findings were left unresolved. A reader with
 * one field called `completed` cannot tell which of those it means, and a dashboard reading it
 * will get it wrong.
 *
 * These are four independent facts and this module keeps them four.
 */

/** Did the run finish running? Nothing about what it found. */
export type ExecutionState = 'running' | 'completed' | 'aborted' | 'failed';

/** Did the security assessment reach a conclusion? */
export type AssessmentState =
  /** Still working. */
  | 'in_progress'
  /** Concluded, and the conclusions are supported. */
  | 'final'
  /** Concluded as far as it could; something remains unproven. */
  | 'interim'
  /** Cannot conclude without a human supplying something. */
  | 'needs_operator_input';

/** Were the customer-facing artifacts written? */
export type ArtifactState = 'absent' | 'partial' | 'finalized';

/** Do the findings have settled dispositions? */
export type FindingDispositionState = 'none' | 'unresolved' | 'resolved';

export interface RunCloseoutStates {
  executionState: ExecutionState;
  assessmentState: AssessmentState;
  artifactState: ArtifactState;
  findingDispositionState: FindingDispositionState;
}

export interface CloseoutStateInputs {
  /** The legacy single field, kept so nothing downstream has to change at once. */
  runCompletionState?: string | null;
  finalized?: boolean;
  /** `interim` or `final`. */
  mode?: string | null;
  operatorInputRequired?: boolean;
  reportableFindingCount?: number;
  unresolvedFindingCount?: number;
  summaryWritten?: boolean;
  reportWritten?: boolean;
}

const EXECUTION_BY_LEGACY: Record<string, ExecutionState> = {
  completed: 'completed',
  running: 'running',
  aborted: 'aborted',
  failed: 'failed',
  not_ready: 'running',
};

/**
 * Derives the four states from what the finalizer already knows. Pure, so a report, a
 * dashboard and an API response cannot disagree about what a run's closeout means.
 */
export const deriveCloseoutStates = (inputs: CloseoutStateInputs): RunCloseoutStates => {
  const legacy = (inputs.runCompletionState ?? '').trim().toLowerCase();
  const executionState = EXECUTION_BY_LEGACY[legacy] ?? 'running';

  const assessmentState: AssessmentState = (() => {
    if (inputs.operatorInputRequired === true) return 'needs_operator_input';
    if (executionState === 'running') return 'in_progress';
    if (inputs.mode === 'final') return 'final';
    if (inputs.mode === 'interim') return 'interim';
    return executionState === 'completed' ? 'interim' : 'in_progress';
  })();

  const artifactState: ArtifactState = (() => {
    if (inputs.finalized === true) return 'finalized';
    if (inputs.reportWritten === true && inputs.summaryWritten === true) return 'finalized';
    if (inputs.reportWritten === true || inputs.summaryWritten === true) return 'partial';
    return 'absent';
  })();

  const findingDispositionState: FindingDispositionState = (() => {
    const unresolved = inputs.unresolvedFindingCount ?? 0;
    const reportable = inputs.reportableFindingCount ?? 0;
    if (unresolved > 0) return 'unresolved';
    if (reportable > 0) return 'resolved';
    return 'none';
  })();

  return { executionState, assessmentState, artifactState, findingDispositionState };
};

/** One sentence that cannot be misread as the other three facts. */
export const describeCloseout = (states: RunCloseoutStates): string =>
  `execution ${states.executionState}; assessment ${states.assessmentState}; `
  + `artifacts ${states.artifactState}; findings ${states.findingDispositionState}`;
