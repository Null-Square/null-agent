import type OpenAI from 'openai';
import type {
  BuildSystemMessagesParams,
  CacheIntent,
  ChatProvider,
  ProviderCapabilities,
} from '@/domains/agent-brain/adapters/providers';
import { ERROR_CODES } from '@null-ai/contracts';
import { AppError } from '@/domains/agent-brain/domain/errors';

type ProviderOverrides = Partial<ChatProvider>;

const defaultCapabilities: ProviderCapabilities = {
  explicitCacheControl: false,
  automaticCaching: false,
  contextWindow: 128000,
  maxOutputTokens: 4096,
  toolCalling: true,
  streaming: true,
  rateLimitHeaders: false,
};

export function createMockProvider(overrides: ProviderOverrides = {}): ChatProvider {
  return {
    name: overrides.name ?? 'mock-provider',
    getCapabilities: overrides.getCapabilities ?? (() => ({ ...defaultCapabilities })),
    getClient: overrides.getClient ?? (() => ({}) as OpenAI),
    buildSystemMessages:
      overrides.buildSystemMessages ??
      ((params: BuildSystemMessagesParams) => [
        { role: 'system', content: params.staticPrompt },
        { role: 'system', content: params.dynamicPrompt },
      ]),
    decorateRequest:
      overrides.decorateRequest ??
      ((body: Record<string, unknown>) => ({
        ...body,
        cacheIntent: (body.cacheIntent ?? overrides as unknown as CacheIntent),
      })),
    normalizeUsage: overrides.normalizeUsage ?? (() => undefined),
    mapError:
      overrides.mapError ??
      ((error: unknown) =>
        error instanceof AppError ? error : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))),
    supportsCacheControl: overrides.supportsCacheControl ?? (() => false),
  };
}

