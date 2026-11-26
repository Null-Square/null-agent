import { describe, expect, it, vi } from 'vitest';

import { evaluateFocusedDispositionOutcomeGate } from '@/domains/agent-brain/adapters/tools/builtins/phase/shared';

const context = (securityops: Record<string, unknown>) => ({
  sessionId: 'session',
  sessionStore: {
    get: vi.fn(() => ({
      id: 'session',
      flags: { securityops },
    })),
  },
}) as any;

describe('focused finding disposition handoff gate', () => {
  it('does not affect ordinary validation sessions', () => {
    expect(evaluateFocusedDispositionOutcomeGate(
      context({ activePhaseKey: 'validation' }),
      'validation',
    )).toBeNull();
  });

  it('blocks handoff until the focused outcome is accepted', () => {
    const flags = {
      activePhaseKey: 'validation',
      findingDispositionVerificationId: 'verification-1',
      findingId: 'finding-1',
      requestedRiskState: 'resolved',
      findingDispositionOutcomeSubmitted: false,
    };
    expect(evaluateFocusedDispositionOutcomeGate(
      context(flags),
      'validation',
    )).toMatchObject({
      code: 'missing_finding_disposition_outcome',
      suggestedTool: 'submit_finding_disposition_outcome',
    });
    expect(evaluateFocusedDispositionOutcomeGate(
      context({ ...flags, findingDispositionOutcomeSubmitted: true }),
      'validation',
    )).toBeNull();
  });
});
