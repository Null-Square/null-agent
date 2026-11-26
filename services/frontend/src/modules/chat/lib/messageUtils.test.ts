import { describe, expect, it } from 'vitest';
import { toHydratedMessages } from './messageUtils';

describe('toHydratedMessages', () => {
  it('filters tool messages and tool-call payloads from history', () => {
    const now = Date.now();
    const messages = toHydratedMessages([
      { id: '1', role: 'user', content: 'Hello', createdAt: now },
      {
        id: '1-internal',
        role: 'user',
        content: 'Internal kickoff',
        createdAt: now,
        metadata: { visibility: 'internal' },
      },
      { id: '2', role: 'tool', content: '{"success":true}', createdAt: now },
      { id: '3', role: 'assistant', content: '{"success":true}', toolCallId: 'call-1', createdAt: now },
      { id: '4', role: 'assistant', content: 'All good', createdAt: now },
      { id: '5', role: 'assistant', content: '', tool_calls: [{ id: 'tc-1' }], createdAt: now },
    ]);

    expect(messages.map((message) => message.id)).toEqual(['1', '4']);
  });
});
