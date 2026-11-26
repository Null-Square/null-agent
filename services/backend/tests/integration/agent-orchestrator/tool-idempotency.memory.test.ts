import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Tool idempotency (in-memory, no DB required).
 *
 * Uses a simple in-memory ToolExecutionPort to prove:
 * - First run with a toolCallId executes the side effect once.
 * - Replay with the same toolCallId returns cached result and does NOT re-run side effects.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  ToolExecutionPort,
  ToolExecutionRecord,
} from '@/domains/agent-brain/ports';

const createInMemoryToolPort = () => {
  const executions = new Map<string, ToolExecutionRecord>();

  const port: ToolExecutionPort = {
    async findByToolCallId(_sessionId: string, toolCallId: string) {
      return executions.get(toolCallId);
    },
    async create(input) {
      if (executions.has(input.toolCallId)) {
        return executions.get(input.toolCallId)!;
      }
      const record: ToolExecutionRecord = {
        id: `exec-${input.toolCallId}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
        status: 'pending',
        startedAt: new Date(),
      };
      executions.set(input.toolCallId, record);
      return record;
    },
    async complete(input) {
      const record = executions.get(input.toolCallId);
      if (record) {
        record.status = 'completed';
        record.result = input.result;
        record.completedAt = new Date();
      }
    },
    async fail(input) {
      const record = executions.get(input.toolCallId);
      if (record) {
        record.status = 'failed';
        record.error = input.error;
        record.completedAt = new Date();
      }
    },
    async findBySession(_sessionId: string) {
      return Array.from(executions.values());
    },
    async findByTurn(_sessionId: string, _turnId: string) {
      return Array.from(executions.values()).filter((r) => r.turnId === _turnId);
    },
  };

  return { port, executions };
};

describe('Tool idempotency (memory)', () => {
  it('does not re-run side effects for the same toolCallId', async () => {
    const { port, executions } = createInMemoryToolPort();
    const sideEffects = new Map<string, number>();

    const runTool = async (toolCallId: string) => {
      const cached = await port.findByToolCallId('sess', toolCallId);
      if (cached?.status === 'completed') {
        return cached.result;
      }

      // Execute side effect once per unique toolCallId
      const count = (sideEffects.get(toolCallId) ?? 0) + 1;
      sideEffects.set(toolCallId, count);

      await port.create({
        sessionId: 'sess',
        turnId: 'turn1',
        toolCallId,
        toolName: 'test_tool',
        args: {},
      });
      await port.complete({ sessionId: 'sess', toolCallId, result: { ok: true, count }, durationMs: 5 });
      return { ok: true, count };
    };

    const toolCallId = uuidv4();

    // First run performs side effect
    const first = await runTool(toolCallId);
    expect(first).toEqual({ ok: true, count: 1 });
    expect(sideEffects.get(toolCallId)).toBe(1);
    expect(executions.get(toolCallId)?.status).toBe('completed');

    // Replay should NOT increment side effects
    const second = await runTool(toolCallId);
    expect(second).toEqual({ ok: true, count: 1 });
    expect(sideEffects.get(toolCallId)).toBe(1);

    // New toolCallId runs once independently
    const otherId = uuidv4();
    await runTool(otherId);
    expect(sideEffects.get(otherId)).toBe(1);
  });
});






