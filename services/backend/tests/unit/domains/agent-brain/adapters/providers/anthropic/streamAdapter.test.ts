import { describe, it, expect } from 'vitest';
import { adaptAnthropicStream, type AnthropicStreamEvent } from '@/domains/agent-brain/adapters/providers/anthropic/streamAdapter';

async function collectChunks(events: AnthropicStreamEvent[], model = 'claude-sonnet-4-20250514') {
  async function* toAsync() {
    for (const e of events) yield e;
  }
  const chunks = [];
  for await (const chunk of adaptAnthropicStream(toAsync(), model)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('streamAdapter', () => {
  describe('text streaming', () => {
    it('converts text deltas to content chunks', async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: { id: 'msg_1', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 0 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];

      const chunks = await collectChunks(events);

      // text deltas
      const textChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
      expect(textChunks).toHaveLength(2);
      expect(textChunks[0].choices[0].delta.content).toBe('Hello');
      expect(textChunks[1].choices[0].delta.content).toBe(' world');

      // finish reason
      const finishChunk = chunks.find((c) => c.choices[0]?.finish_reason === 'stop');
      expect(finishChunk).toBeDefined();

      // final usage chunk
      const usageChunk = chunks[chunks.length - 1];
      expect(usageChunk.usage).toBeDefined();
      expect(usageChunk.usage!.prompt_tokens).toBe(100);
      expect(usageChunk.usage!.completion_tokens).toBe(10);
      expect(usageChunk.usage!.total_tokens).toBe(110);
    });
  });

  describe('thinking streaming', () => {
    it('converts Anthropic thinking blocks to reasoning_content chunks without visible text', async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: { id: 'msg_thinking', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: 'I should inspect ', signature: 'sig-1' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'the evidence first.' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-2' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'I found the issue.' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ];

      const chunks = await collectChunks(events, 'claude-opus-4-6');
      const reasoningChunks = chunks
        .map((c) => (c.choices[0]?.delta as Record<string, unknown> | undefined)?.reasoning_content)
        .filter((value): value is string => typeof value === 'string');
      const textChunks = chunks
        .map((c) => c.choices[0]?.delta?.content)
        .filter((value): value is string => typeof value === 'string');

      expect(reasoningChunks.join('')).toBe('I should inspect the evidence first.');
      expect(textChunks.join('')).toBe('I found the issue.');
    });
  });

  describe('tool_use streaming', () => {
    it('converts tool_use blocks to tool_calls chunks', async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: { id: 'msg_2', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 50, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"cats"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ];

      const chunks = await collectChunks(events);

      // tool start chunk
      const startChunk = chunks.find(
        (c) => c.choices[0]?.delta?.tool_calls?.[0]?.id === 'tu_1',
      );
      expect(startChunk).toBeDefined();
      expect(startChunk!.choices[0].delta.tool_calls![0].function?.name).toBe('search');

      // argument delta chunks
      const argChunks = chunks.filter(
        (c) =>
          c.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments &&
          !c.choices[0]?.delta?.tool_calls?.[0]?.id,
      );
      expect(argChunks).toHaveLength(2);
      const combinedArgs =
        argChunks[0].choices[0].delta.tool_calls![0].function!.arguments! +
        argChunks[1].choices[0].delta.tool_calls![0].function!.arguments!;
      expect(combinedArgs).toBe('{"query":"cats"}');

      // finish reason maps to tool_calls
      const finishChunk = chunks.find((c) => c.choices[0]?.finish_reason === 'tool_calls');
      expect(finishChunk).toBeDefined();
    });
  });

  describe('interleaved text + tool_use', () => {
    it('handles text followed by tool_use in same response', async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: { id: 'msg_3', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 80, output_tokens: 0 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me search.' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_2', name: 'search', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
        { type: 'message_stop' },
      ];

      const chunks = await collectChunks(events);

      const textChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0].choices[0].delta.content).toBe('Let me search.');

      const toolStartChunks = chunks.filter(
        (c) => c.choices[0]?.delta?.tool_calls?.[0]?.id,
      );
      expect(toolStartChunks).toHaveLength(1);
      expect(toolStartChunks[0].choices[0].delta.tool_calls![0].id).toBe('tu_2');
    });
  });

  describe('finish_reason mapping', () => {
    it.each([
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['tool_use', 'tool_calls'],
      ['max_tokens', 'length'],
      ['refusal', 'content_filter'],
      ['pause_turn', 'stop'],
    ] as const)('maps %s → %s', async (anthropicReason, expectedReason) => {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: { id: 'msg_fr', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } },
        },
        { type: 'message_delta', delta: { stop_reason: anthropicReason }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];

      const chunks = await collectChunks(events, 'test');
      const finishChunk = chunks.find((c) => c.choices[0]?.finish_reason);
      expect(finishChunk!.choices[0].finish_reason).toBe(expectedReason);
    });
  });

  describe('usage with cache tokens', () => {
    it('includes cache tokens in prompt_tokens and prompt_tokens_details', async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: {
            id: 'msg_cache',
            model: 'claude-sonnet-4-20250514',
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 200,
            },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];

      const chunks = await collectChunks(events);
      const usageChunk = chunks[chunks.length - 1];

      expect(usageChunk.usage).toBeDefined();
      // prompt_tokens = input_tokens + cache_creation + cache_read = 100 + 50 + 200 = 350
      expect(usageChunk.usage!.prompt_tokens).toBe(350);
      expect(usageChunk.usage!.completion_tokens).toBe(5);
      expect(usageChunk.usage!.total_tokens).toBe(355);
      expect((usageChunk.usage as any).prompt_tokens_details.cached_tokens).toBe(200);
      expect((usageChunk.usage as any).prompt_tokens_details.cache_write_tokens).toBe(50);
    });
  });

  describe('chunk metadata', () => {
    it('sets correct id and model on chunks', async () => {
      const events: AnthropicStreamEvent[] = [
        {
          type: 'message_start',
          message: { id: 'msg_meta', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10, output_tokens: 0 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];

      const chunks = await collectChunks(events);
      for (const chunk of chunks) {
        expect(chunk.id).toBe('msg_meta');
        expect(chunk.model).toBe('claude-sonnet-4-20250514');
        expect(chunk.object).toBe('chat.completion.chunk');
      }
    });
  });
});
