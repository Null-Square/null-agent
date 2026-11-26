import { describe, it, expect, vi } from 'vitest';
import { runWithGuards } from '@/domains/agent-brain/application/tools';
import type { ToolContext } from '@/domains/agent-brain/application/tools';
import type { ToolMeta } from '@/domains/agent-brain/application/tools';

describe('runWithGuards', () => {
  const riskyMeta: ToolMeta = {
    name: 'file_write',
    description: 'Write a file',
    category: 'fs',
    schema: {},
    risks: ['write'],
  };

  const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
    ({
      approvals: { require: vi.fn() },
      policies: { requireApproval: true, maxStdoutBytes: 0, timeoutMs: 0 },
      ...overrides,
    }) as ToolContext;

  it('requests approval for risky tools before execution', async () => {
    const calls: string[] = [];
    const approvals = { require: vi.fn(async () => { calls.push('approval'); }) };
    const recordResult = vi.fn(async () => { calls.push('record'); });
    const hooks = {
      onStart: vi.fn(() => { calls.push('start'); }),
      onFinish: vi.fn(() => { calls.push('finish'); }),
    };
    const exec = vi.fn(async () => {
      calls.push('exec');
      return { ok: true };
    });
    const preview = { path: '/tmp/out.txt' };
    const ctx = makeContext({ approvals, recordResult });

    await runWithGuards(riskyMeta, ctx, exec, hooks, preview);

    expect(approvals.require).toHaveBeenCalledWith({ tool: riskyMeta.name, preview });
    expect(calls).toEqual(['approval', 'start', 'exec', 'finish', 'record']);
  });

  it('skips approval when policy disables it', async () => {
    const approvals = { require: vi.fn() };
    const exec = vi.fn(async () => ({ ok: true }));
    const ctx = makeContext({
      approvals,
      policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
    });

    await runWithGuards(riskyMeta, ctx, exec);

    expect(approvals.require).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalled();
  });

  it('normalizes errors and triggers onError hooks', async () => {
    const approvals = { require: vi.fn() };
    const onError = vi.fn();
    const exec = vi.fn(async () => {
      throw 'boom';
    });
    const recordResult = vi.fn();
    const ctx = makeContext({ approvals, recordResult });

    await expect(runWithGuards(riskyMeta, ctx, exec, { onError })).rejects.toThrow('boom');

    expect(onError).toHaveBeenCalledWith(riskyMeta, expect.any(Error), expect.any(Number));
    const errArg = (onError as any).mock.calls[0][1] as Error;
    expect(errArg.message).toBe('boom');
    expect(recordResult).not.toHaveBeenCalled();
  });
});
