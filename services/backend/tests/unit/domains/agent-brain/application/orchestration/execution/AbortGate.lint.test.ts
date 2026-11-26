import { describe, it, expect } from 'vitest';
import { AbortGate } from '@/domains/agent-brain/application/orchestration/execution/AbortGate';

describe('AbortGate API shape', () => {
  it('exposes controller signal and abort method', () => {
    const gate = new AbortGate();
    expect(gate.controller).toBeDefined();
    expect(typeof gate.abort).toBe('function');
    expect(typeof gate.onKill).toBe('function');
  });
});







