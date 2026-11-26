import { type ToolContext } from './ToolContext';
import { type ToolMeta, type ToolResult } from './Tool';

export interface ToolExecutionHooks {
  onStart?(meta: ToolMeta, preview?: Record<string, unknown>): Promise<void> | void;
  onFinish?(meta: ToolMeta, result: ToolResult, startedAt: number): Promise<void> | void;
  onError?(meta: ToolMeta, error: Error, startedAt: number): Promise<void> | void;
}

export async function runWithGuards(
  meta: ToolMeta,
  ctx: ToolContext,
  exec: () => Promise<ToolResult>,
  hooks: ToolExecutionHooks = {},
  preview?: Record<string, unknown>
): Promise<ToolResult> {
  const startedAt = Date.now();

  await maybeAwaitApproval(meta, ctx, preview);
  await hooks.onStart?.(meta, preview);

  try {
    const result = await exec();
    await hooks.onFinish?.(meta, result, startedAt);
    await ctx.recordResult?.(meta, result);
    return result;
  } catch (error) {
    const err = normalizeError(error);
    await hooks.onError?.(meta, err, startedAt);
    throw err;
  }
}

async function maybeAwaitApproval(
  meta: ToolMeta,
  ctx: ToolContext,
  preview?: Record<string, unknown>
): Promise<void> {
  if (!ctx.policies.requireApproval) {
    return;
  }
  await ctx.approvals.require({
    tool: meta.name,
    preview,
  });
}

function normalizeError(input: unknown): Error {
  if (input instanceof Error) {
    return input;
  }
  return new Error(typeof input === 'string' ? input : 'Unknown tool error');
}
