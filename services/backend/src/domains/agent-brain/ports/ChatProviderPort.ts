/**
 * ChatProviderPort - Interface for LLM chat providers
 *
 * REFACTORED (Jan 2026): Moved from core/providers/ChatProvider.ts to ports/
 * This interface defines the contract for LLM providers.
 * Implementations are in adapters/llm/.
 *
 * @module agent-brain/ports
 */

import type OpenAI from 'openai';
import type { CacheIdentity, ProviderCacheProjection } from '../domain/cache';
import type { AppError, ErrorContext } from '../domain/errors';
import type { ModelUsage } from './modelStream';

export type CacheIntent = {
  action: 'create' | 'hit';
  prefixHash?: string;
};

export type BuildSystemMessagesParams = {
  staticPrompt: string;
  dynamicPrompt: string;
  softContext?: string;
  cacheIntent?: CacheIntent;
  providerName?: string;
};

type ProviderTag = {
  provider?: string;
};

type ChatCompletionRequestBase = {
  model?: string;
  messages?: OpenAI.Chat.ChatCompletionMessageParam[];
  stream?: boolean;
} & Record<string, unknown>;

export type ChatCompletionRequestInput =
  | (OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & ProviderTag)
  | (ChatCompletionRequestBase & ProviderTag);

export type ChatCompletionRequest = ChatCompletionRequestInput;

export type DecorateRequestContext = {
  sessionId?: string;
  agentType?: string;
  missionPhaseKey?: string;
};

export type RawUsageResponse = {
  prompt_tokens?: number;
  promptTokens?: number;
  completion_tokens?: number;
  completionTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
  cached_tokens?: number;
  cached_prompt_tokens?: number;
  cache_write_tokens?: number;
  cache_creation_input_tokens?: number;
  /** DeepSeek-specific cache fields */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  promptTokensDetails?: {
    cachedTokens?: number;
    cacheWriteTokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  completionTokensDetails?: {
    reasoningTokens?: number;
  };
};

/**
 * Provider capabilities for feature detection.
 * Allows downstream code to adapt behavior based on provider features.
 */
export interface ProviderCapabilities {
  /** Supports explicit cache markers (e.g., Qwen's cache_control) */
  explicitCacheControl: boolean;
  /** Supports automatic prompt caching (e.g., OpenAI's automatic caching) */
  automaticCaching: boolean;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Maximum output tokens per response */
  maxOutputTokens?: number;
  /** Supports tool/function calling */
  toolCalling: boolean;
  /** Supports streaming responses */
  streaming: boolean;
  /** Provider-specific rate limit headers supported */
  rateLimitHeaders: boolean;
  /**
   * Provider reasoning behavior. Hidden/OpenAI-style reasoning does not need
   * capture. Providers that expose reasoning_content can capture it here, and
   * only providers that require replay should turn replay on in their adapter.
   */
  reasoning?: {
    streamField?: 'reasoning_content';
    replay: 'none' | 'reasoning_content';
  };
}

export type ProviderErrorContext = ErrorContext & {
  provider?: string;
};

export interface ChatProviderPort {
  name: string;
  /**
   * Get capabilities for feature detection.
   */
  getCapabilities(): ProviderCapabilities;
  /**
   * Backing client for the provider (OpenAI-compatible for now).
   */
  getClient(): OpenAI;
  /**
   * Build provider-appropriate system messages (e.g., cache markers for Qwen).
   */
  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[];
  /**
   * Allow provider-specific request tweaks (e.g., extra params). Return the mutated body.
   */
  decorateRequest(body: ChatCompletionRequestInput, context?: DecorateRequestContext): ChatCompletionRequest;
  /**
   * E12: project the decorated envelope onto the provider-visible cache surface.
   *
   * The adapter owns this because the dispatched wire structure can differ from the
   * recorded envelope (Anthropic hoists system messages during translation). The
   * projection and the transport must share one translation implementation.
   */
  projectCacheSurface?(input: {
    envelope: Record<string, unknown>;
    identity: CacheIdentity;
  }): ProviderCacheProjection;
  /**
   * Normalize provider usage payloads into the shared shape.
   */
  normalizeUsage(raw?: RawUsageResponse): ModelUsage | undefined;
  /**
   * Map provider-specific errors into AppError for orchestration.
   */
  mapError(error: unknown, context?: ProviderErrorContext): AppError;
  /**
   * Whether this provider supports explicit cache controls.
   * @deprecated Use getCapabilities().explicitCacheControl instead
   */
  supportsCacheControl(): boolean;
}

// Backward compatibility alias
export type ChatProvider = ChatProviderPort;
