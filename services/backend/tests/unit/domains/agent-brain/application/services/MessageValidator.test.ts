import { describe, it, expect } from 'vitest';
import { MessageValidator, MessageIntegrityError } from '@/domains/agent-brain/application/services/MessageValidator';

const validator = new MessageValidator();
const assistantWithCall = (id: string) =>
  ({
    id: `a-${id}`,
    role: 'assistant' as const,
    content: '',
    timestamp: Date.now(),
    tool_calls: [
      { id, type: 'function' as const, function: { name: 'fn', arguments: '{}' } },
    ],
  });

const toolResult = (id: string) =>
  ({
    id: `t-${id}`,
    role: 'tool' as const,
    content: 'result',
    timestamp: Date.now(),
    toolCallId: id,
  });

describe('MessageValidator.validate/assert', () => {
  it('passes valid assistant/tool pairing', () => {
    const messages = [assistantWithCall('1'), toolResult('1')];
    const res = validator.validate(messages as any);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('detects orphaned tool_call and tool result', () => {
    const messages = [
      assistantWithCall('1'), // no result
      toolResult('unknown'),  // orphan
    ];
    const res = validator.validate(messages as any);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Orphaned tool_call'))).toBe(true);
    expect(res.errors.some((e) => e.includes('Orphaned tool result'))).toBe(true);
  });

  it('throws MessageIntegrityError on assertValid with errors', () => {
    const messages = [assistantWithCall('1')]; // missing tool result
    expect(() => validator.assertValid(messages as any)).toThrow(MessageIntegrityError);
  });
});

describe('MessageValidator.repair', () => {
  it('removes duplicate message IDs', () => {
    const duplicate = assistantWithCall('dup');
    const messages = [duplicate, duplicate];
    const { messages: repaired, repairsApplied } = validator.repair(messages as any);
    // Duplicate assistant is removed; placeholder for missing tool result may be added
    expect(repaired.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(repairsApplied.some((r) => r.includes('Removed duplicate'))).toBe(true);
  });

  it('adds placeholder tool results for orphaned tool_calls', () => {
    const messages = [assistantWithCall('2')];
    const { messages: repaired, repairsApplied, recoveryEvents } = validator.repair(messages as any);
    const toolMessage = repaired.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(JSON.parse(toolMessage!.content)).toMatchObject({
      schema: 'interrupted-tool-result/v1',
      outcome: { kind: 'outcome_unknown', guidance: 'verify_before_retry' },
    });
    expect(recoveryEvents).toEqual([
      expect.objectContaining({
        source: 'message_validator',
        decision: 'outcome_unknown',
        compatibilityVersion: 'interrupted-tool-result/v1',
      }),
    ]);
    expect(repairsApplied.some((r) => r.includes('placeholder result'))).toBe(true);
  });

  it('upgrades a legacy blind-retry result without adding a second result', () => {
    const messages = [
      assistantWithCall('legacy'),
      {
        ...toolResult('legacy'),
        content: JSON.stringify({
          error: 'Tool execution was interrupted (session recovered after timeout or crash). Please retry the action.',
          recovered: true,
        }),
      },
    ];

    const { messages: repaired, recoveryEvents } = validator.repair(messages as any);
    const results = repaired.filter((message) => message.role === 'tool');
    expect(results).toHaveLength(1);
    expect(results[0]!.content).not.toContain('Please retry the action');
    expect(JSON.parse(results[0]!.content).outcome).toMatchObject({
      kind: 'outcome_unknown',
      guidance: 'verify_before_retry',
    });
    expect(recoveryEvents).toHaveLength(1);
  });
});







