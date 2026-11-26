import { vi, describe, it, expect } from 'vitest';
import { AbortGate } from '@/domains/agent-brain/application/orchestration/execution/AbortGate';

describe('AbortGate', () => {
  it('aborts controller and runs hooks', async () => {
    const gate = new AbortGate();
    const hook = vi.fn<() => void>(() => {});

    gate.onKill(hook);
    await gate.abort('test');

    expect(gate.controller.signal.aborted).toBe(true);
    // AbortController in Node 18+ exposes reason
    expect(gate.controller.signal.reason).toBe('test');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('swallows hook errors but continues', async () => {
    const gate = new AbortGate();
    const failing = vi.fn<() => void>(() => {
      throw new Error('boom');
    });
    const succeeding = vi.fn<() => void>(() => {});

    gate.onKill(failing);
    gate.onKill(succeeding);

    await gate.abort();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});







