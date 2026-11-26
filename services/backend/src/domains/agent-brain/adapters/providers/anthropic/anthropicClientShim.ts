/**
 * OpenAI-compatible shim wrapping the Anthropic SDK.
 *
 * Only `client.chat.completions.create()` is called by ModelStream,
 * so we only implement that surface. The shim is cast to `OpenAI` via `unknown`.
 *
 * Streaming: translates via requestTranslator + streamAdapter.
 * Non-streaming: translates request, calls Anthropic, translates response back.
 */

import Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { translateRequest, type OpenAIRequestBody } from './requestTranslator';
import { adaptAnthropicStream, type AnthropicStreamEvent } from './streamAdapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatCompletionToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

type CreateParams = Record<string, unknown> & {
  model?: string;
  messages?: unknown[];
  stream?: boolean;
  signal?: AbortSignal;
};

type CreateOptions = {
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Shim implementation
// ---------------------------------------------------------------------------

export class AnthropicClientShim {
  private readonly anthropic: Anthropic;

  chat = {
    completions: {
      create: (body: CreateParams, options?: CreateOptions) => this.handleCreate(body, options),
    },
  };

  constructor(apiKey: string, baseURL?: string) {
    this.anthropic = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  private async handleCreate(
    body: CreateParams,
    options?: CreateOptions,
  ): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletion> {
    const requestBody = body as unknown as OpenAIRequestBody;
    const anthropicParams = translateRequest(requestBody);

    if (body.stream) {
      return this.handleStreaming(anthropicParams, requestBody.model, options?.signal ?? (body.signal as AbortSignal | undefined));
    }
    return this.handleNonStreaming(anthropicParams, requestBody.model);
  }

  private async handleStreaming(
    params: ReturnType<typeof translateRequest>,
    model: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const streamParams = { ...params, stream: true as const };

    const stream = this.anthropic.messages.stream(streamParams, {
      signal: signal ?? undefined,
    });

    // Anthropic SDK stream exposes an async iterator on `.on()` events,
    // but the simplest compatible path is the raw event stream.
    const eventStream = toAsyncIterable(stream);
    return adaptAnthropicStream(eventStream, model);
  }

  private async handleNonStreaming(
    params: ReturnType<typeof translateRequest>,
    model: string,
  ): Promise<ChatCompletion> {
    const { stream: _stream, ...nonStreamParams } = params;
    const response = await this.anthropic.messages.create({
      ...nonStreamParams,
      stream: false,
    });

    return translateNonStreamingResponse(response, model);
  }
}

// ---------------------------------------------------------------------------
// Non-streaming response translation
// ---------------------------------------------------------------------------

function translateNonStreamingResponse(
  response: Anthropic.Message,
  model: string,
): ChatCompletion {
  let textContent = '';
  const toolCalls: ChatCompletionToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const finishReason = mapStopReason(response.stop_reason);

  const usage = response.usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };

  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined;
  const cacheRead =
    typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined;
  const totalPrompt = inputTokens + (cacheCreation ?? 0) + (cacheRead ?? 0);

  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          refusal: null,
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: ({
      prompt_tokens: totalPrompt,
      completion_tokens: outputTokens,
      total_tokens: totalPrompt + outputTokens,
      prompt_tokens_details: {
        cached_tokens: cacheRead ?? 0,
        cache_write_tokens: cacheCreation ?? 0,
        audio_tokens: 0,
      },
    } as unknown as NonNullable<ChatCompletion['usage']>),
  };
}

function mapStopReason(
  stopReason: Anthropic.Message['stop_reason'],
): 'stop' | 'tool_calls' | 'length' {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

// ---------------------------------------------------------------------------
// Stream event adapter
// ---------------------------------------------------------------------------

/**
 * Convert the Anthropic MessageStream into an AsyncIterable of raw events.
 * The SDK's `.stream()` returns a MessageStream that emits typed events.
 * We iterate via `for await..of` which yields RawMessageStreamEvent objects.
 */
async function* toAsyncIterable(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<AnthropicStreamEvent> {
  for await (const event of stream) {
    yield event as unknown as AnthropicStreamEvent;
  }
}
