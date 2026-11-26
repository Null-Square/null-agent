/**
 * HistoryTrimmer - Trim message history to fit token budget
 * @module agent-brain/application/orchestration/stages/helpers/HistoryTrimmer
 */

import type { Logger } from 'pino';
import type { Message } from '../../../../domain/types';
import { getToolCallId, getToolCalls, estimateTokens, type ToolCall } from './messageUtils';

export interface TrimResult {
  trimmed: Message[];
  usedTokens: number;
  dropped: number;
}

export interface TrimOptions {
  maxTokens: number;
  headTokens: number;
  logger?: Logger;
}

/**
 * Trim history using head/tail strategy with tool-call pairing
 * - Head: Oldest messages up to headTokens budget (keeps context anchor)
 * - Tail: Newest messages in remaining budget (keeps recent context)
 * - Preserves assistant+tool_result pairs together
 */
export function trimHistoryHeadTail(
  messages: Message[],
  options: TrimOptions
): TrimResult {
  const { maxTokens, headTokens, logger: log } = options;
  
  if (messages.length === 0) {
    return { trimmed: [], usedTokens: 0, dropped: 0 };
  }

  // Build index of tool_call_id -> assistant message index
  const toolCallToAssistant = new Map<string, number>();
  // Build index of assistant message index -> set of tool result indices
  const assistantToToolResults = new Map<number, Set<number>>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const toolCalls = getToolCalls(msg);
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          if (call?.id) {
            toolCallToAssistant.set(call.id, i);
          }
        }
        assistantToToolResults.set(i, new Set<number>());
      }
    } else if (msg.role === 'tool') {
      const toolCallId = getToolCallId(msg);
      if (toolCallId) {
        const assistantIdx = toolCallToAssistant.get(toolCallId);
        if (assistantIdx !== undefined) {
          assistantToToolResults.get(assistantIdx)?.add(i);
        }
      }
    }
  }

  const include = new Set<number>();
  let usedTokens = 0;

  // Helper to include a message with its pair (assistant+tools or tool result)
  const includeWithPair = (idx: number): number => {
    if (include.has(idx)) return 0;

    const msg = messages[idx];
    let addedTokens = 0;

    // If it's a tool result, include its parent assistant message first
    if (msg.role === 'tool') {
      const toolCallId = getToolCallId(msg);
      if (toolCallId) {
        const assistantIdx = toolCallToAssistant.get(toolCallId);
        if (assistantIdx !== undefined && !include.has(assistantIdx)) {
          addedTokens += includeWithPair(assistantIdx);
        }
      }
    }

    // Include this message
    const tokens = estimateTokens(msg);
    include.add(idx);
    addedTokens += tokens;

    // If it's an assistant with tool_calls, include all its tool results
    if (msg.role === 'assistant' && assistantToToolResults.has(idx)) {
      const toolResultIndices = assistantToToolResults.get(idx)!;
      for (const resultIdx of toolResultIndices) {
        if (!include.has(resultIdx)) {
          const resultTokens = estimateTokens(messages[resultIdx]);
          include.add(resultIdx);
          addedTokens += resultTokens;
        }
      }
    }

    return addedTokens;
  };

  // Phase 1: Include head messages with their pairs
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // For tool results, their parent will pull them in, so skip on first pass
    if (msg.role === 'tool') continue;

    const pairTokens = (() => {
      let total = estimateTokens(msg);
      if (msg.role === 'assistant' && assistantToToolResults.has(i)) {
        for (const resultIdx of assistantToToolResults.get(i)!) {
          total += estimateTokens(messages[resultIdx]);
        }
      }
      return total;
    })();

    if (usedTokens + pairTokens > headTokens) {
      break;
    }

    usedTokens += includeWithPair(i);
  }

  // Phase 2: Include tail messages with their pairs (from end, backwards)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (include.has(i)) continue;

    const msg = messages[i];
    const pairTokens = (() => {
      let total = estimateTokens(msg);
      // For tool results, also count the parent assistant if not included
      if (msg.role === 'tool') {
        const toolCallId = getToolCallId(msg);
        if (toolCallId) {
          const assistantIdx = toolCallToAssistant.get(toolCallId);
          if (assistantIdx !== undefined && !include.has(assistantIdx)) {
            total += estimateTokens(messages[assistantIdx]);
            const otherResults = assistantToToolResults.get(assistantIdx) || new Set();
            for (const r of otherResults) {
              if (!include.has(r)) total += estimateTokens(messages[r]);
            }
          }
        }
      }
      // For assistant messages, count all their tool results
      if (msg.role === 'assistant' && assistantToToolResults.has(i)) {
        for (const resultIdx of assistantToToolResults.get(i)!) {
          if (!include.has(resultIdx)) {
            total += estimateTokens(messages[resultIdx]);
          }
        }
      }
      return total;
    })();

    if (usedTokens + pairTokens > maxTokens && include.size > 0) {
      break;
    }

    usedTokens += includeWithPair(i);
  }

  const trimmed = Array.from(include)
    .sort((a, b) => a - b)
    .map((idx) => messages[idx]);

  // CRITICAL: Post-trim cleanup - strip orphaned tool_calls from assistant messages
  const toolCallIdsInTrimmed = new Set<string>();
  for (const msg of trimmed) {
    if (msg.role === 'tool') {
      const tcId = getToolCallId(msg);
      if (tcId) {
        toolCallIdsInTrimmed.add(tcId);
      }
    }
  }

  let strippedOrphanedToolCalls = 0;
  const cleanedTrimmed = trimmed.map((msg) => {
    const toolCalls = getToolCalls(msg);
    if (msg.role !== 'assistant' || toolCalls.length === 0) {
      return msg;
    }

    const keptToolCalls = toolCalls
      .map((call: ToolCall) => {
        // First, validate/repair JSON arguments
        if (typeof call.function?.arguments === 'string') {
          try {
            JSON.parse(call.function.arguments);
          } catch {
            // Malformed JSON - repair by replacing with empty object
            log?.warn({
              event: 'malformed_tool_call_args_repaired',
              toolCallId: call.id?.substring(0, 12),
              originalArgs: call.function.arguments?.substring(0, 100),
            }, 'Repaired malformed tool_call arguments');
            return {
              ...call,
              function: { ...call.function, arguments: '{}' }
            };
          }
        }
        return call;
      })
      .filter((call: ToolCall) => {
        if (!call?.id) return false;
        return toolCallIdsInTrimmed.has(call.id);
      });

    if (keptToolCalls.length === 0) {
      // All tool_calls are orphaned - remove the property entirely
      strippedOrphanedToolCalls += toolCalls.length;
      const { tool_calls: _removed, ...cleanMsg } = msg;
      return cleanMsg;
    } else if (keptToolCalls.length < toolCalls.length) {
      // Some tool_calls are orphaned - keep only the ones with results
      strippedOrphanedToolCalls += toolCalls.length - keptToolCalls.length;
      return { ...msg, tool_calls: keptToolCalls };
    }
    return { ...msg, tool_calls: keptToolCalls };
  });

  // Log when orphaned tool_calls are stripped
  if (strippedOrphanedToolCalls > 0 && log) {
    log.warn({
      event: 'orphaned_tool_calls_stripped',
      component: 'trimHistoryHeadTail',
      strippedCount: strippedOrphanedToolCalls,
      toolResultsInTrimmed: toolCallIdsInTrimmed.size,
      msg: `Stripped ${strippedOrphanedToolCalls} orphaned tool_calls (no matching tool results in trimmed history)`,
    });
  }

  return {
    trimmed: cleanedTrimmed,
    usedTokens,
    dropped: Math.max(messages.length - cleanedTrimmed.length, 0),
  };
}
