import { describe, expect, it } from 'vitest';

import {
  buildInterruptedToolRecoveryProjection,
  INTERRUPTED_TOOL_RECOVERY_EVENT_SCHEMA,
  INTERRUPTED_TOOL_RESULT_SCHEMA,
  readInterruptedToolOutcome,
  repairUnsafeInterruptedToolResult,
  resolveInterruptedToolOutcome,
  type InterruptedToolExecutionEvidence,
} from '@/domains/agent-brain/domain/recovery/interruptedToolResult';

describe('interrupted tool result recovery projection', () => {
  it('allows retry only when durable evidence explicitly proves dispatch did not start', () => {
    const projection = buildInterruptedToolRecoveryProjection({
      toolCallId: 'call-not-started',
      source: 'behavior_lab_live_repair',
      evidence: {
        dispatchState: 'not_started',
        evidenceRef: 'ledger://session-1/call-not-started/dispatch',
      },
    });

    expect(projection.result).toMatchObject({
      schema: INTERRUPTED_TOOL_RESULT_SCHEMA,
      recovered: true,
      success: false,
      outcome: {
        kind: 'not_started',
        guidance: 'may_retry',
        evidenceRef: 'ledger://session-1/call-not-started/dispatch',
      },
    });
    expect(projection.event).toEqual({
      schema: INTERRUPTED_TOOL_RECOVERY_EVENT_SCHEMA,
      toolCallId: 'call-not-started',
      source: 'behavior_lab_live_repair',
      decision: 'not_started',
      compatibilityVersion: INTERRUPTED_TOOL_RESULT_SCHEMA,
      evidenceRef: 'ledger://session-1/call-not-started/dispatch',
    });
    expect(projection.content).not.toContain('Please retry the action');
  });

  it.each([
    ['started without terminal result', { dispatchState: 'started', evidenceRef: 'ledger://claim' }],
    ['missing evidence', undefined],
    ['malformed not-started evidence', { dispatchState: 'not_started', evidenceRef: '  ' }],
  ])('projects %s as outcome unknown', (_label, evidence) => {
    expect(resolveInterruptedToolOutcome(
      evidence as unknown as InterruptedToolExecutionEvidence | undefined,
    )).toMatchObject({
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
    });
  });

  it('reads and upgrades the legacy blind-retry placeholder as outcome unknown', () => {
    const legacy = JSON.stringify({
      error: 'Tool execution was interrupted (session recovered after timeout or crash). Please retry the action.',
      recovered: true,
    });

    expect(readInterruptedToolOutcome(legacy)).toEqual({
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
    });
    const upgraded = repairUnsafeInterruptedToolResult({
      toolCallId: 'legacy-call',
      content: legacy,
      source: 'message_validator',
    });
    expect(upgraded?.result.outcome).toEqual({
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
    });
    expect(upgraded?.content).not.toContain('Please retry the action');
  });

  it('downgrades a malformed current result instead of trusting unsupported retry guidance', () => {
    const malformed = JSON.stringify({
      schema: INTERRUPTED_TOOL_RESULT_SCHEMA,
      recovered: true,
      success: false,
      outcome: { kind: 'not_started', guidance: 'may_retry' },
    });

    expect(readInterruptedToolOutcome(malformed)).toEqual({
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
    });
    expect(repairUnsafeInterruptedToolResult({
      toolCallId: 'malformed-call',
      content: malformed,
      source: 'turn_stream_sanitizer',
    })?.result.outcome).toEqual({
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
    });
  });
});
