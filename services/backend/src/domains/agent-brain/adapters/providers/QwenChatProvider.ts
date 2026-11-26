import type OpenAI from 'openai';
import type {
  ProviderCapabilities,
  BuildSystemMessagesParams,
  CacheIntent,
  ChatCompletionRequest,
  ChatCompletionRequestInput,
  DecorateRequestContext,
} from './ChatProvider';
import { BaseChatProvider } from './BaseChatProvider';

type QwenTextPart = {
  type: 'text';
  text: string;
  cache_control?: {
    type: 'ephemeral';
    action: CacheIntent['action'];
  };
};

type QwenRequestBody = ChatCompletionRequestInput & {
  enable_thinking?: boolean;
};

/**
 * Qwen chat provider implementation.
 * 
 * Qwen supports explicit cache control via cache_control markers on text parts.
 * This allows fine-grained control over what gets cached.
 * Hybrid-thinking Qwen models require `enable_thinking` to emit
 * `reasoning_content` through the OpenAI-compatible stream. We enable it only
 * for planning contexts so routine executor turns do not pay reasoning-token
 * cost by default.
 */
export class QwenChatProvider extends BaseChatProvider {
  public readonly name = 'qwen';

  protected readonly capabilities: ProviderCapabilities = {
    explicitCacheControl: true,
    automaticCaching: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    toolCalling: true,
    streaming: true,
    rateLimitHeaders: false,
    reasoning: { streamField: 'reasoning_content', replay: 'none' },
  };

  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[] {
    const { staticPrompt, dynamicPrompt, softContext, cacheIntent } = params;
    const cacheablePrefix = [staticPrompt, softContext || ''].filter(Boolean).join('\n\n');

    const contentParts: QwenTextPart[] = [
      this.buildCacheControlBlock(cacheablePrefix, cacheIntent),
      { type: 'text', text: dynamicPrompt },
    ];

    const message = {
      role: 'system',
      content: contentParts,
    } as unknown as OpenAI.Chat.ChatCompletionMessageParam;

    return [message];
  }

  override decorateRequest(
    body: ChatCompletionRequestInput,
    context?: DecorateRequestContext,
  ): ChatCompletionRequest {
    const decorated: QwenRequestBody = { ...body };
    if (this.shouldEnableThinking(decorated.model, context) && decorated.enable_thinking === undefined) {
      decorated.enable_thinking = true;
    }
    return decorated;
  }

  private shouldEnableThinking(model: unknown, context?: DecorateRequestContext): boolean {
    void model;
    const mode = this.requestProfile.thinkingMode;
    if (mode === 'always') return true;
    if (mode === 'disabled') return false;
    return mode === 'planning_only' && this.isPlanningContext(context);
  }

  private isPlanningContext(context?: DecorateRequestContext): boolean {
    const agentType = context?.agentType?.trim().toLowerCase();
    const phaseKey = context?.missionPhaseKey?.trim().toLowerCase();
    return agentType === 'planner' || phaseKey === 'planning';
  }

  private buildCacheControlBlock(text: string, cacheIntent?: CacheIntent): QwenTextPart {
    if (!cacheIntent) {
      return { type: 'text', text };
    }
    return {
      type: 'text',
      text,
      cache_control: {
        type: 'ephemeral' as const,
        action: cacheIntent.action,
      },
    };
  }
}
