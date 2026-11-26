import { describe, expect, it } from 'vitest';

import { buildPrematureStopCorrectivePrompt } from '@/domains/agent-brain/domain/prompts';

describe('correctionPrompts', () => {
  it('returns the worker terminal correction when a worker result was already submitted', () => {
    expect(
      buildPrematureStopCorrectivePrompt({
        terminalKind: 'worker_result_submitted',
        isTerminal: true,
        activePhaseKey: null,
        requiresReport: false,
      }),
    ).toBe('Your worker result is already submitted and recorded. Do not call submit_worker_result again; stop this worker session.');
  });

  it('returns the generic terminal correction for already completed sessions', () => {
    expect(
      buildPrematureStopCorrectivePrompt({
        terminalKind: 'run_finalized',
        isTerminal: true,
        activePhaseKey: null,
        requiresReport: true,
      }),
    ).toBe('This session already submitted its terminal result. Do not call terminal tools again; stop this session.');
  });

  it('returns the phase handoff correction for active non-reporting phases', () => {
    expect(
      buildPrematureStopCorrectivePrompt({
        isTerminal: false,
        activePhaseKey: 'validation',
        requiresReport: true,
      }),
    ).toBe('You stopped before closing the active phase. If work remains, continue immediately with a tool call. If the phase is complete, call submit_phase_handoff with completed objectives, unresolved questions, artifacts, canonical writes, and evidence references.');
  });

  it('returns the run-report correction when report artifacts are required', () => {
    expect(
      buildPrematureStopCorrectivePrompt({
        isTerminal: false,
        activePhaseKey: 'reporting',
        requiresReport: true,
      }),
    ).toBe('You stopped before all required tasks are complete. If there is still work to do, continue immediately with a tool call. If all tasks are truly finished, ensure approach.tried notes, run.digest, authored summary.md/report.md, and finalize_run_artifacts are complete, then stop.');
  });

  it('returns the worker completion correction when no report is required', () => {
    expect(
      buildPrematureStopCorrectivePrompt({
        isTerminal: false,
        activePhaseKey: null,
        requiresReport: false,
      }),
    ).toBe('You stopped before the delegated task is complete. If work remains, continue immediately with a tool call. If the task is complete, submit_worker_result with a structured artifact and then stop.');
  });
});
