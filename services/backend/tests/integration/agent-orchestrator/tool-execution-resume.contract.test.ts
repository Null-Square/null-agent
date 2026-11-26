import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Tool execution resume contract (in-memory, no DB).
 *
 * Ensures:
 * - Completed execution is reused on resume (no new side effects).
 * - Failed execution allows retry and can be completed on subsequent run.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  ToolExecutionPort,
  ToolExecutionRecord,
} from '@/domains/agent-brain/ports';

const createInMemoryPort = () => {
  const records = new Map<string, ToolExecutionRecord>();

  const port: ToolExecutionPort = {
    async findByToolCallId(_sessionId: string, toolCallId: string) {
      return records.get(toolCallId);
    },
    async create(input) {
      const existing = records.get(input.toolCallId);
      if (existing) return existing;
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
      records.set(input.toolCallId, record);
      return record;
    },
    async complete(input) {
      const rec = records.get(input.toolCallId);
      if (rec) {
        rec.status = 'completed';
        rec.result = input.result;
        rec.completedAt = new Date();
        rec.durationMs = input.durationMs;
      }
    },
    async fail(input) {
      const rec = records.get(input.toolCallId);
      if (rec) {
        rec.status = 'failed';
        rec.error = input.error;
        rec.completedAt = new Date();
        rec.durationMs = input.durationMs;
      }
    },
    async findBySession(_sessionId: string) {
      return Array.from(records.values());
    },
    async findByTurn(_sessionId: string, turnId: string) {
      return Array.from(records.values()).filter((r) => r.turnId === turnId);
    },
  };

  return { port, records };
};

describe('Tool execution resume (idempotent + retry)', () => {
  it('reuses completed execution without re-running side effects', async () => {
    const { port } = createInMemoryPort();
    const toolCallId = uuidv4();
    const sideEffects = new Map<string, number>();

    const run = async () => {
      const existing = await port.findByToolCallId('sess', toolCallId);
      if (existing?.status === 'completed') {
        return existing.result;
      }
      const count = (sideEffects.get(toolCallId) ?? 0) + 1;
      sideEffects.set(toolCallId, count);
      await port.create({
        sessionId: 'sess',
        turnId: 'turn-1',
        toolCallId,
        toolName: 'test_tool',
        args: {},
      });
      await port.complete({ sessionId: 'sess', toolCallId, result: { ok: true, count }, durationMs: 5 });
      return { ok: true, count };
    };

    const first = await run();
    const second = await run(); // resume should reuse cached result

    expect(first).toEqual({ ok: true, count: 1 });
    expect(second).toEqual({ ok: true, count: 1 });
    expect(sideEffects.get(toolCallId)).toBe(1);
  });

  it('allows retry when previous execution failed', async () => {
    const { port } = createInMemoryPort();
    const toolCallId = uuidv4();
    const sideEffects = new Map<string, number>();

    const run = async (forceRetry?: boolean) => {
      const existing = await port.findByToolCallId('sess', toolCallId);
      if (existing?.status === 'completed' && !forceRetry) {
        return existing.result;
      }
      const count = (sideEffects.get(toolCallId) ?? 0) + 1;
      sideEffects.set(toolCallId, count);
      await port.create({
        sessionId: 'sess',
        turnId: 'turn-1',
        toolCallId,
        toolName: 'test_tool',
        args: {},
      });
      // fail on first run
      if (count === 1) {
        await port.fail({ sessionId: 'sess', toolCallId, error: 'boom', durationMs: 3 });
        throw new Error('side effect failed');
      }
      await port.complete({ sessionId: 'sess', toolCallId, result: { ok: true, count }, durationMs: 3 });
      return { ok: true, count };
    };

    await expect(run()).rejects.toThrow('side effect failed');
    const retry = await run(true);

    expect(retry).toEqual({ ok: true, count: 2 });
    expect(sideEffects.get(toolCallId)).toBe(2);
  });
});






