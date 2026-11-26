import type OpenAI from 'openai';
import type {
  ProviderCapabilities,
  BuildSystemMessagesParams,
  ChatCompletionRequest,
  ChatCompletionRequestInput,
  DecorateRequestContext,
} from './ChatProvider';
import { BaseChatProvider } from './BaseChatProvider';
import { getProviderReasoning } from '../../domain/reasoning/providerReasoning';

type MoonshotRequestBody = ChatCompletionRequestInput & {
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  prompt_cache_key?: string;
  thinking?: {
    type: 'enabled' | 'disabled';
    keep?: 'all' | null;
  };
};

type MoonshotAssistantMessageParam = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

/**
 * Moonshot/Kimi provider implementation.
 *
 * Moonshot exposes an OpenAI-compatible Chat Completions API. Input caching is
 * guided by request-level `prompt_cache_key`, not message-part cache markers.
 *
 * @see https://platform.kimi.ai/docs/api/overview
 * @see https://platform.kimi.ai/docs/api/chat
 */
export class MoonshotChatProvider extends BaseChatProvider {
  public readonly name = 'moonshot';

  protected readonly capabilities: ProviderCapabilities = {
    explicitCacheControl: false,
    automaticCaching: true,
    contextWindow: 256_000,
    maxOutputTokens: 32_768,
    toolCalling: true,
    streaming: true,
    rateLimitHeaders: false,
    reasoning: { streamField: 'reasoning_content', replay: 'reasoning_content' },
  };

  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[] {
    const { staticPrompt, dynamicPrompt, softContext } = params;

    // Keep stable/static content first to improve provider-side cache reuse.
    const content = [staticPrompt, softContext || '', dynamicPrompt].filter(Boolean).join('\n\n');

    return [{ role: 'system', content }];
  }

  override decorateRequest(
    body: ChatCompletionRequestInput,
    context?: DecorateRequestContext,
  ): ChatCompletionRequest {
    const decorated: MoonshotRequestBody = { ...body };
    const promptCacheKey = context?.sessionId?.trim();

    if (promptCacheKey) {
      decorated.prompt_cache_key = promptCacheKey;
    }

    if (Array.isArray(decorated.messages)) {
      decorated.messages = this.decorateMessages(decorated.messages);
    }

    if (decorated.thinking === undefined && this.requestProfile.thinking !== undefined) {
      decorated.thinking = {
        type: this.requestProfile.thinking as 'enabled' | 'disabled',
        ...(this.requestProfile.keep === 'all' ? { keep: 'all' as const } : {}),
      };
    }

    if (
      typeof decorated.max_tokens === 'number' &&
      Number.isFinite(decorated.max_tokens) &&
      decorated.max_completion_tokens === undefined
    ) {
      decorated.max_completion_tokens = Math.floor(decorated.max_tokens);
    }

    delete decorated.max_tokens;

    return decorated;
  }

  private decorateMessages(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (message.role !== 'assistant') {
        return message;
      }
      const reasoning = getProviderReasoning(message);
      if (!reasoning || reasoning.provider !== this.name || reasoning.format !== 'reasoning_content') {
        return message;
      }
      const content = reasoning.content;
      if (typeof content !== 'string' || content.length === 0) {
        return message;
      }
      return {
        ...message,
        reasoning_content: content,
      } as MoonshotAssistantMessageParam;
    });
  }

}
