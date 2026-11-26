import { describe, expect, it, vi } from 'vitest';
import { aiChatReducer, initialState, type AIChatState } from './chatReducer';

vi.mock('@modules/chat/store/utils', () => ({
  generateMessageId: vi.fn(() => 'gen-1'),
}));

describe('aiChatReducer', () => {
  it('adds messages with generated ids and timestamps', () => {
    const next = aiChatReducer(initialState, {
      type: 'ADD_MESSAGE',
      payload: { role: 'user', content: 'hi', status: 'sent' },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].id).toBe('gen-1');
    expect(next.messages[0].timestamp).toBeInstanceOf(Date);
  });

  it('appends message content and merges missing messages', () => {
    const base: AIChatState = {
      ...initialState,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Hello',
          status: 'sent',
          timestamp: new Date(),
        },
      ],
    };

    const appended = aiChatReducer(base, {
      type: 'APPEND_MESSAGE_CONTENT',
      id: 'm1',
      content: ' world',
    });
    expect(appended.messages[0].content).toBe('Hello world');

    const merged = aiChatReducer(initialState, {
      type: 'MERGE_MESSAGE',
      targetId: 'missing',
      patch: { content: 'Fallback', role: 'assistant' },
    });
    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]).toMatchObject({
      id: 'missing',
      content: 'Fallback',
      role: 'assistant',
      status: 'sent',
    });
  });

  it('updates plan steps and trims activity', () => {
    const withPlan: AIChatState = {
      ...initialState,
      plan: [{ id: 'step-1', title: 'Plan', status: 'pending' }],
    };

    const updated = aiChatReducer(withPlan, {
      type: 'PLAN_STEP_UPDATED',
      payload: { id: 'step-1', status: 'completed' },
    });
    expect(updated.plan[0].status).toBe('completed');

    const added = aiChatReducer(initialState, {
      type: 'PLAN_STEP_UPDATED',
      payload: { id: 'step-2', title: 'New', status: 'running' },
    });
    expect(added.plan).toHaveLength(1);

    const activitySeed = Array.from({ length: 25 }, (_, i) => ({
      id: `a-${i}`,
      sessionId: 'session-1',
      ts: Date.now() + i,
      kind: 'warning' as const,
      status: 'pending' as const,
      title: `Activity ${i}`,
      source: 'system' as const,
      importance: 'low' as const,
    }));
    const trimmed = aiChatReducer(
      { ...initialState, activity: activitySeed as AIChatState['activity'] },
      {
        type: 'PUSH_ACTIVITY',
        payload: {
          id: 'a-25',
          sessionId: 'session-1',
          ts: Date.now() + 25,
          kind: 'warning',
          status: 'success',
          title: 'New',
          source: 'system',
          importance: 'medium',
        },
      },
    );
    expect(trimmed.activity).toHaveLength(25);
    expect(trimmed.activity[24].id).toBe('a-25');
  });

  it('manages tool streams', () => {
    const reset = aiChatReducer(initialState, {
      type: 'RESET_TOOL_STREAM',
      tool: 'shell',
      command: 'ls',
    });
    expect(reset.toolStreams.shell).toMatchObject({
      name: 'shell',
      status: 'running',
      command: 'ls',
    });

    const appended = aiChatReducer(reset, {
      type: 'APPEND_TOOL_STREAM',
      tool: 'shell',
      chunk: 'output',
    });
    expect(appended.toolStreams.shell.chunks).toEqual(['output']);

    const completed = aiChatReducer(appended, {
      type: 'COMPLETE_TOOL_STREAM',
      tool: 'shell',
      status: 'completed',
      result: { success: true },
    });
    expect(completed.toolStreams.shell).toMatchObject({
      status: 'completed',
      result: { success: true },
    });
  });
});
