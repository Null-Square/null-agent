import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

// Silence logger noise for unit tests
vi.mock('@/shared/logger', () => {
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  childLogger.child.mockImplementation(() => childLogger);
  return { logger: { child: vi.fn(() => childLogger) } };
});

const now = Date.now();

const assistantWithToolCalls = {
  id: 'a1',
  role: 'assistant' as const,
  content: 'running tool',
  timestamp: now,
  tool_calls: [
    {
      id: 'tc-bad-json',
      type: 'function' as const,
      function: { name: 'fn', arguments: '{"open":' }, // malformed JSON
    },
    {
      id: 'tc-no-result',
      type: 'function' as const,
      function: { name: 'fn', arguments: '{}' }, // no matching tool result
    },
    {
      id: 'tc-ok',
      type: 'function' as const,
      function: { name: 'fn', arguments: '{}' }, // has a result message
    },
  ],
};

const toolResult = {
  id: 't1',
  role: 'tool' as const,
  content: 'output',
  timestamp: now - 100,
  toolCallId: 'tc-ok',
};

describe('SessionStore abort history preservation', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  it('preserves every accepted tool call for deterministic journal repair', async () => {
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });
    await store.startTurnAsync(session.id, new AbortController());

    // Seed a valid tool result earlier in the history
    await (store as any).appendMessageAsync(session.id, toolResult);
    // Assistant message with mixed tool_calls as the last message
    await (store as any).appendMessageAsync(session.id, assistantWithToolCalls);

    await store.abortCurrentTurnAsync(session.id, 'user_aborted');

    const updated = store.get(session.id);
    expect(updated).toBeDefined();
    const last = updated!.messages[updated!.messages.length - 1] as any;

    expect(last.role).toBe('assistant');
    expect(last.tool_calls).toEqual(assistantWithToolCalls.tool_calls);
  });

  it('does not erase an unresolved tool tail when a turn is aborted', async () => {
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });
    await store.startTurnAsync(session.id, new AbortController());

    await (store as any).appendMessageAsync(session.id, {
      id: 'assistant2',
      role: 'assistant',
      content: 'broken tool calls',
      timestamp: now,
      tool_calls: [
        { id: 'tc-bad', type: 'function', function: { name: 'fn', arguments: '{' } }, // malformed
        { id: 'tc-orphan', type: 'function', function: { name: 'fn', arguments: '{}' } }, // no result
      ],
    });

    await store.abortCurrentTurnAsync(session.id, 'user_aborted');

    const updated = store.get(session.id)!;
    const last = updated.messages[updated.messages.length - 1] as any;

    expect(last.role).toBe('assistant');
    expect(last.tool_calls).toHaveLength(2);
    expect(last.tool_calls.map((call: any) => call.id)).toEqual(['tc-bad', 'tc-orphan']);
  });

  it('leaves messages untouched when last message is not assistant', async () => {
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });
    await store.startTurnAsync(session.id, new AbortController());

    await (store as any).appendMessageAsync(session.id, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: now,
    });

    await store.abortCurrentTurnAsync(session.id, 'user_aborted');

    const updated = store.get(session.id)!;
    const last = updated.messages[updated.messages.length - 1];
    expect(last.role).toBe('user');
  });
});







