import type OpenAI from 'openai';
import type {
  ProviderCapabilities,
  BuildSystemMessagesParams,
  RawUsageResponse,
  ChatCompletionRequest,
  ChatCompletionRequestInput,
} from './ChatProvider';
import { BaseChatProvider } from './BaseChatProvider';
import type { ModelUsage } from '../../ports';
import { getProviderReasoning } from '../../domain/reasoning/providerReasoning';

type DeepSeekAssistantMessageParam = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

/**
 * DeepSeek chat provider implementation.
 *
 * DeepSeek V4 exposes an OpenAI-compatible API but reports cache usage
 * with its own field names: `prompt_cache_hit_tokens` and
 * `prompt_cache_miss_tokens`. Caching is automatic (disk-based) — no
 * explicit cache_control markers are needed. In thinking-mode tool loops,
 * DeepSeek requires captured `reasoning_content` on assistant history messages.
 *
 * Current pricing is resolved from the frozen deployment rate card. Since the
 * 2026-08-16 cutover, V4 Pro has recurring UTC peak and off-peak rates; the
 * provider adapter does not own or duplicate those prices.
 *
 * @see https://api-docs.deepseek.com/quick_start/pricing
 */
export class DeepSeekChatProvider extends BaseChatProvider {
  public readonly name = 'deepseek';

  protected readonly capabilities: ProviderCapabilities = {
    explicitCacheControl: false,
    automaticCaching: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    toolCalling: true,
    streaming: true,
    rateLimitHeaders: false,
    reasoning: { streamField: 'reasoning_content', replay: 'reasoning_content' },
  };

  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[] {
    const { staticPrompt, dynamicPrompt, softContext } = params;

    // Static content first gives better cache hit rate (same prefix strategy as OpenAI)
    const content = [staticPrompt, softContext || '', dynamicPrompt].filter(Boolean).join('\n\n');

    return [{ role: 'system', content }];
  }

  override decorateRequest(body: ChatCompletionRequestInput): ChatCompletionRequest {
    const decorated: ChatCompletionRequestInput & Record<string, unknown> = { ...body };
    if (Array.isArray(decorated.messages)) {
      decorated.messages = this.decorateMessages(decorated.messages);
    }
    if (this.requestProfile.thinking !== undefined) {
      decorated.thinking = { type: this.requestProfile.thinking };
    }
    if (this.requestProfile.reasoningEffort !== undefined) {
      decorated.reasoning_effort = this.requestProfile.reasoningEffort;
    }
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
      if (!reasoning.content) {
        return message;
      }
      return {
        ...message,
        reasoning_content: reasoning.content,
      } as DeepSeekAssistantMessageParam;
    });
  }

  /**
   * DeepSeek reports cache hits as `prompt_cache_hit_tokens` in the root usage
   * object, not inside `prompt_tokens_details`. Override to handle this.
   */
  normalizeUsage(raw?: RawUsageResponse): ModelUsage | undefined {
    if (!raw) return undefined;

    const promptTokens = this.readNumber(raw.prompt_tokens) ?? this.readNumber(raw.promptTokens);
    const completionTokens =
      this.readNumber(raw.completion_tokens) ?? this.readNumber(raw.completionTokens);
    const totalTokens =
      this.readNumber(raw.total_tokens) ??
      this.readNumber(raw.totalTokens) ??
      (promptTokens ?? 0) + (completionTokens ?? 0);

    // DeepSeek-specific cache field takes priority; fall back to common fields
    const cachedTokens =
      this.readNumber(raw.prompt_cache_hit_tokens) ??
      this.readNumber(raw.prompt_tokens_details?.cached_tokens) ??
      this.readNumber(raw.cached_prompt_tokens) ??
      this.readNumber(raw.cached_tokens);
    const reasoningTokens =
      this.readNumber(raw.completion_tokens_details?.reasoning_tokens) ??
      this.readNumber(raw.completionTokensDetails?.reasoningTokens);

    if (
      promptTokens === undefined &&
      completionTokens === undefined &&
      totalTokens === undefined &&
      cachedTokens === undefined &&
      reasoningTokens === undefined
    ) {
      return undefined;
    }

    return {
      promptTokens: promptTokens ?? 0,
      promptTokensDetails: cachedTokens !== undefined ? { cachedTokens } : undefined,
      completionTokens: completionTokens ?? 0,
      completionTokensDetails:
        reasoningTokens !== undefined ? { reasoningTokens } : undefined,
      totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    };
  }
}
