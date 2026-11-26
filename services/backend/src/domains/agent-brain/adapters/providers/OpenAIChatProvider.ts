import type OpenAI from 'openai';
import type {
  ProviderCapabilities,
  BuildSystemMessagesParams,
  ChatCompletionRequest,
  ChatCompletionRequestInput,
} from './ChatProvider';
import { BaseChatProvider } from './BaseChatProvider';

type OpenAIRequestBody = ChatCompletionRequestInput & {
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
};

/**
 * OpenAI provider implementation.
 * 
 * OpenAI uses automatic prompt caching for eligible prefixes (1024+ tokens).
 * Cached tokens are reported in usage.prompt_tokens_details.cached_tokens.
 * No explicit cache markers needed - caching happens automatically.
 * 
 * @see https://platform.openai.com/docs/guides/prompt-caching
 */
export class OpenAIChatProvider extends BaseChatProvider {
  public readonly name = 'openai';

  protected readonly capabilities: ProviderCapabilities = {
    explicitCacheControl: false,
    automaticCaching: true, // OpenAI auto-caches eligible prompts
    contextWindow: 128_000, // gpt-4-turbo and later
    maxOutputTokens: 4096,
    toolCalling: true,
    streaming: true,
    rateLimitHeaders: true, // x-ratelimit-* headers
    reasoning: { replay: 'none' },
  };

  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[] {
    const { staticPrompt, dynamicPrompt, softContext } = params;

    // OpenAI recommendation: put static content first for better cache hits
    const content = [staticPrompt, softContext || '', dynamicPrompt].filter(Boolean).join('\n\n');

    return [{
      role: 'system',
      content,
    }];
  }

  override decorateRequest(body: ChatCompletionRequestInput): ChatCompletionRequest {
    const decorated: OpenAIRequestBody = { ...body };

    if (
      typeof decorated.max_tokens === 'number' &&
      Number.isFinite(decorated.max_tokens) &&
      decorated.max_completion_tokens === undefined
    ) {
      decorated.max_completion_tokens = Math.floor(decorated.max_tokens);
    }

    delete decorated.max_tokens;

    if (this.requestProfile.reasoningEffort !== undefined && decorated.reasoning_effort === undefined) {
      decorated.reasoning_effort = this.requestProfile.reasoningEffort as 'low' | 'medium' | 'high';
    }

    return decorated;
  }
}
