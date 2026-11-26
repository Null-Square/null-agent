import { vi, describe, it, expect } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

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

describe('SessionStore invariants with tool_calls on abort', () => {
  it('preserves an unresolved assistant tool tail for journal repair after abort', async () => {
    const store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });
    await store.startTurnAsync(session.id, new AbortController());

    // Append assistant with orphaned tool_call
    await (store as any).appendMessageAsync(session.id, {
      id: 'a1',
      role: 'assistant',
      content: 'partial',
      timestamp: now,
      tool_calls: [
        { id: 'tc-orphan', type: 'function', function: { name: 'fn', arguments: '{}' } },
      ],
    });

    await store.abortCurrentTurnAsync(session.id, 'user_aborted');

    // Force idle status to validate invariant (normal code sets status elsewhere)
    await (store as any).updateSessionAsync(session.id, async (s: any) => {
      s.status = 'idle';
      return s;
    });

    const updated = store.get(session.id)!;
    const last = updated.messages[updated.messages.length - 1] as any;

    expect(last.role).toBe('assistant');
    expect(last.tool_calls).toEqual([
      { id: 'tc-orphan', type: 'function', function: { name: 'fn', arguments: '{}' } },
    ]);
  });
});







