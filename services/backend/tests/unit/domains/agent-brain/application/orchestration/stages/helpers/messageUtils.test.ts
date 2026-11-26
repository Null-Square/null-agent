import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@/domains/agent-brain/application/orchestration/stages/helpers/messageUtils';
import type { Message } from '@/domains/agent-brain/domain/types';

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: 'msg-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  ...overrides,
});

describe('messageUtils.estimateTokens', () => {
  it('keeps the existing text heuristic for string content', () => {
    expect(estimateTokens(baseMessage({ content: 'Hello world' }))).toBe(3);
  });

  it('counts assistant tool calls even when content is empty or null', () => {
    const message = baseMessage({
      content: null as unknown as string,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'query_inventory',
            arguments: JSON.stringify({ mode: 'list', includeServices: true }),
          },
        },
      ],
    });

    expect(estimateTokens(message)).toBeGreaterThan(10);
  });

  it('scales with serialized tool call payload size', () => {
    const small = baseMessage({
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'file_read', arguments: '{"path":"a.txt"}' },
        },
      ],
    });
    const large = baseMessage({
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'file_read', arguments: JSON.stringify({ path: 'a.txt', note: 'x'.repeat(800) }) },
        },
      ],
    });

    expect(estimateTokens(large)).toBeGreaterThan(estimateTokens(small));
  });

  it('counts text inside multimodal content blocks', () => {
    const message = baseMessage({
      content: [
        { type: 'text', text: 'first text block' },
        { type: 'text', text: 'second text block with more words' },
      ] as unknown as string,
    });

    expect(estimateTokens(message)).toBeGreaterThan(5);
  });
});
