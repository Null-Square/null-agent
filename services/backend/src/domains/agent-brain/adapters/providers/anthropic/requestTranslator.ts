/**
 * Translates OpenAI-format chat completion requests into Anthropic Messages API format.
 *
 * Handles:
 * - System message extraction → top-level `system` param with content blocks
 * - Message role mapping (assistant tool_calls → tool_use blocks, tool → tool_result)
 * - Tool definition translation (parameters → input_schema)
 * - cache_control marker passthrough
 * - top-level automatic prompt caching
 * - max_tokens enforcement (required by Anthropic)
 */

import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/shared/logger';
import {
  buildInterruptedToolRecoveryProjection,
  repairUnsafeInterruptedToolResult,
  type InterruptedToolRecoveryEventV1,
} from '../../../domain/recovery/interruptedToolResult';

// ---------------------------------------------------------------------------
// Input types (subset of OpenAI request we actually use)
// ---------------------------------------------------------------------------

type OpenAIMessage = {
  role: string;
  content?: string | ContentPart[] | null;
  tool_calls?: ToolCallPart[];
  tool_call_id?: string;
  name?: string;
};

type ContentPart = {
  type: string;
  text?: string;
  cache_control?: { type: 'ephemeral' };
};

type ToolCallPart = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};

type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type AnthropicCacheControl = { type: 'ephemeral' };

export type OpenAIRequestBody = {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  max_tokens?: number;
  cache_control?: AnthropicCacheControl;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream_options?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Output (Anthropic request params)
// ---------------------------------------------------------------------------

export type AnthropicRequestParams = {
  model: string;
  max_tokens: number;
  cache_control?: AnthropicCacheControl;
  system?: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4096;
const log = logger.child({ scope: 'AnthropicRequestTranslator' });

const recordInterruptedRecovery = (recoveryEvent: InterruptedToolRecoveryEventV1): void => {
  log.warn({
    event: 'provider_recovery.interrupted_tool_result',
    ...recoveryEvent,
  }, '[requestTranslator] Repaired interrupted tool result');
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate an OpenAI-format request body into Anthropic Messages API params.
 */
export function translateRequest(body: OpenAIRequestBody): AnthropicRequestParams {
  const { systemBlocks, conversationMessages } = extractSystemMessages(body.messages);
  const messages = translateMessages(conversationMessages);
  const tools = body.tools ? translateTools(body.tools) : undefined;

  const params: AnthropicRequestParams = {
    model: body.model,
    max_tokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };

  if (systemBlocks.length > 0) {
    params.system = systemBlocks;
  }
  if (tools && tools.length > 0) {
    params.tools = tools;
  }
  if (body.stream !== undefined) {
    params.stream = body.stream;
  }
  if (body.cache_control !== undefined) {
    params.cache_control = body.cache_control;
  }
  if (body.temperature !== undefined) {
    params.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    params.top_p = body.top_p;
  }
  if (body.stop !== undefined) {
    params.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }

  return params;
}

// ---------------------------------------------------------------------------
// System message extraction
// ---------------------------------------------------------------------------

type Extraction = {
  systemBlocks: Anthropic.TextBlockParam[];
  conversationMessages: OpenAIMessage[];
};

function extractSystemMessages(messages: OpenAIMessage[]): Extraction {
  const systemBlocks: Anthropic.TextBlockParam[] = [];
  const conversationMessages: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            const block: Anthropic.TextBlockParam = { type: 'text', text: part.text };
            if (part.cache_control) {
              (block as Anthropic.TextBlockParam & { cache_control?: { type: 'ephemeral' } }).cache_control =
                { type: 'ephemeral' };
            }
            systemBlocks.push(block);
          }
        }
      } else if (typeof msg.content === 'string' && msg.content.length > 0) {
        systemBlocks.push({ type: 'text', text: msg.content });
      }
    } else {
      conversationMessages.push(msg);
    }
  }

  return { systemBlocks, conversationMessages };
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

function translateMessages(messages: OpenAIMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(translateAssistantMessage(msg));
    } else if (msg.role === 'tool') {
      // Anthropic requires tool_result inside a user message
      appendToolResult(result, msg);
    } else {
      // user messages
      result.push(translateUserMessage(msg));
    }
  }

  // Anthropic requires alternating user/assistant. Merge consecutive same-role messages.
  const merged = mergeConsecutive(result);

  // Final safety net: Anthropic enforces that every tool_use block must have a
  // corresponding tool_result in the immediately following message.
  // sanitizeToolOrdering injects placeholders upstream, but if a tool result was
  // silently dropped (e.g. due to object-reference mismatch when repairing args),
  // respondedToolCallIds is already set so no placeholder was injected there.
  // This pass catches anything that slipped through.
  return ensureToolResultCoverage(merged);
}

/**
 * Ensures every tool_use block in an assistant message has a matching tool_result
 * in the immediately following user message. Injects placeholder tool_results for
 * any orphaned tool_use blocks so Anthropic's strict pairing requirement is met.
 *
 * This is a last-mile safety net. If it fires it means sanitizeToolOrdering dropped
 * a tool result upstream (object-reference mismatch after argument repair). A warning
 * is logged so the upstream bug remains observable.
 */
