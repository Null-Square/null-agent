import type { ToolStreamState } from '@/types/chat';
import type { ToolAction } from '../slices/toolSlice';

export const resetToolStream = (tool: string, command?: string): ToolAction => ({
  type: 'tools/reset',
  payload: { tool, command },
});

export const appendToolStream = (tool: string, chunk: string): ToolAction => ({
  type: 'tools/append',
  payload: { tool, chunk },
});

export const hydrateToolStreams = (
  streams: Record<string, ToolStreamState>
): ToolAction => ({
  type: 'tools/hydrate',
  payload: streams,
});

export const completeToolStream = (
  tool: string,
  status: ToolStreamState['status'],
  result?: ToolStreamState['result']
): ToolAction => ({
  type: 'tools/complete',
  payload: { tool, status, result },
});

export const clearToolStreams = (): ToolAction => ({
  type: 'tools/clear',
});
