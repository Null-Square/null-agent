import { describe, it, expect, vi } from 'vitest';
import { TelemetryRecorderAdapter } from '@/domains/agent-brain/adapters/TelemetryRecorderAdapter';

describe('TelemetryRecorderAdapter', () => {
  it('delegates init/write/close to the underlying recorder', async () => {
    const recorder = {
      init: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new TelemetryRecorderAdapter(recorder as any);
    const seed = { workspace: '/tmp/ws', tools: [], model: 'gpt-test' };

    await adapter.init('s1', seed as any);
    await adapter.write('s1', 2, { event: 'trace', payload: {} } as any);
    await adapter.close('s1', { terminal: 'session.done', status: 'completed', turns: 1 } as any);

    expect(recorder.init).toHaveBeenCalledWith('s1', seed);
    expect(recorder.write).toHaveBeenCalledWith('s1', 2, { event: 'trace', payload: {} });
    expect(recorder.close).toHaveBeenCalledWith('s1', {
      terminal: 'session.done',
      status: 'completed',
      turns: 1,
    });
  });
});
