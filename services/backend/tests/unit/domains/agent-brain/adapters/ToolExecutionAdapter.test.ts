import { describe, it, expect, vi } from 'vitest';
import { ToolExecutionAdapter } from '@/domains/agent-brain/adapters/ToolExecutionAdapter';
import { toolExecutionRecords } from '@/db/schema';

describe('ToolExecutionAdapter', () => {
  it('finds executions by tool call id', async () => {
    const row = {
      id: 'row-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'tool',
      modelRequestId: '10000000-0000-4000-8000-000000000001',
      args: { a: 1 },
      result: { ok: true },
      status: 'completed',
      claimedAt: null,
      startedAt: new Date('2025-01-01T00:00:00Z'),
      completedAt: new Date('2025-01-01T00:00:01Z'),
      durationMs: 1000,
      error: null,
    };
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([row]),
    } as any;
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    const db = { select: vi.fn().mockReturnValue(selectChain) } as any;

    const adapter = new ToolExecutionAdapter(db);
    const result = await adapter.findByToolCallId('session-1', 'call-1');

    expect(db.select).toHaveBeenCalled();
    expect(selectChain.from).toHaveBeenCalledWith(toolExecutionRecords);
    expect(result).toEqual({
      id: 'row-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'tool',
      modelRequestId: '10000000-0000-4000-8000-000000000001',
      args: { a: 1 },
      result: { ok: true },
      status: 'succeeded',
      claimedAt: new Date('2025-01-01T00:00:00Z'),
      startedAt: new Date('2025-01-01T00:00:00Z'),
      completedAt: new Date('2025-01-01T00:00:01Z'),
      durationMs: 1000,
      error: undefined,
    });
  });

  it('creates and updates execution records', async () => {
    const row = {
      id: 'row-2',
      sessionId: 'session-2',
      turnId: 'turn-2',
      toolCallId: 'call-2',
      toolName: 'tool',
      modelRequestId: '10000000-0000-4000-8000-000000000002',
      args: { b: 2 },
      result: null,
      status: 'claimed',
      claimedAt: new Date('2025-01-02T00:00:00Z'),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
    };
    const insertChain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([row]),
    } as any;
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([row]),
    } as any;
    const db = {
      insert: vi.fn().mockReturnValue(insertChain),
      update: vi.fn().mockReturnValue(updateChain),
    } as any;

    const adapter = new ToolExecutionAdapter(db);
    const created = await adapter.create({
      sessionId: 'session-2',
      turnId: 'turn-2',
      toolCallId: 'call-2',
      toolName: 'tool',
      modelRequestId: '10000000-0000-4000-8000-000000000002',
      args: { b: 2 },
    });

    expect(db.insert).toHaveBeenCalledWith(toolExecutionRecords);
    expect(insertChain.values).toHaveBeenCalledWith({
      sessionId: 'session-2',
      turnId: 'turn-2',
      toolCallId: 'call-2',
      toolName: 'tool',
      modelRequestId: '10000000-0000-4000-8000-000000000002',
      args: { b: 2 },
      status: 'claimed',
    });
    expect(created).toEqual({
      id: 'row-2',
      sessionId: 'session-2',
      turnId: 'turn-2',
      toolCallId: 'call-2',
      toolName: 'tool',
      modelRequestId: '10000000-0000-4000-8000-000000000002',
      args: { b: 2 },
      result: undefined,
      status: 'claimed',
      claimedAt: new Date('2025-01-02T00:00:00Z'),
      startedAt: undefined,
      completedAt: undefined,
      durationMs: undefined,
      error: undefined,
    });

    await adapter.markStarted({ sessionId: 'session-1', toolCallId: 'call-2' });
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'started',
      startedAt: expect.any(Date),
    }));

    await adapter.complete({ sessionId: 'session-1', toolCallId: 'call-2', result: { ok: true }, durationMs: 12 });
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        result: { ok: true },
        durationMs: 12,
        completedAt: expect.any(Date),
      }),
    );

    await adapter.fail({ sessionId: 'session-1', toolCallId: 'call-2', error: 'boom', durationMs: 5 });
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'boom',
        durationMs: 5,
        completedAt: expect.any(Date),
      }),
    );
  });

  it('sanitizes JSONB-unsafe execution payloads before persistence', async () => {
    const row = {
      id: 'row-jsonb-safe',
      sessionId: 'session-jsonb-safe',
      turnId: 'turn-jsonb-safe',
      toolCallId: 'call-jsonb-safe',
      toolName: 'tool',
      args: null,
      result: null,
      status: 'claimed',
      claimedAt: new Date('2025-01-02T00:00:00Z'),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
    };
    const insertChain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([row]),
    } as any;
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([row]),
    } as any;
    const db = {
      insert: vi.fn().mockReturnValue(insertChain),
      update: vi.fn().mockReturnValue(updateChain),
    } as any;
    const cyclic: Record<string, unknown> = { preview: `binary${String.fromCharCode(0)}preview` };
    cyclic.self = cyclic;

    const adapter = new ToolExecutionAdapter(db);
    await adapter.create({
      sessionId: 'session-jsonb-safe',
      turnId: 'turn-jsonb-safe',
      toolCallId: 'call-jsonb-safe',
      toolName: 'tool',
      args: {
        command: `curl${String.fromCharCode(0)} https://example.test`,
        missing: undefined,
      },
    });
    await adapter.complete({
      sessionId: 'session-1',
      toolCallId: 'call-jsonb-safe',
      result: {
        body_preview: `MZ${String.fromCharCode(0)}PE`,
        notFinite: Number.NaN,
        big: BigInt(12),
        cyclic,
      },
    });
    await adapter.fail({
      sessionId: 'session-1',
      toolCallId: 'call-jsonb-safe',
      error: `boom${String.fromCharCode(0)}`,
    });

    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({
      args: {
        command: 'curl https://example.test',
        missing: null,
      },
    }));
    expect(updateChain.set).toHaveBeenNthCalledWith(1, expect.objectContaining({
      result: {
        body_preview: 'MZPE',
        notFinite: 'NaN',
        big: '12',
        cyclic: {
          preview: 'binarypreview',
          self: '[Circular]',
        },
      },
    }));
    expect(updateChain.set).toHaveBeenNthCalledWith(2, expect.objectContaining({
      error: 'boom',
    }));
  });

  it('finds executions by session and turn', async () => {
    const rows = [
      {
        id: 'row-3',
        sessionId: 'session-3',
        turnId: 'turn-3',
        toolCallId: 'call-3',
        toolName: 'tool',
        args: null,
        result: null,
        status: 'pending',
        claimedAt: null,
        startedAt: new Date('2025-01-03T00:00:00Z'),
        completedAt: null,
        durationMs: null,
        error: null,
      },
    ];
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn().mockResolvedValue(rows),
    } as any;
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    const db = { select: vi.fn().mockReturnValue(selectChain) } as any;

    const adapter = new ToolExecutionAdapter(db);
    const bySession = await adapter.findBySession('session-3');
    const byTurn = await adapter.findByTurn('session-3', 'turn-3');

    expect(bySession).toHaveLength(1);
    expect(byTurn).toHaveLength(1);
    expect(byTurn[0].toolCallId).toBe('call-3');
  });
});
