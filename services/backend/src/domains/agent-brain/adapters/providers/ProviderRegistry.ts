import type { ResolvedConfig } from '@/config/configTypes';
import type { ChatProvider } from './ChatProvider';
import { QwenChatProvider } from './QwenChatProvider';
import { OpenAIChatProvider } from './OpenAIChatProvider';
import { AnthropicChatProvider } from './anthropic';
import { DeepSeekChatProvider } from './DeepSeekChatProvider';
import { MoonshotChatProvider } from './MoonshotChatProvider';
import { ChatGptPlanChatProvider } from './chatgpt/ChatGptPlanChatProvider';
import type { CHATGPT_PROVIDER, ModelProvider } from '@/domains/platform/models/modelProviders';

/** Supported provider types - matches DB column */
export type ProviderType = ModelProvider | typeof CHATGPT_PROVIDER;

type ProviderConstructor = new (config: ResolvedConfig, requestProfile?: Record<string, unknown>) => ChatProvider;

/** Registry of provider constructors */
const providerConstructors = new Map<ProviderType, ProviderConstructor>();
providerConstructors.set('QWEN', QwenChatProvider);
providerConstructors.set('OPENAI', OpenAIChatProvider);
providerConstructors.set('ANTHROPIC', AnthropicChatProvider);
providerConstructors.set('DEEPSEEK', DeepSeekChatProvider);
providerConstructors.set('MOONSHOT', MoonshotChatProvider);
providerConstructors.set('CHATGPT', ChatGptPlanChatProvider);

/**
 * Create a provider instance by type.
 * 
 * @param providerType - The provider type from database
 * @param config - Resolved config with API credentials
 * @returns ChatProvider instance
 */
export function createProviderByType(
  providerType: ProviderType,
  config: ResolvedConfig,
  requestProfile: Record<string, unknown> = {},
): ChatProvider {
  const Constructor = providerConstructors.get(providerType);
  if (!Constructor) {
    throw new Error(`Unknown provider type: ${providerType}. Valid types: ${[...providerConstructors.keys()].join(', ')}`);
  }
  return new Constructor(config, requestProfile);
}

/**
 * Register a new provider constructor.
 * Use this to add support for new providers without modifying this file.
 * 
 * @example
 * ```typescript
 * import { AnthropicChatProvider } from './AnthropicChatProvider';
 * registerProvider('ANTHROPIC', AnthropicChatProvider);
 * ```
 */
export function registerProvider(type: ProviderType, constructor: ProviderConstructor): void {
  providerConstructors.set(type, constructor);
}

/**
 * Check if a provider type is supported.
 */
export function isProviderTypeSupported(type: string): type is ProviderType {
  return providerConstructors.has(type as ProviderType);
}

/**
 * Get all supported provider types.
 */
export function getSupportedProviderTypes(): ProviderType[] {
  return [...providerConstructors.keys()];
}
