import { describe, it, expect, vi } from 'vitest';
import { ContextGatewayAdapter } from '@/domains/agent-brain/adapters/ContextGatewayAdapter';

describe('ContextGatewayAdapter', () => {
  it('delegates context calls with normalized turn', async () => {
    const gateway = {
      getContext: vi.fn().mockResolvedValue({ hard: '', soft: 's' }),
      getShortRulesHeader: vi.fn().mockResolvedValue({ hard: '' }),
    };
    const adapter = new ContextGatewayAdapter(undefined, gateway as any);

    const result = await adapter.getContext({
      sessionId: 's1',
      taskBlocks: ['a'],
      extraContext: 'extra',
    });

    expect(gateway.getContext).toHaveBeenCalledWith('s1', 1, {
      extraContext: 'extra',
      taskBlocks: ['a'],
    });
    expect(result).toEqual({ hard: '', soft: 's' });
  });

  it('passes through short rules requests', async () => {
    const gateway = {
      getContext: vi.fn().mockResolvedValue({ hard: '' }),
      getShortRulesHeader: vi.fn().mockResolvedValue({ hard: '' }),
    };
    const adapter = new ContextGatewayAdapter(undefined, gateway as any);

    const result = await adapter.getShortRules();

    expect(gateway.getShortRulesHeader).toHaveBeenCalled();
    expect(result).toEqual({ hard: '' });
  });
});
