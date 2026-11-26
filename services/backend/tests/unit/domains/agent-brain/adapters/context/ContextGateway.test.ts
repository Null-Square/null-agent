import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextGateway } from '@/domains/agent-brain/adapters/context';

describe('ContextGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds soft sections from taskBlocks', async () => {
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) } as any;
    const gateway = new ContextGateway(traceRecorder);

    const result = await gateway.getContext('session-1', 2, {
      taskBlocks: [' task one ', ' ', 'task two'],
    });

    expect(result.hard).toBe('');
    expect(result.soft).toContain('## TASK CONTEXT');
    expect(result.soft).toContain('task one');
    expect(result.soft).toContain('task two');
    expect(traceRecorder.write).not.toHaveBeenCalled();
  });

  it('returns empty soft when no taskBlocks are provided', async () => {
    const gateway = new ContextGateway();

    const result = await gateway.getContext('session-1', 1, {});

    expect(result).toEqual({ hard: '', soft: undefined });
  });

  it('returns empty short rules header', async () => {
    const gateway = new ContextGateway();

    const result = await gateway.getShortRulesHeader();

    expect(result).toEqual({ hard: '' });
  });
});
