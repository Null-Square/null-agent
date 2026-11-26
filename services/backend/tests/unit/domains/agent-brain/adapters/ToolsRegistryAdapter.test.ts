import { describe, it, expect, vi } from 'vitest';
import { ToolsRegistryAdapter } from '@/domains/agent-brain/adapters/ToolsRegistryAdapter';

describe('ToolsRegistryAdapter', () => {
  it('routes execution to registry variants with sessionId', async () => {
    const registry = {
      execute(toolId: string, args: Record<string, unknown>, ctx: { sessionId: string; abortSignal?: AbortSignal }) {
        return { toolId, args, sessionId: ctx.sessionId, options: ctx };
      },
      getToolSchemas: vi.fn().mockReturnValue([]),
      listManifests: vi.fn().mockResolvedValue([]),
      getManifest: vi.fn().mockResolvedValue(undefined),
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true }),
    };
    const execSpy = vi.spyOn(registry, 'execute');
    const adapter = new ToolsRegistryAdapter(registry as any);
    const abortSignal = new AbortController().signal;

    const result = await adapter.execute('tool', { a: 1 }, { sessionId: 's1', abortSignal });

    expect(execSpy).toHaveBeenCalledWith('tool', { a: 1 }, { sessionId: 's1', abortSignal });
    expect(result).toEqual({
      toolId: 'tool',
      args: { a: 1 },
      sessionId: 's1',
      options: { sessionId: 's1', abortSignal },
    });
  });

  it('uses ToolRegistryPort signature and approval passthroughs', async () => {
    const registry = {
      execute: vi.fn().mockResolvedValue('ok'),
      getToolSchemas: vi.fn().mockReturnValue([]),
      listManifests: vi.fn().mockResolvedValue(['manifest-1']),
      getManifest: vi.fn().mockResolvedValue({ id: 'manifest-1' }),
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true }),
    };
    const adapter = new ToolsRegistryAdapter(registry as any);
    const abortSignal = new AbortController().signal;

    await adapter.execute('tool', { a: 1 }, { sessionId: 's2', abortSignal });

    expect(registry.execute).toHaveBeenCalledWith('tool', { a: 1 }, {
      sessionId: 's2',
      abortSignal,
    });
    await expect(adapter.listManifests()).resolves.toEqual(['manifest-1']);
    await expect(adapter.getManifest('manifest-1')).resolves.toEqual({ id: 'manifest-1' });
    await expect(
      adapter.handleApprovalDecision('s2', 'action-1', 'granted', 'ok'),
    ).resolves.toEqual({ handled: true });
  });

  it('passes canonical execution receipts through without adapting them', async () => {
    const receipt = {
      schema: 'tool-execution-receipt/v1' as const,
      toolName: 'query_inventory',
      toolCallId: 'tc-1',
      outcome: 'succeeded' as const,
    };
    const registry = {
      execute: vi.fn(),
      executeWithReceipt: vi.fn().mockResolvedValue({
        result: { totalCount: 0 },
        receipt,
      }),
      getToolSchemas: vi.fn().mockReturnValue([]),
      listManifests: vi.fn().mockResolvedValue([]),
      getManifest: vi.fn().mockResolvedValue(undefined),
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true }),
    };
    const adapter = new ToolsRegistryAdapter(registry as any);

    await expect(adapter.executeWithReceipt('query_inventory', {}, {
      sessionId: 's1',
      toolCallId: 'tc-1',
    })).resolves.toEqual({ result: { totalCount: 0 }, receipt });
    expect(registry.executeWithReceipt).toHaveBeenCalledWith('query_inventory', {}, {
      sessionId: 's1',
      toolCallId: 'tc-1',
    });
  });

  it('returns pending approvals when supported', async () => {
    const registry = {
      execute: vi.fn().mockResolvedValue(undefined),
      getToolSchemas: vi.fn().mockReturnValue([]),
      listManifests: vi.fn().mockResolvedValue([]),
      getManifest: vi.fn().mockResolvedValue(undefined),
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: false }),
      getPendingApprovals: vi.fn().mockResolvedValue([{ id: 'approval-1' }]),
    };
    const adapter = new ToolsRegistryAdapter(registry as any);

    await expect(adapter.getPendingApprovals('s3')).resolves.toEqual([{ id: 'approval-1' }]);
  });

  it('returns empty approvals when registry does not implement them', async () => {
    const registry = {
      execute: vi.fn().mockResolvedValue(undefined),
      getToolSchemas: vi.fn().mockReturnValue([]),
      listManifests: vi.fn().mockResolvedValue([]),
      getManifest: vi.fn().mockResolvedValue(undefined),
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: false }),
    };
    const adapter = new ToolsRegistryAdapter(registry as any);

    await expect(adapter.getPendingApprovals('s4')).resolves.toEqual([]);
  });
});
