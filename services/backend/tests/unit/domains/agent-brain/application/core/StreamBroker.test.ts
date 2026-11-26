import { describe, it, expect, vi } from 'vitest';
import { StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';

describe('StreamBroker', () => {
  it('redacts secrets in emitted events without mutating the original', () => {
    const broker = new StreamBroker();
    const received: any[] = [];
    broker.subscribe('s1', (event) => received.push(event));

    const secret = 'abcde12345fgh';
    const event: any = {
      type: 'message',
      data: {
        id: 'm1',
        role: 'assistant',
        content: `API_KEY=${secret}`,
        timestamp: 1,
      },
    };

    broker.emit('s1', event);

    expect(received).toHaveLength(1);
    expect(received[0].data.content).toContain(`API_KEY=${'*'.repeat(secret.length)}`);
    expect(event.data.content).toBe(`API_KEY=${secret}`);
  });

  it('removes failing subscribers and keeps others running', () => {
    const broker = new StreamBroker();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    broker.subscribe('s1', bad);
    broker.subscribe('s1', good);

    const event: any = { type: 'done' };
    broker.emit('s1', event);

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);

    broker.emit('s1', event);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes and cleans up sessions', () => {
    const broker = new StreamBroker();
    const callback = vi.fn();
    const unsubscribe = broker.subscribe('s1', callback);

    broker.emit('s1', { type: 'done' } as any);
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    broker.emit('s1', { type: 'done' } as any);
    expect(callback).toHaveBeenCalledTimes(1);

    broker.subscribe('s1', callback);
    broker.cleanupSession('s1');
    broker.emit('s1', { type: 'done' } as any);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('notifies global observers with the redacted event payload', () => {
    const broker = new StreamBroker();
    const observer = vi.fn();
    const unsubscribe = broker.observe(observer);

    broker.emit('s1', {
      type: 'session.status',
      data: {
        status: 'running',
        note: 'API_KEY=abcde12345fgh',
      },
    } as any);

    expect(observer).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'session.status',
        data: expect.objectContaining({
          status: 'running',
          note: expect.stringContaining('*************'),
        }),
      }),
    );

    unsubscribe();
    broker.emit('s1', { type: 'done' } as any);
    expect(observer).toHaveBeenCalledTimes(1);
  });
});
