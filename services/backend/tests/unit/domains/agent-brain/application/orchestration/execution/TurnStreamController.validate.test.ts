import { describe, it, expect } from 'vitest';
import { validateMessageStructure } from '@/domains/agent-brain/application/orchestration/execution/TurnStreamController';

const assistantToolCall = (id: string) => ({
  role: 'assistant' as const,
  content: '',
  tool_calls: [
    {
      id,
      type: 'function' as const,
      function: { name: 'fn', arguments: '{}' },
    },
  ],
});

const toolResult = (tool_call_id: string) => ({
  role: 'tool' as const,
  content: 'result',
  tool_call_id,
});

describe('validateMessageStructure', () => {
  it('passes when tool calls have matching results', () => {
    const messages = [
      assistantToolCall('tc-1'),
      toolResult('tc-1'),
    ];

    const result = validateMessageStructure(messages);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('flags missing tool_call_id on tool result', () => {
    const messages = [
      { role: 'tool' as const, content: 'result', tool_call_id: undefined as any },
    ];

    const result = validateMessageStructure(messages as any);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('invalid/missing tool_call_id'))).toBe(true);
  });

  it('flags orphan tool result', () => {
    const messages = [toolResult('unknown')];
    const result = validateMessageStructure(messages as any);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('Orphan tool result'))).toBe(true);
  });

  it('flags unresolved tool calls', () => {
    const messages = [assistantToolCall('tc-2')];
    const result = validateMessageStructure(messages as any);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('no corresponding result'))).toBe(true);
  });

  it('flags corrupted tool_call IDs and invalid assistant tool_call IDs', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'message[1].role', type: 'function' as const, function: { name: 'fn', arguments: '{}' } },
          { id: undefined as any, type: 'function' as const, function: { name: 'fn', arguments: '{}' } },
        ],
      },
    ];
    const result = validateMessageStructure(messages as any);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('Corrupted tool_call_id'))).toBe(true);
    expect(result.issues.some((i) => i.includes('invalid/missing ID'))).toBe(true);
  });
});







