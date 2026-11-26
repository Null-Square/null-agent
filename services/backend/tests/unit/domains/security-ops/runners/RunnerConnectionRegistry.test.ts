import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { RunnerConnectionRegistry } from '@/domains/security-ops/runners/RunnerConnectionRegistry';

class FakeWs extends EventEmitter {
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('RunnerConnectionRegistry', () => {
  it('registers and unregisters connections', () => {
    const registry = new RunnerConnectionRegistry();
    const ws = new FakeWs() as any;

    registry.register('runner-1', ws);
    expect(registry.isConnected('runner-1')).toBe(true);

    registry.unregister('runner-1', ws);
    expect(registry.isConnected('runner-1')).toBe(false);
  });

  it('resolves request when matching response arrives', async () => {
    const registry = new RunnerConnectionRegistry();
    const ws = new FakeWs() as any;
    registry.register('runner-1', ws);

    const promise = registry.request(
      'runner-1',
      { type: 'file_read', path: 'report.md' },
      { responseTypes: ['file_read_result'], timeoutMs: 1000 },
    );

    const sent = JSON.parse((ws as unknown as FakeWs).sent[0] || '{}');
    expect(typeof sent.requestId).toBe('string');

    registry.handleIncomingMessage(
      'runner-1',
      JSON.stringify({
        type: 'file_read_result',
        requestId: sent.requestId,
        content: 'ok',
      }),
    );

    await expect(promise).resolves.toMatchObject({
      type: 'file_read_result',
      content: 'ok',
    });
  });

  it('rejects request when runner disconnects', async () => {
    const registry = new RunnerConnectionRegistry();
    const ws = new FakeWs() as any;
    registry.register('runner-1', ws);

    const promise = registry.request(
      'runner-1',
      { type: 'file_read', path: 'report.md' },
      { responseTypes: ['file_read_result'], timeoutMs: 5000 },
    );

    registry.unregister('runner-1', ws);
    await expect(promise).rejects.toThrow('runner_disconnected');
  });
});
