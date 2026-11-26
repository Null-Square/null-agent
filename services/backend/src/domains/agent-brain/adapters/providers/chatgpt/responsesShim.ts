/**
 * The ChatGPT plan answers only OpenAI's Responses API (Sign in with ChatGPT, "Models and
 * inference" and "Preview limitations"): POST /v1/responses with `store: false` and `stream: true`,
 * system guidance in `instructions`, the whole history in `input`, and none of max_output_tokens,
 * temperature, top_p, metadata, user. ModelStream speaks chat completions, so this shim translates
 * the request one way and the event stream back, the way the Anthropic shim does.
 */
import type OpenAI from 'openai';

type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.ChatCompletionTool;

export type ChatRequestBody = Record<string, unknown> & {
  model?: string;
  messages?: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  parallel_tool_calls?: boolean;
};

type InputItem = Record<string, unknown>;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n\n');
};

const userContent = (content: unknown): Array<Record<string, unknown>> => {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
    if (part?.type === 'image_url') {
      const image = part.image_url as { url?: unknown } | undefined;
      if (typeof image?.url === 'string') parts.push({ type: 'input_image', image_url: image.url });
    }
  }
  return parts;
};

const toolChoiceOf = (choice: unknown): unknown => {
  if (choice === undefined || typeof choice === 'string') return choice;
  const named = (choice as { function?: { name?: unknown } }).function?.name;
  return typeof named === 'string' ? { type: 'function', name: named } : undefined;
};

/** Chat-completions request → Responses request (`store: false`, `stream: true` always). */
export const toResponsesRequest = (body: ChatRequestBody): Record<string, unknown> => {
  const instructions: string[] = [];
  const input: InputItem[] = [];
  for (const message of body.messages ?? []) {
    const role = (message as { role: string }).role;
    if (role === 'system' || role === 'developer') {
      const text = textOf((message as { content?: unknown }).content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'user') {
      input.push({ type: 'message', role: 'user', content: userContent((message as { content?: unknown }).content) });
      continue;
    }
    if (role === 'assistant') {
      const assistant = message as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      const text = textOf(assistant.content);
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of assistant.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      continue;
    }
    if (role === 'tool') {
      const tool = message as OpenAI.Chat.ChatCompletionToolMessageParam;
      input.push({ type: 'function_call_output', call_id: tool.tool_call_id, output: textOf(tool.content) });
    }
  }

  const tools = (body.tools ?? [])
    .filter((tool): tool is OpenAI.Chat.ChatCompletionFunctionTool => tool.type === 'function')
    .map((tool) => ({
      type: 'function',
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      strict: false,
    }));

  const request: Record<string, unknown> = {
    model: body.model,
    input,
    store: false,
    stream: true,
  };
  if (instructions.length > 0) request.instructions = instructions.join('\n\n');
  if (tools.length > 0) request.tools = tools;
  const toolChoice = toolChoiceOf(body.tool_choice);
  if (toolChoice !== undefined && tools.length > 0) request.tool_choice = toolChoice;
  if (typeof body.parallel_tool_calls === 'boolean' && tools.length > 0) request.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.reasoning_effort === 'string') request.reasoning = { effort: body.reasoning_effort };
  return request;
};

/** A plan-usage failure, with the documented `error.code` kept so the caller can explain it. */
export class ChatGptPlanError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ChatGptPlanError';
  }
}

/** Status per documented code (Errors and recovery), so retries and messages treat them right. */
const STATUS_BY_CODE: Record<string, number> = {
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_unsupported_capability: 400,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  chatpass_v2_scope_not_authorized: 403,
  chatpass_v2_invalid_authorization_context: 403,
  subscription_sharing_user_unavailable: 503,
};

const planError = (error: unknown): ChatGptPlanError => {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown_error';
  return new ChatGptPlanError(code, STATUS_BY_CODE[code], `ChatGPT plan request failed (${code})`);
};

type ResponsesEvent = { type: string } & Record<string, unknown>;

/** Responses events → chat-completion chunks. Success is `response.completed` and nothing less. */
export async function* adaptResponsesStream(
  events: AsyncIterable<ResponsesEvent>,
  model: string,
): AsyncIterable<ChatCompletionChunk> {
  let id = 'chatgpt-response';
  let reportedModel = model;
  const callIndexByItem = new Map<string, number>();
  const argumentsSeen = new Set<string>();
  const chunk = (delta: Record<string, unknown>, finish: ChatCompletionChunk['choices'][number]['finish_reason'] = null) =>
    ({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: reportedModel,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }) as ChatCompletionChunk;

  for await (const event of events) {
    switch (event.type) {
      case 'response.created': {
        const response = event.response as { id?: unknown; model?: unknown } | undefined;
        if (typeof response?.id === 'string') id = response.id;
        if (typeof response?.model === 'string') reportedModel = response.model;
        yield chunk({ role: 'assistant' });
        break;
      }
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) yield chunk({ content: event.delta });
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof event.delta === 'string' && event.delta) yield chunk({ reasoning_content: event.delta });
        break;
      case 'response.output_item.added': {
        const item = event.item as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown } | undefined;
        if (item?.type !== 'function_call' || typeof item.id !== 'string') break;
        const index = callIndexByItem.size;
        callIndexByItem.set(item.id, index);
        yield chunk({
          tool_calls: [{ index, id: item.call_id, type: 'function', function: { name: item.name, arguments: '' } }],
        });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const index = typeof event.item_id === 'string' ? callIndexByItem.get(event.item_id) : undefined;
        if (index === undefined || typeof event.delta !== 'string' || !event.delta) break;
        argumentsSeen.add(event.item_id as string);
        yield chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] });
        break;
      }
      case 'response.output_item.done': {
        const item = event.item as { type?: unknown; id?: unknown; arguments?: unknown } | undefined;
        if (item?.type !== 'function_call' || typeof item.id !== 'string' || argumentsSeen.has(item.id)) break;
        const index = callIndexByItem.get(item.id);
        if (index !== undefined && typeof item.arguments === 'string' && item.arguments) {
          yield chunk({ tool_calls: [{ index, function: { arguments: item.arguments } }] });
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response as { usage?: Record<string, unknown> } | undefined;
        const usage = response?.usage;
        const finish = event.type === 'response.incomplete' ? 'length' : callIndexByItem.size > 0 ? 'tool_calls' : 'stop';
        const final = chunk({}, finish) as ChatCompletionChunk & { usage?: Record<string, unknown> };
        if (usage) {
          const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
          final.usage = {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output,
            prompt_tokens_details: { cached_tokens: (usage.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens },
            completion_tokens_details: {
              reasoning_tokens: (usage.output_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens,
            },
          };
        }
        yield final;
        return;
      }
      case 'response.failed':
        throw planError((event.response as { error?: unknown } | undefined)?.error);
      case 'error':
        throw planError(event);
      default:
        break;
    }
  }
  throw new ChatGptPlanError('stream_ended_early', 502, 'The ChatGPT plan stream ended before the response completed');
}

/** The surface ModelStream calls: `chat.completions.create(body, { signal })`, streaming only. */
export class ResponsesChatShim {
  constructor(private readonly client: OpenAI) {}

  readonly chat = {
    completions: {
      create: async (body: ChatRequestBody, options?: { signal?: AbortSignal }) => {
        const events = await this.client.responses.create(
          toResponsesRequest(body) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
          { signal: options?.signal },
        );
        return adaptResponsesStream(events as unknown as AsyncIterable<ResponsesEvent>, body.model ?? '');
      },
    },
  };
}
