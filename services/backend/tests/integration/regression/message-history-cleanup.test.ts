import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Message History Cleanup Regression Tests
 * 
 * P0/P1/P2 FIX (Dec 2025):
 * Verifies control-plane events don't pollute conversation history.
 */

import { TurnToolExecutor } from '@/domains/agent-brain/application/orchestration/execution/TurnToolExecutor';
import { deriveStatus } from '@/domains/agent-brain/domain/types';

// ============================================================================
// TEST 1: deriveStatus correctly handles all blockedReason values
// ============================================================================

describe('deriveStatus blockedReason handling', () => {
  it('returns paused for credits_exhausted', () => {
    expect(deriveStatus({ stateMachine: { isProcessing: () => false }, blockedReason: 'credits_exhausted' })).toBe('paused');
  });

  it('returns paused for guard_exhausted', () => {
    expect(deriveStatus({ stateMachine: { isProcessing: () => false }, blockedReason: 'guard_exhausted' })).toBe('paused');
  });

  it('returns paused for awaiting_user', () => {
    // Note: 'deadlock' isn't a known blocked reason, will be treated as unknown
    // For actual deadlock scenarios, use 'guard_exhausted'
    expect(deriveStatus({ stateMachine: { isProcessing: () => false }, blockedReason: 'awaiting_user' })).toBe('paused');
  });

  it('returns paused for any unknown blockedReason', () => {
    // Unknown blocked reasons are treated as generic paused state
    expect(deriveStatus({ stateMachine: { isProcessing: () => false }, blockedReason: 'some_custom_reason' })).toBe('paused');
  });

  it('returns idle when no blockedReason and not processing', () => {
    expect(deriveStatus({ stateMachine: { isProcessing: () => false } })).toBe('idle');
  });

  it('returns running when isProcessing=true and no blockedReason', () => {
    expect(deriveStatus({ stateMachine: { isProcessing: () => true } })).toBe('running');
  });

  it('returns paused when pendingApproval is set', () => {
    expect(deriveStatus({ 
      stateMachine: { isProcessing: () => false },
      pendingApproval: { toolCallId: 'tc1' } 
    })).toBe('paused');
  });
});

// ============================================================================
// TEST 2: TurnToolExecutor repeated-call recovery behavior
// ============================================================================

describe('TurnToolExecutor repeated-call skip event', () => {
  it('emits skipped tool_result SSE event and does NOT call appendMessageAsync', async () => {
    const appendMock = vi.fn().mockResolvedValue(undefined);
    const rawMock = vi.fn();
    const doneMock = vi.fn();

    const executor = new TurnToolExecutor({
      sessionStore: {
        get: vi.fn().mockReturnValue({ id: 's1', messages: [] }),
        appendMessageAsync: appendMock,
        heartbeat: vi.fn(),
      } as any,
      toolsRegistry: {
        execute: vi.fn().mockResolvedValue({ ok: true }),
        executeWithReceipt: vi.fn().mockResolvedValue({
          result: { ok: true },
          receipt: {
            schema: 'tool-execution-receipt/v1',
            toolName: 'test_tool',
            toolCallId: 'tc1',
            outcome: 'succeeded',
          },
        }),
      } as any,
    });

    const stream = { message: vi.fn(), done: doneMock, raw: rawMock } as any;
    const toolCall = { id: 'tc1', function: { name: 'test_tool', arguments: '{}' } } as any;

    // Repeated identical calls are detected within a single run. The third call
    // is skipped with a tool result instead of freezing the session.
    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [toolCall, toolCall, toolCall],
      stream,
    });

    // Assertions
    expect(result.status).toBeUndefined();
    expect(result.doneEmitted).toBeUndefined();
    expect(result.skippedToolCalls).toEqual([
      expect.objectContaining({
        toolName: 'test_tool',
        reason: 'repeated_identical_tool_call',
      }),
    ]);
    
    // P0/P2 FIX: No assistant message was persisted
    expect(appendMock).not.toHaveBeenCalled();
    
    // SSE skip result was emitted
    expect(rawMock).toHaveBeenCalledWith('tool_result', expect.objectContaining({
      name: 'test_tool',
      result: expect.objectContaining({
        reason: 'repeated_identical_tool_call',
      }),
    }));
    expect(doneMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// TEST 3: sanitizeForLLM behavior (inline implementation test)
// ============================================================================

describe('sanitizeForLLM invariants', () => {
  // Mirror of the sanitizeForLLM function from pipeline.ts
  function sanitizeForLLM(messages: any[]): any[] {
    if (messages.length === 0) return messages;
    const result: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const curr = messages[i];
      const prev = result[result.length - 1];

      // Skip empty assistant messages without tool_calls
      if (curr.role === 'assistant') {
        const hasContent = curr.content && curr.content.trim().length > 0;
        const hasToolCalls = curr.tool_calls?.length > 0;
        if (!hasContent && !hasToolCalls) continue;
      }

      // Collapse consecutive assistant messages
      if (prev?.role === 'assistant' && curr.role === 'assistant') {
        prev.content = [prev.content || '', curr.content || ''].filter(Boolean).join('\n\n');
        if (curr.tool_calls?.length > 0) {
          prev.tool_calls = [...(prev.tool_calls ?? []), ...curr.tool_calls];
        }
        continue;
      }

      // Skip identical consecutive
      if (prev && prev.role === curr.role && prev.content === curr.content) continue;

      result.push({ ...curr });
    }
    return result;
  }

  it('removes empty assistant messages without tool_calls', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'response' },
    ];
    const result = sanitizeForLLM(messages);
    expect(result.length).toBe(2);
    expect(result[1].content).toBe('response');
  });

  it('keeps empty assistant messages WITH tool_calls', () => {
    const messages = [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1' }] },
    ];
    const result = sanitizeForLLM(messages);
    expect(result.length).toBe(2);
    expect(result[1].tool_calls).toBeDefined();
  });

  it('collapses consecutive assistant messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'First' },
      { role: 'assistant', content: 'Second' },
      { role: 'assistant', content: 'Third' },
    ];
    const result = sanitizeForLLM(messages);
    expect(result.length).toBe(2);
    expect(result[1].content).toContain('First');
    expect(result[1].content).toContain('Second');
    expect(result[1].content).toContain('Third');
  });

  it('merges tool_calls when collapsing consecutive assistants', () => {
    const messages = [
      { role: 'user', content: 'do stuff' },
      { role: 'assistant', content: 'A', tool_calls: [{ id: 'tc1' }] },
      { role: 'assistant', content: 'B', tool_calls: [{ id: 'tc2' }] },
    ];
    const result = sanitizeForLLM(messages);
    expect(result.length).toBe(2);
    expect(result[1].tool_calls.length).toBe(2);
    expect(result[1].tool_calls[0].id).toBe('tc1');
    expect(result[1].tool_calls[1].id).toBe('tc2');
  });

  it('preserves user-assistant alternation when valid', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    const result = sanitizeForLLM(messages);
    expect(result.length).toBe(4);
    expect(result.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});







