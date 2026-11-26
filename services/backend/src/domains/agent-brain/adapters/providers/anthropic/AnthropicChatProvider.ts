/**
 * Anthropic chat provider implementation.
 *
 * Uses the OpenAI-compatible shim to satisfy the ChatProviderPort interface
 * without any changes to ModelStream, BuildStage, or orchestration code.
 *
 * Supports:
 * - Explicit cache_control markers (cache_control: { type: 'ephemeral' })
 * - Automatic prompt caching via top-level cache_control
 * - Anthropic usage normalization (cache_creation_input_tokens, cache_read_input_tokens)
 * - Prompt caching with automatic create/hit (Anthropic manages cache lifecycle)
 */

import type OpenAI from 'openai';
import type { CacheIdentity, ProviderCacheProjection } from '@/domains/agent-brain/domain/cache';
import { projectAnthropicCacheSurface } from './projectAnthropicCacheSurface';
import type {
  ProviderCapabilities,
  BuildSystemMessagesParams,
  CacheIntent,
  ChatCompletionRequestInput,
  ChatCompletionRequest,
  RawUsageResponse,
} from '../ChatProvider';
import type { ModelUsage } from '../../../ports';
import { BaseChatProvider } from '../BaseChatProvider';
import { AnthropicClientShim } from './anthropicClientShim';
import type { ResolvedConfig } from '@/config/configTypes';

// ---------------------------------------------------------------------------
// Anthropic-specific text part (with cache_control)
// ---------------------------------------------------------------------------

type AnthropicTextPart = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type AnthropicRequestDecorations = {
  max_tokens?: number;
  cache_control?: { type: 'ephemeral' };
};

// ---------------------------------------------------------------------------
// Anthropic raw usage shape (extends RawUsageResponse from shim)
// ---------------------------------------------------------------------------

type AnthropicRawUsage = RawUsageResponse & {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicChatProvider extends BaseChatProvider {

  /**
   * E12: Anthropic's wire structure is produced by `translateRequest()` after E4 records
   * the envelope, so the default OpenAI-compatible projection would compare the wrong
   * representation. This delegates to the same translator the transport uses.
   */
  override projectCacheSurface(input: {
    envelope: Record<string, unknown>;
    identity: CacheIdentity;
  }): ProviderCacheProjection {
    return projectAnthropicCacheSurface(input);
  }

  public readonly name = 'anthropic';

  protected readonly capabilities: ProviderCapabilities = {
    explicitCacheControl: true,
    automaticCaching: true,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    toolCalling: true,
    streaming: true,
    rateLimitHeaders: true,
    reasoning: { streamField: 'reasoning_content', replay: 'none' },
  };

  private readonly shim: AnthropicClientShim;

  constructor(config: ResolvedConfig, requestProfile: Record<string, unknown> = {}) {
    super(config, requestProfile);
    const apiKey = config.runtime.apiKey;
    if (!apiKey) {
      throw new Error('[AnthropicChatProvider] runtime.apiKey is required for Anthropic provider');
    }
    this.shim = new AnthropicClientShim(apiKey, config.runtime.apiBaseUrl);
  }

  /**
   * Return the OpenAI-compatible shim. Cast is safe because only
   * `client.chat.completions.create()` is used downstream.
   */
  override getClient(): OpenAI {
    return this.shim as unknown as OpenAI;
  }

  /**
   * Build system messages with Anthropic cache_control markers.
   *
   * Follows the same pattern as QwenChatProvider:
   * - Static (cacheable) prefix gets cache_control: { type: 'ephemeral' }
   * - Dynamic suffix has no cache marker
   *
   * Anthropic determines create vs hit automatically server-side,
   * so both CacheIntent.action values map to the same marker.
   */
  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[] {
    const { staticPrompt, dynamicPrompt, softContext, cacheIntent } = params;
    const cacheablePrefix = [staticPrompt, softContext || ''].filter(Boolean).join('\n\n');

    const contentParts: AnthropicTextPart[] = [
      this.buildCacheBlock(cacheablePrefix, cacheIntent),
      { type: 'text', text: dynamicPrompt },
    ];

    return [{
      role: 'system',
      content: contentParts,
    } as unknown as OpenAI.Chat.ChatCompletionMessageParam];
  }

  /**
   * Ensure max_tokens is always set (required by Anthropic API), and enable
   * Anthropic automatic prompt caching so the conversation breakpoint advances
   * across multi-turn tool sessions.
   */
  override decorateRequest(body: ChatCompletionRequestInput): ChatCompletionRequest {
    const decorated = { ...body } as ChatCompletionRequest & AnthropicRequestDecorations;

    if (!('max_tokens' in decorated) || decorated.max_tokens === undefined) {
      decorated.max_tokens = this.capabilities.maxOutputTokens ?? 4096;
    }

    if (decorated.cache_control === undefined) {
      decorated.cache_control = { type: 'ephemeral' };
    }

    return decorated;
  }

  /**
   * Normalize Anthropic's 3-field usage format into our ModelUsage shape.
   *
   * Anthropic returns:
   * - input_tokens: non-cached input tokens
   * - cache_creation_input_tokens: tokens written to cache (25% premium)
   * - cache_read_input_tokens: tokens read from cache (90% discount)
   * - output_tokens: completion tokens
   *
   * The shim already translates these into prompt_tokens / prompt_tokens_details
   * for streaming, but for direct usage objects we handle both formats.
   */
  override normalizeUsage(raw?: RawUsageResponse): ModelUsage | undefined {
    if (!raw) return undefined;

    const anthropicRaw = raw as AnthropicRawUsage;

    // Check for native Anthropic fields first
    if (
      anthropicRaw.input_tokens !== undefined ||
      anthropicRaw.cache_creation_input_tokens !== undefined ||
      anthropicRaw.cache_read_input_tokens !== undefined
    ) {
      const inputTokens = this.readNumber(anthropicRaw.input_tokens) ?? 0;
      const cacheCreate = this.readNumber(anthropicRaw.cache_creation_input_tokens) ?? 0;
      const cacheRead = this.readNumber(anthropicRaw.cache_read_input_tokens) ?? 0;
      const outputTokens = this.readNumber(anthropicRaw.output_tokens) ?? 0;
      const promptTokens = inputTokens + cacheCreate + cacheRead;

      return {
        promptTokens,
        promptTokensDetails: cacheRead > 0 || cacheCreate > 0
          ? { cachedTokens: cacheRead, cacheWriteTokens: cacheCreate }
          : undefined,
        completionTokens: outputTokens,
        totalTokens: promptTokens + outputTokens,
      };
    }

    // Fallback to base normalizeUsage for OpenAI-translated format from shim
    return super.normalizeUsage(raw);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private buildCacheBlock(text: string, cacheIntent?: CacheIntent): AnthropicTextPart {
    if (!cacheIntent) {
      return { type: 'text', text };
    }
    // Both 'create' and 'hit' map to the same marker — Anthropic auto-determines
    return {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    };
  }
}
