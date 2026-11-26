import { describe, expect, it, vi } from 'vitest';
import {
  adaptResponsesStream,
  ChatGptPlanError,
  ResponsesChatShim,
  toResponsesRequest,
} from '@/domains/agent-brain/adapters/providers/chatgpt/responsesShim';

const events = async function* (list: Array<Record<string, unknown>>) {
  for (const event of list) yield event as { type: string } & Record<string, unknown>;
};

const collect = async (stream: AsyncIterable<unknown>) => {
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('toResponsesRequest: the plan takes only what the docs allow', () => {
  it('moves system text to instructions, keeps the history in input, and always sends store:false, stream:true', () => {
    const request = toResponsesRequest({
      model: 'gpt-6.2-sol',
      messages: [
        { role: 'system', content: 'You are the security hire.' },
        { role: 'user', content: 'Check example.com' },
        {
          role: 'assistant',
          content: 'Looking.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'http_get', arguments: '{"url":"https://example.com"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '200 OK' },
      ],
      tools: [{ type: 'function', function: { name: 'http_get', description: 'GET a URL', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      max_tokens: 4096,
      max_completion_tokens: 4096,
      temperature: 0.2,
      top_p: 0.9,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
    });

    expect(request).toEqual({
      model: 'gpt-6.2-sol',
      instructions: 'You are the security hire.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check example.com' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'http_get', arguments: '{"url":"https://example.com"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '200 OK' },
      ],
      tools: [{ type: 'function', name: 'http_get', description: 'GET a URL', parameters: { type: 'object', properties: {} }, strict: false }],
      tool_choice: 'auto',
      reasoning: { effort: 'high' },
      store: false,
      stream: true,
    });
    expect(JSON.stringify(request)).not.toMatch(/max_output_tokens|temperature|top_p|"role":"system"/u);
  });
});

describe('adaptResponsesStream: Responses events become the chunks ModelStream reads', () => {
  it('streams text and a tool call, then usage and finish_reason on response.completed', async () => {
    const chunks = await collect(adaptResponsesStream(events([
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6.2-sol' } },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'http_get' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"url":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', arguments: '{"url":"x"}' } },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 12 } } },
      },
    ]), 'gpt-6.2-sol'));

    const text = chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    const toolDeltas = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? []);
    expect(toolDeltas[0]).toMatchObject({ index: 0, id: 'call_9', function: { name: 'http_get' } });
    expect(toolDeltas.map((delta: any) => delta.function?.arguments ?? '').join('')).toBe('{"url":"x"}');
    const last = chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 12 },
    });
    expect(last.id).toBe('resp_1');
  });

  it('turns response.failed into a plan error carrying the documented code and status', async () => {
    const failing = adaptResponsesStream(events([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
    ]), 'm');
    await expect(collect(failing)).rejects.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
      status: 429,
    });
  });

  it('a stream that ends without response.completed is an error, not a short answer', async () => {
    await expect(collect(adaptResponsesStream(events([{ type: 'response.output_text.delta', delta: 'partial' }]), 'm')))
      .rejects.toBeInstanceOf(ChatGptPlanError);
  });
});

describe('ResponsesChatShim', () => {
  it('answers chat.completions.create by calling responses.create with the translated body and the signal', async () => {
    const create = vi.fn(async () => events([
      { type: 'response.output_text.delta', delta: 'OK' },
      { type: 'response.completed', response: {} },
    ]));
    const shim = new ResponsesChatShim({ responses: { create } } as any);
    const signal = new AbortController().signal;
    const stream = await shim.chat.completions.create({ model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'hi' }] }, { signal });
    const chunks = await collect(stream);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6.2-sol', store: false, stream: true }), { signal });
    expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join('')).toBe('OK');
  });
});
