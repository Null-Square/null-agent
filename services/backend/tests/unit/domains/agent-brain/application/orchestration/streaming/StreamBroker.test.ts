import { describe, it, expect, vi } from 'vitest';
import { StreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';

describe('Orchestrator StreamBroker', () => {
  it('emits and traces helper events', () => {
    const emit = vi.fn();
    const trace = { event: vi.fn() };
    const broker = new StreamBroker(emit, trace);

    broker.messageStart({ role: 'assistant' });
    broker.token('hi');
    broker.message({ role: 'assistant', content: 'hi' });
    broker.messageEnd({ messageId: 'm1' });

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      { type: 'message_start', data: { role: 'assistant' } },
      { type: 'token', data: 'hi' },
      { type: 'message', data: expect.objectContaining({ role: 'assistant', content: 'hi' }) },
      { type: 'message_end', data: { messageId: 'm1' } },
    ]);

    expect(trace.event.mock.calls.map((call) => call[0])).toEqual([
      'message_start',
      'token',
      'message',
      'message_end',
    ]);
  });

  it('forwards events and traces data payloads', () => {
    const emit = vi.fn();
    const trace = { event: vi.fn() };
    const broker = new StreamBroker(emit, trace);
    const event = { type: 'plan_update', data: [{ id: 'a', status: 'pending' }] } as any;

    broker.forward(event);

    expect(emit).toHaveBeenCalledWith(event);
    expect(trace.event).toHaveBeenCalledWith('plan_update', [{ id: 'a', status: 'pending' }]);
  });

  it('does not throw when trace emission fails', () => {
    const emit = vi.fn();
    const trace = {
      event: vi.fn(() => {
        throw new Error('trace boom');
      }),
    };
    const broker = new StreamBroker(emit, trace);

    expect(() => broker.messageStart()).not.toThrow();
    expect(emit).toHaveBeenCalledWith({ type: 'message_start', data: { role: 'assistant' } });
  });
});
