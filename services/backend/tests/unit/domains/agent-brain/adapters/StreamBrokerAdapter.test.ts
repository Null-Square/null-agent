import { describe, it, expect, vi } from 'vitest';
import { StreamBrokerAdapter } from '@/domains/agent-brain/adapters/StreamBrokerAdapter';

describe('StreamBrokerAdapter', () => {
  it('delegates emit and subscribe when supported', () => {
    const broker = {
      emit: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const adapter = new StreamBrokerAdapter(broker as any);
    const event = { type: 'message', data: { role: 'assistant', content: 'hi' } } as any;

    adapter.emit('s1', event);
    const unsubscribe = adapter.subscribe('s1', vi.fn());

    expect(broker.emit).toHaveBeenCalledWith('s1', event);
    expect(broker.subscribe).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(unsubscribe).toEqual(expect.any(Function));
  });

  it('falls back to emit for plan updates and cleanupSession when needed', () => {
    const broker = {
      emit: vi.fn(),
      cleanupSession: vi.fn(),
    };
    const adapter = new StreamBrokerAdapter(broker as any);
    const plan = [{ id: 'a', status: 'pending' }] as any;

    adapter.emitPlan('s1', plan);
    adapter.cleanup('s1');

    expect(broker.emit).toHaveBeenCalledWith('s1', { type: 'plan_update', data: plan });
    expect(broker.cleanupSession).toHaveBeenCalledWith('s1');
  });

  it('uses specialized emitPlan/cleanup methods when present', () => {
    const broker = {
      emit: vi.fn(),
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    };
    const adapter = new StreamBrokerAdapter(broker as any);
    const plan = [{ id: 'b', status: 'completed' }] as any;

    adapter.emitPlan('s1', plan);
    adapter.cleanup('s1');

    expect(broker.emitPlan).toHaveBeenCalledWith('s1', plan);
    expect(broker.cleanup).toHaveBeenCalledWith('s1');
  });
});
