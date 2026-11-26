import { describe, expect, it } from 'vitest';
import {
  deriveCloseoutStates,
  describeCloseout,
} from '@/domains/security-ops/runs/closeoutStates';

/**
 * D23 — in production run r1 the human-facing summary said RunCompletion `not_ready` because
 * operator input was needed, while the finalizer returned `runCompletionState: 'completed'`,
 * `finalized: true`, `mode: 'interim'`.
 *
 * Both were right about different things: execution completed, the assessment did not reach a
 * conclusion, the artifacts were written, the findings were left unresolved. One field called
 * `completed` cannot carry four facts, and a reader will take the wrong one.
 */
describe('run closeout states', () => {
  it('separates the four facts the r1 closeout conflated', () => {
    const states = deriveCloseoutStates({
      runCompletionState: 'completed',
      finalized: true,
      mode: 'interim',
      operatorInputRequired: true,
      reportableFindingCount: 0,
      unresolvedFindingCount: 2,
    });

    expect(states).toEqual({
      executionState: 'completed',
      assessmentState: 'needs_operator_input',
      artifactState: 'finalized',
      findingDispositionState: 'unresolved',
    });
  });

  it('reads as final only when the assessment actually concluded', () => {
    const states = deriveCloseoutStates({
      runCompletionState: 'completed',
      finalized: true,
      mode: 'final',
      reportableFindingCount: 3,
      unresolvedFindingCount: 0,
    });

    expect(states.assessmentState).toBe('final');
    expect(states.findingDispositionState).toBe('resolved');
  });

  it('keeps a run that is still executing out of every terminal reading', () => {
    const states = deriveCloseoutStates({ runCompletionState: 'running' });

    expect(states.executionState).toBe('running');
    expect(states.assessmentState).toBe('in_progress');
    expect(states.artifactState).toBe('absent');
  });

  it('maps the legacy not_ready onto execution rather than assessment', () => {
    // `not_ready` was a statement about the assessment wearing an execution field's name.
    const states = deriveCloseoutStates({ runCompletionState: 'not_ready', operatorInputRequired: true });

    expect(states.executionState).toBe('running');
    expect(states.assessmentState).toBe('needs_operator_input');
  });

  it('calls artifacts partial when only one of the two exists', () => {
    expect(deriveCloseoutStates({ summaryWritten: true }).artifactState).toBe('partial');
    expect(deriveCloseoutStates({ reportWritten: true }).artifactState).toBe('partial');
    expect(deriveCloseoutStates({ summaryWritten: true, reportWritten: true }).artifactState).toBe('finalized');
  });

  it('distinguishes a run with no findings from one with unresolved findings', () => {
    expect(deriveCloseoutStates({}).findingDispositionState).toBe('none');
    expect(deriveCloseoutStates({ unresolvedFindingCount: 1 }).findingDispositionState).toBe('unresolved');
  });

  it('treats an aborted run as aborted, not completed', () => {
    const states = deriveCloseoutStates({ runCompletionState: 'aborted', mode: 'interim' });

    expect(states.executionState).toBe('aborted');
    expect(states.assessmentState).toBe('interim');
  });

  it('describes all four so a reader cannot take the wrong one', () => {
    const description = describeCloseout(deriveCloseoutStates({
      runCompletionState: 'completed',
      finalized: true,
      mode: 'interim',
      operatorInputRequired: true,
      unresolvedFindingCount: 2,
    }));

    expect(description).toBe(
      'execution completed; assessment needs_operator_input; artifacts finalized; findings unresolved',
    );
  });

  it('is a pure function of its inputs', () => {
    const input = { runCompletionState: 'completed', mode: 'interim', unresolvedFindingCount: 1 };

    expect(deriveCloseoutStates(input)).toEqual(deriveCloseoutStates(input));
  });
});
