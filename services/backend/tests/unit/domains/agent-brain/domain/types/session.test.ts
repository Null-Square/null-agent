import { describe, it, expect } from 'vitest';
import { deriveStatus } from '@/domains/agent-brain/domain/types';
import { deriveStatus as contractsDeriveStatus } from '@null-ai/contracts';

// Helper to create a mock stateMachine
const mockStateMachine = (isProcessing: boolean) => ({
  isProcessing: () => isProcessing,
});

describe('deriveStatus', () => {
  it('uses blockedReason when provided', () => {
    const result = deriveStatus({
      stateMachine: mockStateMachine(false),
      blockedReason: 'credits_exhausted',
    });

    const expected = contractsDeriveStatus({
      blockedReason: 'credits_exhausted',
      isProcessing: false,
    });
    expect(result).toBe(expected);
  });

  it('falls back to flags.blocked_reason when blockedReason is missing', () => {
    const result = deriveStatus({
      stateMachine: mockStateMachine(true),
      flags: { blocked_reason: 'guard_exhausted' },
    });

    const expected = contractsDeriveStatus({
      blockedReason: 'guard_exhausted',
      isProcessing: true,
    });
    expect(result).toBe(expected);
  });

  it('returns running when stateMachine.isProcessing() is true', () => {
    const result = deriveStatus({
      stateMachine: mockStateMachine(true),
    });
    expect(result).toBe('running');
  });

  it('returns idle when stateMachine.isProcessing() is false and no other conditions', () => {
    const result = deriveStatus({
      stateMachine: mockStateMachine(false),
    });
    expect(result).toBe('idle');
  });

  it('returns idle when stateMachine is undefined', () => {
    const result = deriveStatus({});
    expect(result).toBe('idle');
  });
});
