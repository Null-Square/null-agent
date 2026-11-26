import { describe, expect, it } from 'vitest';

import {
  buildProviderAttemptIntegrityExpectations,
  buildToolTracePairingExpectations,
  reconcileTraceIntegrity,
} from '@/domains/agent-brain/infrastructure/telemetry';

describe('trace integrity reconciliation', () => {
  it('is complete only when every required evidence surface and high-water receipt agrees', () => {
    const toolEvents = Array.from({ length: 312 }, (_, index) => `call-${index + 1}`)
      .flatMap((toolCallId) => [
        { event: 'tool.start', toolCallId },
        { event: 'tool.finish', toolCallId },
      ]);
    const result = reconcileTraceIntegrity({
      sessionId: 'session-1',
      acceptedHighWater: 700,
      persistedHighWater: 700,
      terminalReceipt: true,
      expectations: [
        { surface: 'model_requests', id: 'request-1', present: true },
        { surface: 'tool_executions', id: 'call-1', present: true },
        { surface: 'messages', id: 'message-1', present: true },
        { surface: 'artifacts', id: 'artifact-1', present: true, valid: true },
        ...buildToolTracePairingExpectations(toolEvents),
      ],
    });
    expect(result.status).toBe('complete');
    expect(result.issues).toEqual([]);
    expect(result.surfaces).toMatchObject({
      model_requests: 'complete',
      tool_executions: 'complete',
      messages: 'complete',
      trace_events: 'complete',
      artifacts: 'complete',
      terminal_receipt: 'complete',
    });
  });

  it('names missing evidence as degraded and invalid evidence as failed', () => {
    const degraded = reconcileTraceIntegrity({
      sessionId: 'session-2',
      acceptedHighWater: 9,
      persistedHighWater: 8,
      terminalReceipt: false,
      expectations: [{ surface: 'tool_executions', id: 'call-missing', present: false }],
      rejectedWrites: [{ reason: 'closed', event: 'tool.finish', required: true }],
    });
    expect(degraded.status).toBe('degraded');
    expect(degraded.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'high_water_mismatch',
      'terminal_receipt_missing',
      'write_rejected_closed',
      'evidence_missing',
    ]));

    const failed = reconcileTraceIntegrity({
      sessionId: 'session-3',
      acceptedHighWater: 2,
      persistedHighWater: 2,
      terminalReceipt: true,
      expectations: [{
        surface: 'artifacts',
        id: 'artifact-corrupt',
        present: true,
        valid: false,
      }],
    });
    expect(failed.status).toBe('failed');
    expect(failed.issues).toContainEqual(expect.objectContaining({
      surface: 'artifacts',
      code: 'evidence_invalid',
      id: 'artifact-corrupt',
    }));
  });

  it('joins ordered attempts to one request and rejects a dangling retry decision', () => {
    const usage = {
      uncachedInput: 10,
      cacheRead: 2,
      cacheWrite: 3,
      output: 4,
      reasoning: 1,
      reasoningSource: 'reported' as const,
    };
    const valid = buildProviderAttemptIntegrityExpectations(['request-1'], [
      {
        requestId: 'request-1',
        attemptId: 'attempt-1',
        attemptOrdinal: 1,
        state: 'failed',
        retryDecision: 'retry',
        usage: { ...usage, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      },
      {
        requestId: 'request-1',
        attemptId: 'attempt-2',
        attemptOrdinal: 2,
        state: 'succeeded',
        retryDecision: 'stop',
        usage,
      },
    ]);
    expect(valid).toEqual([expect.objectContaining({
      surface: 'provider_attempts',
      present: true,
      valid: true,
    })]);

    const dangling = buildProviderAttemptIntegrityExpectations(['request-1'], [{
      requestId: 'request-1',
      attemptId: 'attempt-1',
      attemptOrdinal: 1,
      state: 'failed',
      retryDecision: 'retry',
      usage: { ...usage, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    }]);
    const result = reconcileTraceIntegrity({
      sessionId: 'session-attempts',
      acceptedHighWater: 0,
      persistedHighWater: 0,
      terminalReceipt: true,
      expectations: dangling,
    });
    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      surface: 'provider_attempts',
      code: 'evidence_invalid',
      id: 'request-attempts:request-1',
    }));
  });
});
