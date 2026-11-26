import { describe, expect, it } from 'vitest';
import {
  messageReducer,
  initialMessageState,
  messageSelectors,
  type MessageState,
} from './messageSlice';

describe('messageReducer', () => {
  it('adds and updates messages', () => {
    const added = messageReducer(initialMessageState, {
      type: 'messages/add',
      payload: {
        id: 'm1',
        role: 'assistant',
        content: 'Hi',
        status: 'sent',
        timestamp: new Date(),
      },
    });
    expect(added.items).toHaveLength(1);

    const updated = messageReducer(added, {
      type: 'messages/updateStatus',
      payload: { id: 'm1', status: 'error' },
    });
    expect(updated.items[0].status).toBe('error');

    const appended = messageReducer(updated, {
      type: 'messages/appendContent',
      payload: { id: 'm1', content: ' there' },
    });
    expect(appended.items[0].content).toBe('Hi there');
  });

  it('merges into existing or creates fallback', () => {
    const base = messageReducer(initialMessageState, {
      type: 'messages/add',
      payload: {
        id: 'm1',
        role: 'assistant',
        content: 'Hello',
        status: 'sent',
        timestamp: new Date(),
      },
    });

    const merged = messageReducer(base, {
      type: 'messages/merge',
      payload: { targetId: 'm1', patch: { content: 'Updated' }, nextId: 'm1b' },
    });
    expect(merged.items[0]).toMatchObject({ id: 'm1b', content: 'Updated' });

    const fallback = messageReducer(initialMessageState, {
      type: 'messages/merge',
      payload: { targetId: 'missing', patch: { content: 'Fallback' } },
    });
    expect(fallback.items[0]).toMatchObject({
      id: 'missing',
      content: 'Fallback',
      role: 'assistant',
      status: 'sent',
    });
  });

  it('sets and clears items', () => {
    const set = messageReducer(initialMessageState, {
      type: 'messages/set',
      payload: [
        {
          id: 'm2',
          role: 'user',
          content: 'Ping',
          status: 'sent',
          timestamp: new Date(),
        },
      ],
    });
    expect(set.items).toHaveLength(1);

    const cleared = messageReducer(set, { type: 'messages/clear' });
    expect(cleared.items).toHaveLength(0);
  });
});

describe('messageSelectors', () => {
  it('selects items and finds by id', () => {
    const state: MessageState = {
      items: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Hello',
          status: 'sent',
          timestamp: new Date(),
        },
      ],
    };
    expect(messageSelectors.all(state)).toHaveLength(1);
    expect(messageSelectors.byId(state, 'm1')?.content).toBe('Hello');
  });
});
