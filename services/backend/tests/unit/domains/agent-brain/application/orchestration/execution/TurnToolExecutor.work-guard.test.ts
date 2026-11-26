import { describe, expect, it, vi } from 'vitest';
import { TurnToolExecutor } from '@/domains/agent-brain/application/orchestration/execution/TurnToolExecutor';

describe('TurnToolExecutor work continuation guard', () => {
  it('does not execute the next tool when work is cancelled', async () => {
    const toolsRegistry = {
      execute: vi.fn(),
    };
    const guard = {
      canContinue: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'aborted_by_user',
        boundary: 'tool_call',
        source: 'cancellation_marker',
      }),
    };
    const executor = new TurnToolExecutor({
      sessionStore: {
        get: vi.fn().mockReturnValue({
          id: 'session-1',
          flags: {},
          messages: [],
          plan: [],
          memory: {},
        }),
      } as any,
      toolsRegistry: toolsRegistry as any,
      workContinuationGuard: guard as any,
    });

    const result = await executor.run({
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tool-call-1',
          type: 'function',
          function: { name: 'shell_run', arguments: '{}' },
        } as any,
      ],
      stream: { raw: vi.fn(), done: vi.fn() } as any,
    });

    expect(result.status).toBe('aborted');
    expect(result.toolCallCount).toBe(0);
    expect(toolsRegistry.execute).not.toHaveBeenCalled();
  });
});
