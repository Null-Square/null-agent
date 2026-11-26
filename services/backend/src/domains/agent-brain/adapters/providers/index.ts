/**
 * LLM Providers - Adapter implementations
 * 
 * This folder contains all LLM provider implementations.
 * 
 * @module agent-brain/adapters/providers
 */

// Provider interface (from ports)
export type {
  ChatProvider,
  ChatProviderPort,
  ProviderCapabilities,
  CacheIntent,
  BuildSystemMessagesParams,
  ChatCompletionRequest,
  ChatCompletionRequestInput,
  RawUsageResponse,
  ProviderErrorContext,
} from './ChatProvider';

// Base provider
export { BaseChatProvider } from './BaseChatProvider';

// Concrete providers
export { OpenAIChatProvider } from './OpenAIChatProvider';
export { QwenChatProvider } from './QwenChatProvider';
export { AnthropicChatProvider } from './anthropic';
export { DeepSeekChatProvider } from './DeepSeekChatProvider';
export { MoonshotChatProvider } from './MoonshotChatProvider';

// Provider factory and registry
export { ProviderFactory } from './ProviderFactory';
export { ProviderFactoryAdapter } from './ProviderFactoryAdapter';
export {
  createProviderByType,
  registerProvider,
  isProviderTypeSupported,
  getSupportedProviderTypes,
  type ProviderType,
} from './ProviderRegistry';