function ensureToolResultCoverage(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  // Deep-clone so we never mutate the caller's objects.
  const result: Anthropic.MessageParam[] = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? [...(m.content as Anthropic.ContentBlockParam[])] : m.content,
  }));

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseBlocks = (msg.content as Anthropic.ContentBlockParam[]).filter(
      (b) => b.type === 'tool_use',
    ) as Anthropic.ToolUseBlockParam[];
    if (toolUseBlocks.length === 0) continue;

    const next = result[i + 1];
    const toolUseIds = new Set(toolUseBlocks.map((block) => block.id));
    if (next?.role === 'user' && Array.isArray(next.content)) {
      const seenToolResultIds = new Set<string>();
      next.content = (next.content as Anthropic.ContentBlockParam[]).filter((block) => {
        if (block.type !== 'tool_result') return true;
        const toolUseId = (block as Anthropic.ToolResultBlockParam).tool_use_id;
        if (!toolUseIds.has(toolUseId)) return true;
        if (seenToolResultIds.has(toolUseId)) return false;
        seenToolResultIds.add(toolUseId);
        return true;
      });
    }
    const coveredIds = new Set(
      (Array.isArray(next?.content) ? (next.content as Anthropic.ContentBlockParam[]) : [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id),
    );

    // Guard against tool_use blocks with missing ids (pre-existing upstream corruption).
    const missingIds = toolUseBlocks
      .map((b) => b.id)
      .filter((id): id is string => typeof id === 'string' && !coveredIds.has(id));
    if (missingIds.length === 0) continue;

    // Log so upstream bugs remain observable even though we recover gracefully.
    console.warn(
      `[requestTranslator] ensureToolResultCoverage: injecting ${missingIds.length} placeholder(s) for orphaned tool_use id(s): ${missingIds.join(', ')}. ` +
      'This indicates sanitizeToolOrdering dropped tool results upstream (likely object-reference mismatch after argument repair).',
    );

    const placeholders: Anthropic.ToolResultBlockParam[] = missingIds.map((id) => {
      const projection = buildInterruptedToolRecoveryProjection({
        toolCallId: id,
        source: 'anthropic_request_translator',
      });
      recordInterruptedRecovery(projection.event);
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: projection.content,
      };
    });

    if (next?.role === 'user') {
      // Prepend placeholders so tool_results appear before any regular user text.
      // Normalise string content to a block array first (Anthropic allows both forms
      // but we need an array to prepend into).
      const existingBlocks: Anthropic.ContentBlockParam[] = Array.isArray(next.content)
        ? (next.content as Anthropic.ContentBlockParam[])
        : [{ type: 'text', text: (next.content as string) || '' }];
      next.content = [...placeholders, ...existingBlocks];
    } else {
      // No following user message — insert one.
      result.splice(i + 1, 0, { role: 'user', content: placeholders });
    }
  }

  return result;
}

function translateUserMessage(msg: OpenAIMessage): Anthropic.MessageParam {
  if (Array.isArray(msg.content)) {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) {
        const block: Anthropic.TextBlockParam = { type: 'text', text: part.text };
        if (part.cache_control) {
          (block as Anthropic.TextBlockParam & { cache_control?: { type: 'ephemeral' } }).cache_control =
            { type: 'ephemeral' };
        }
        blocks.push(block);
      }
    }
    return { role: 'user', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] };
  }
  return { role: 'user', content: msg.content || '' };
}

function translateAssistantMessage(msg: OpenAIMessage): Anthropic.MessageParam {
  const blocks: Anthropic.ContentBlockParam[] = [];

  // Text content
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    }
  }

  // Tool calls → tool_use blocks
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        // Keep empty input on parse failure
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      } as Anthropic.ToolUseBlockParam);
    }
  }

  return { role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] };
}

function appendToolResult(result: Anthropic.MessageParam[], msg: OpenAIMessage): void {
  const toolCallId = msg.tool_call_id || '';
  const upgraded = toolCallId
    ? repairUnsafeInterruptedToolResult({
      toolCallId,
      content: msg.content,
      source: 'anthropic_request_translator',
    })
    : undefined;
  if (upgraded) recordInterruptedRecovery(upgraded.event);
  const toolResultBlock: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: upgraded?.content
      ?? (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')),
  };

  // Anthropic wants tool_result inside a user message
  const last = result[result.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    (last.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
  } else {
    result.push({ role: 'user', content: [toolResultBlock] });
  }
}

// ---------------------------------------------------------------------------
// Merge consecutive same-role messages (Anthropic requirement)
// ---------------------------------------------------------------------------

function mergeConsecutive(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const merged: Anthropic.MessageParam[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge into previous by combining content
      const prevBlocks = toContentBlocks(prev.content);
      const currBlocks = toContentBlocks(curr.content);
      prev.content = [...prevBlocks, ...currBlocks];
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

function toContentBlocks(content: Anthropic.MessageParam['content']): Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content as Anthropic.ContentBlockParam[];
}

// ---------------------------------------------------------------------------
// Tool definition translation
// ---------------------------------------------------------------------------

type AnthropicToolWithCacheControl = Anthropic.Tool & {
  cache_control?: AnthropicCacheControl;
};

function translateTools(tools: OpenAITool[]): Anthropic.Tool[] {
  const translated = tools.map<AnthropicToolWithCacheControl>((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: (t.function.parameters as Anthropic.Tool['input_schema']) || {
      type: 'object' as const,
      properties: {},
    },
  }));

  const last = translated[translated.length - 1];
  if (last) {
    last.cache_control = { type: 'ephemeral' };
  }

  return translated;
}
