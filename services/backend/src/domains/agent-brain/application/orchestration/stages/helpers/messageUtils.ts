/**
 * Message utility functions for history processing
 * @module agent-brain/application/orchestration/stages/helpers/messageUtils
 */

import type { Message } from '../../../../domain/types';

export type ToolCall = NonNullable<Message['tool_calls']>[number];

/**
 * Get tool_call_id from message (handles both field names)
 */
export const getToolCallId = (msg: Message): string | undefined => 
  msg.tool_call_id ?? msg.toolCallId;

/**
 * Get tool_calls array from message (safe accessor)
 */
export const getToolCalls = (msg: Message): ToolCall[] => 
  msg.tool_calls ?? [];

/**
 * Estimate token count for a message
 * Uses heuristic: max(chars/4, words*1.05)
 */
export const estimateTextTokens = (content: string): number => {
  if (content.length === 0) {
    return 0;
  }
  const byChars = Math.ceil(content.length / 4);
  const byWords = Math.ceil(content.trim().split(/\s+/).filter(Boolean).length * 1.05);
  return Math.max(1, Math.max(byChars, byWords));
};

export const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const estimateContentTokens = (content: unknown): number => {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }
  if (content === undefined || content === null) {
    return 0;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => sum + estimateContentTokens(part), 0);
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>;
    const textLike =
      typeof record.text === 'string'
        ? record.text
        : typeof record.content === 'string'
          ? record.content
          : undefined;
    if (textLike !== undefined) {
      return estimateTextTokens(textLike);
    }
  }
  return estimateTextTokens(safeStringify(content));
};

export const estimateTokens = (msg: Message): number => {
  const contentTokens = estimateContentTokens((msg as unknown as { content?: unknown }).content);
  const toolCallTokens = getToolCalls(msg).reduce((sum, call) => {
    return sum + estimateTextTokens(safeStringify(call));
  }, 0);
  const total = contentTokens + toolCallTokens;
  return total > 0 ? Math.max(1, total) : 0;
};
