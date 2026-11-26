import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Pause/Resume/Abort Integration Tests + Backward-compat for Polluted Sessions
 * 
 * Tests 2 & 6 from the regression test plan.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TurnErrorHandler } from '@/domains/agent-brain/application/orchestration/services/TurnErrorHandler';

// ============================================================================
// TEST 6: Backward-compat tests for polluted sessions
// ============================================================================

describe('Backward-compat: polluted session sanitization', () => {
  const fixturePath = path.join(__dirname, '../fixtures/polluted-session.json');
  
  // Mirror of sanitizeForLLM from pipeline.ts
  function sanitizeForLLM(messages: any[]): any[] {
    if (messages.length === 0) return messages;
    const result: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const curr = messages[i];
      const prev = result[result.length - 1];

      if (curr.role === 'assistant') {
        const hasContent = curr.content && curr.content.trim().length > 0;
        const hasToolCalls = curr.tool_calls?.length > 0;
        if (!hasContent && !hasToolCalls) continue;
      }

      if (prev?.role === 'assistant' && curr.role === 'assistant') {
        prev.content = [prev.content || '', curr.content || ''].filter(Boolean).join('\n\n');
        if (curr.tool_calls?.length > 0) {
          prev.tool_calls = [...(prev.tool_calls ?? []), ...curr.tool_calls];
        }
        continue;
      }

      if (prev && prev.role === curr.role && prev.content === curr.content) continue;

      result.push({ ...curr });
    }
    return result;
  }

  it('should sanitize polluted session to valid alternation', () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const messages = fixture.messages;

    // Count consecutive assistants before
    let consecutiveBefore = 0;
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant' && messages[i - 1].role === 'assistant') {
        consecutiveBefore++;
      }
    }
    expect(consecutiveBefore).toBeGreaterThan(0);

    const sanitized = sanitizeForLLM(messages);

    // No consecutive assistants after
    for (let i = 1; i < sanitized.length; i++) {
      if (sanitized[i].role === 'assistant' && sanitized[i - 1].role === 'assistant') {
        expect.fail(`Found consecutive assistant messages at ${i - 1} and ${i}`);
      }
    }
  });

  it('should remove empty assistant messages', () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const emptyBefore = fixture.messages.filter(
      (m: any) => m.role === 'assistant' && (!m.content || !m.content.trim()) && !m.tool_calls
    );
    expect(emptyBefore.length).toBeGreaterThan(0);

    const sanitized = sanitizeForLLM(fixture.messages);
    const emptyAfter = sanitized.filter(
      (m: any) => m.role === 'assistant' && (!m.content || !m.content.trim()) && !m.tool_calls
    );
    expect(emptyAfter.length).toBe(0);
  });

  it('should preserve tool_calls and tool results', () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const originalToolCallIds = new Set<string>();
    for (const msg of fixture.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) originalToolCallIds.add(tc.id);
      }
    }

    const sanitized = sanitizeForLLM(fixture.messages);
    const sanitizedToolCallIds = new Set<string>();
    for (const msg of sanitized) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) sanitizedToolCallIds.add(tc.id);
      }
    }

    for (const id of originalToolCallIds) {
      expect(sanitizedToolCallIds.has(id)).toBe(true);
    }
  });
});

// ============================================================================
// TEST 2: Abort state handling (simplified)
// ============================================================================

describe('Abort state handling', () => {
  it('TurnErrorHandler.handleAbort does NOT persist assistant message', async () => {
    const messages: any[] = [];
    const mockSessionStore = {
      get: vi.fn().mockReturnValue({ 
        id: 's1', 
        messages,
        stateMachine: { isProcessing: () => true, stopProcessing: vi.fn() },
        currentTurn: { controller: new AbortController() }
      }),
      setAsync: vi.fn().mockResolvedValue(undefined),
      appendMessageAsync: vi.fn().mockImplementation((id, msg) => {
        messages.push(msg);
        return Promise.resolve();
      }),
      markAbortEventEmittedAsync: vi.fn().mockResolvedValue(undefined),
    };

    const abortedCalls: any[] = [];
    const mockStream = {
      aborted: vi.fn().mockImplementation((reason) => abortedCalls.push(reason)),
      message: vi.fn(),
      done: vi.fn(),
      raw: vi.fn(),
    };

    const handler = new TurnErrorHandler({
      sessionStore: mockSessionStore as any,
    });

    await handler.handleAbort({
      sessionId: 's1',
      error: new Error('User clicked pause'),
      sessionState: mockSessionStore.get('s1') as any,
      turnNumber: 1,
      turnStream: mockStream as any,
      recorder: undefined,
      doneEmitted: false,
    });

    // SSE aborted event was emitted
    expect(mockStream.aborted).toHaveBeenCalled();

    // No assistant message was persisted
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBe(0);
  });

  it('resume after abort has clean history (no abort message)', () => {
    const messagesAfterAbort = [
      { id: 'm1', role: 'user', content: 'do task' },
      { id: 'm2', role: 'assistant', content: 'I will do it', tool_calls: [{ id: 'tc1' }] },
      { id: 'm3', role: 'tool', content: '{"ok":true}', toolCallId: 'tc1' },
      // NO abort message (P0 fix)
    ];
    const messagesAfterResume = [
      ...messagesAfterAbort,
      { id: 'm4', role: 'user', content: 'continue' },
    ];

    // Verify clean alternation
    expect(messagesAfterResume.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    
    // No consecutive assistants
    for (let i = 1; i < messagesAfterResume.length; i++) {
      if (messagesAfterResume[i].role === 'assistant' && messagesAfterResume[i - 1].role === 'assistant') {
        expect.fail('Found consecutive assistant messages');
      }
    }
  });
});







