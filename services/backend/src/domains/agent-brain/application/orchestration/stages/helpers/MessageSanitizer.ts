/**
 * MessageSanitizer - Sanitize message history for LLM
 * @module agent-brain/application/orchestration/stages/helpers/MessageSanitizer
 */

import type { Message } from '../../../../domain/types';
import { getToolCallId, getToolCalls } from './messageUtils';

/**
 * P0 FIX (Dec 2025): Sanitize history for LLM
 * 1. Skip empty assistant messages without tool_calls
 * 2. COLLAPSE consecutive assistant messages (not just identical ones)
 *    This prevents LLM from perceiving loops when abort/guard messages polluted history
 * 3. Skip identical consecutive messages (original behavior)
 */
export function sanitizeForLLM(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const result: Message[] = [];
  
  for (let i = 0; i < messages.length; i++) {
    const curr = messages[i];
    const prev = result[result.length - 1];
    
    // Skip empty assistant messages without tool_calls
    if (curr.role === 'assistant') {
      const hasContent = curr.content && curr.content.trim().length > 0;
      const hasToolCalls = getToolCalls(curr).length > 0;
      if (!hasContent && !hasToolCalls) {
        continue;
      }
    }
    
    // Collapse consecutive assistant messages
    if (prev?.role === 'assistant' && curr.role === 'assistant') {
      const prevContent = prev.content || '';
      const currContent = curr.content || '';
      prev.content = [prevContent, currContent].filter(Boolean).join('\n\n');
      if (!prev.metadata?.provider_reasoning && curr.metadata?.provider_reasoning) {
        prev.metadata = {
          ...(prev.metadata ?? {}),
          provider_reasoning: curr.metadata.provider_reasoning,
        };
      }
      
      const prevToolCalls = getToolCalls(prev);
      const currToolCalls = getToolCalls(curr);
      if (currToolCalls.length > 0) {
        prev.tool_calls = [...prevToolCalls, ...currToolCalls];
      }
      continue;
    }
    
    // Skip identical consecutive messages (original behavior)
    if (prev) {
      const same =
        prev.role === curr.role &&
        prev.content === curr.content &&
        getToolCallId(prev) === getToolCallId(curr);
      if (same) continue;
    }
    
    result.push({ ...curr });
  }
  return result;
}
