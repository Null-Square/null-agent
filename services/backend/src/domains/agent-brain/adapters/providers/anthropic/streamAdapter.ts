/**
 * Converts an Anthropic MessageStream into an AsyncIterable of OpenAI ChatCompletionChunks.
 *
 * Maps Anthropic streaming events to the OpenAI chunk format that ModelStream expects:
 *
 * | Anthropic Event           | OpenAI Chunk                                              |
 * |---------------------------|-----------------------------------------------------------|
 * | message_start             | (internal) stores message ID + input usage                |
 * | content_block_start text  | no-op                                                     |
 * | content_block_start think | chunk with choices[0].delta.reasoning_content             |
 * | content_block_start tool  | chunk with tool_calls[i] = { id, function: { name } }     |
 * | content_block_delta text  | chunk with choices[0].delta.content = text                 |
 * | content_block_delta think | chunk with choices[0].delta.reasoning_content             |
 * | content_block_delta json  | chunk with tool_calls[i].function.arguments += json        |
 * | message_delta             | chunk with finish_reason mapped                           |
 * | message_stop              | final chunk with usage                                    |
 */

import type OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Anthropic event types (subset we handle)
// ---------------------------------------------------------------------------

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicMessageStart }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlockStart }
  | { type: 'content_block_delta'; index: number; delta: AnthropicContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: AnthropicMessageDelta; usage?: { output_tokens: number } }
  | { type: 'message_stop' };

type AnthropicMessageStart = {
  id: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

type AnthropicContentBlockStart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

type AnthropicContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string };

type AnthropicMessageDelta = {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal' | null;
  stop_sequence?: string | null;
};

// ---------------------------------------------------------------------------
// Chunk type alias
// ---------------------------------------------------------------------------

type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatCompletionChunkChoice = OpenAI.Chat.Completions.ChatCompletionChunk.Choice;
type ChatCompletionChunkDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wraps an Anthropic event stream, yielding OpenAI-compatible ChatCompletionChunks.
 */
export async function* adaptAnthropicStream(
  events: AsyncIterable<AnthropicStreamEvent>,
  model: string,
): AsyncGenerator<ChatCompletionChunk> {
  let messageId = '';
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;

  // Track tool_use blocks by content_block index
  let toolCallIndex = -1;
  const toolBlockIndexToCallIndex = new Map<number, number>();

  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        messageId = event.message.id;
        inputTokens = event.message.usage.input_tokens;
        cacheCreationTokens = event.message.usage.cache_creation_input_tokens ?? 0;
        cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
        outputTokens = event.message.usage.output_tokens;
        break;
      }

      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'thinking') {
          if (block.thinking) {
            yield makeReasoningChunk(messageId, model, block.thinking);
          }
        } else if (block.type === 'tool_use') {
          toolCallIndex++;
          toolBlockIndexToCallIndex.set(event.index, toolCallIndex);
          yield makeChunk(messageId, model, {
            tool_calls: [
              {
                index: toolCallIndex,
                id: block.id,
                type: 'function' as const,
                function: { name: block.name, arguments: '' },
              },
            ],
          });
        }
        // text content_block_start: no-op (text arrives via delta)
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield makeChunk(messageId, model, { content: delta.text });
        } else if (delta.type === 'thinking_delta') {
          yield makeReasoningChunk(messageId, model, delta.thinking);
        } else if (delta.type === 'input_json_delta') {
          const idx = toolBlockIndexToCallIndex.get(event.index) ?? 0;
          yield makeChunk(messageId, model, {
            tool_calls: [
              {
                index: idx,
                function: { arguments: delta.partial_json },
              },
            ],
          });
        }
        break;
      }

      case 'message_delta': {
        if (event.usage) {
          outputTokens = event.usage.output_tokens;
        }
        const finishReason = mapFinishReason(event.delta.stop_reason);
        yield makeChunk(messageId, model, {}, finishReason);
        break;
      }

      case 'message_stop': {
        // Final chunk with aggregated usage
        const totalPromptTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
        yield makeFinalChunk(messageId, model, {
          prompt_tokens: totalPromptTokens,
          completion_tokens: outputTokens,
          total_tokens: totalPromptTokens + outputTokens,
          prompt_tokens_details: {
            cached_tokens: cacheReadTokens,
            cache_write_tokens: cacheCreationTokens,
          },
        });
        break;
      }

      // content_block_stop: no-op
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFinishReason(
  stopReason: AnthropicMessageDelta['stop_reason'],
): ChatCompletionChunkChoice['finish_reason'] {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
      return 'stop';
    default:
      return null;
  }
}

function makeChunk(
  id: string,
  model: string,
  delta: Partial<ChatCompletionChunkDelta>,
  finishReason: ChatCompletionChunkChoice['finish_reason'] = null,
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: delta as ChatCompletionChunkDelta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  };
}

function makeReasoningChunk(id: string, model: string, reasoningContent: string): ChatCompletionChunk {
  return makeChunk(id, model, {
    reasoning_content: reasoningContent,
  } as Partial<ChatCompletionChunkDelta>);
}

function makeFinalChunk(
  id: string,
  model: string,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  },
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: usage as ChatCompletionChunk['usage'],
  };
}
