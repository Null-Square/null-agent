import OpenAI from 'openai';
import {
  projectOpenAiCompatibleCacheSurface,
  type CacheIdentity,
  type ProviderCacheProjection,
} from '../../domain/cache';
import { LLM_REQUEST_MS } from '@/config/timeouts';
import { ERROR_CODES } from '@null-ai/contracts';
import type {
  ChatProvider,
  ProviderCapabilities,
  BuildSystemMessagesParams,
  RawUsageResponse,
  ChatCompletionRequest,
  ChatCompletionRequestInput,
  DecorateRequestContext,
  ProviderErrorContext,
} from './ChatProvider';
import type { ModelUsage } from '../../ports';
import type { ResolvedConfig } from '@/config/configTypes';
import { AppError, type ErrorContext, isAppError } from '../../domain/errors';
import { ErrorFactory } from '../../domain/errors';
import { CircuitOpenError } from '../../application/services/CircuitBreaker';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getStatus = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;
  const rawStatus = error['status'] ?? error['statusCode'];
  if (typeof rawStatus === 'number') return rawStatus;
  if (typeof rawStatus === 'string') {
    const parsed = Number(rawStatus);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const getName = (error: unknown): string => {
  if (error instanceof Error && error.name) return error.name;
  if (isRecord(error) && typeof error['name'] === 'string') return error['name'] as string;
  if (isRecord(error) && typeof error['type'] === 'string') return error['type'] as string;
  return '';
};

const getMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'] as string;
  return String(error ?? 'Unknown error');
};

const collectErrorSignals = (error: unknown, depth = 0): string => {
  if (depth > 4 || !error) {
    return '';
  }

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
  } else if (isRecord(error)) {
    if (typeof error['name'] === 'string') parts.push(error['name'] as string);
    if (typeof error['message'] === 'string') parts.push(error['message'] as string);
    if (typeof error['code'] === 'string') parts.push(error['code'] as string);
  }

  if (isRecord(error)) {
    const cause = error['cause'];
    if (cause) {
      parts.push(collectErrorSignals(cause, depth + 1));
    }
  }

  return parts.filter(Boolean).join(' ').toLowerCase();
};

const getHeaderValue = (headers: unknown, key: string): string | undefined => {
  if (!headers) return undefined;
  if (isRecord(headers) && typeof headers['get'] === 'function') {
    const value = (headers['get'] as (name: string) => string | null)(key);
    return value ?? undefined;
  }
  if (isRecord(headers)) {
    const value = headers[key] ?? headers[key.toLowerCase()];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
};

const getRetryAfterMs = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;
  const explicit = error['retryAfterMs'];
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit;
  }
  const headers = error['headers'] ?? (isRecord(error['response']) ? (error['response'] as Record<string, unknown>)['headers'] : undefined);
  const retryAfter = getHeaderValue(headers, 'retry-after');
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
};

const extractProviderFromCircuit = (circuitName: string): string => {
  if (circuitName.includes(':')) {
    const parts = circuitName.split(':');
    return parts[1] ?? circuitName;
  }
  return circuitName;
};

/**
 * Base implementation for ChatProvider with shared logic.
 * Providers extend this class and override only what's provider-specific.
 */
export abstract class BaseChatProvider implements ChatProvider {
  public abstract readonly name: string;
  protected readonly client: OpenAI;
  protected readonly config: ResolvedConfig;
  protected readonly requestProfile: Readonly<Record<string, unknown>>;

  protected abstract readonly capabilities: ProviderCapabilities;

  constructor(config: ResolvedConfig, requestProfile: Record<string, unknown> = {}) {
    this.config = config;
    this.requestProfile = Object.freeze({ ...requestProfile });
    this.client = new OpenAI({
      baseURL: config.runtime.apiBaseUrl,
      apiKey: config.runtime.apiKey,
      timeout: LLM_REQUEST_MS,
    });
  }

  getClient(): OpenAI {
    return this.client;
  }

  getCapabilities(): ProviderCapabilities {
    return { ...this.capabilities };
  }

  supportsCacheControl(): boolean {
    return this.capabilities.explicitCacheControl;
  }

  abstract buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[];

  decorateRequest(body: ChatCompletionRequestInput, _context?: DecorateRequestContext): ChatCompletionRequest {
    // Default: no-op, subclasses can override
    return body;
  }

  /**
   * E12: default projection for OpenAI-compatible transports, which receive the decorated
   * envelope essentially as-is. Anthropic overrides this because its shim restructures the
   * request after E4 records it.
   */
  projectCacheSurface(input: {
    envelope: Record<string, unknown>;
    identity: CacheIdentity;
  }): ProviderCacheProjection {
    return projectOpenAiCompatibleCacheSurface(input);
  }

  /**
   * Unified usage normalization - works for both OpenAI and Qwen response formats.
   */
  normalizeUsage(raw?: RawUsageResponse): ModelUsage | undefined {
    if (!raw) return undefined;
    
    const promptTokens = this.readNumber(raw.prompt_tokens) ?? this.readNumber(raw.promptTokens);
    const completionTokens = this.readNumber(raw.completion_tokens) ?? this.readNumber(raw.completionTokens);
    const totalTokens =
      this.readNumber(raw.total_tokens) ??
      this.readNumber(raw.totalTokens) ??
      (promptTokens ?? 0) + (completionTokens ?? 0);
    
    // Extract cached tokens from all possible locations
    const cachedTokens =
      this.readNumber(raw.prompt_tokens_details?.cached_tokens) ??
      this.readNumber(raw.promptTokensDetails?.cachedTokens) ??
      this.readNumber(raw.cached_prompt_tokens) ??
      this.readNumber(raw.cached_tokens);
    const cacheWriteTokens =
      this.readNumber(raw.prompt_tokens_details?.cache_write_tokens) ??
      this.readNumber(raw.promptTokensDetails?.cacheWriteTokens) ??
      this.readNumber(raw.cache_creation_input_tokens) ??
      this.readNumber(raw.cache_write_tokens);
    const reasoningTokens =
      this.readNumber(raw.completion_tokens_details?.reasoning_tokens) ??
      this.readNumber(raw.completionTokensDetails?.reasoningTokens);

    if (
      promptTokens === undefined &&
      completionTokens === undefined &&
      totalTokens === undefined &&
      cachedTokens === undefined &&
      cacheWriteTokens === undefined &&
      reasoningTokens === undefined
    ) {
      return undefined;
    }

    return {
      promptTokens: promptTokens ?? 0,
      promptTokensDetails:
        cachedTokens !== undefined || cacheWriteTokens !== undefined
          ? { cachedTokens, cacheWriteTokens }
          : undefined,
      completionTokens: completionTokens ?? 0,
      completionTokensDetails: reasoningTokens !== undefined ? { reasoningTokens } : undefined,
      totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    };
  }

  mapError(error: unknown, context: ProviderErrorContext = {}): AppError {
    if (isAppError(error)) {
      if (Object.keys(context).length === 0) {
        return error;
      }
      return AppError.wrap(error, error.message, { context });
    }

    if (error instanceof CircuitOpenError) {
      const provider = context.provider ?? extractProviderFromCircuit(error.circuitName) ?? this.name;
      return ErrorFactory.llm.providerUnavailable(provider, {
        retryAfterMs: error.retryAfterMs,
        context: { ...context, circuit: error.circuitName, provider },
        cause: error,
      });
    }

    const status = getStatus(error);
    const name = getName(error).toLowerCase();
    const message = getMessage(error);
    const lowerMessage = message.toLowerCase();
    const errorSignals = collectErrorSignals(error);
    const retryAfterMs = getRetryAfterMs(error);
    const cause = error instanceof Error ? error : undefined;
    const provider = context.provider ?? this.name;
    const baseContext: ErrorContext & { provider: string; status?: number; errorName?: string } = {
      ...context,
      provider,
      status,
      errorName: name || undefined,
    };

    const isTimeout =
      name.includes('timeout') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('timed out') ||
      (isRecord(error) && typeof error['code'] === 'string' && error['code'].toLowerCase() === 'etimedout');

    if (isTimeout) {
      return new AppError(ERROR_CODES.LLM_TIMEOUT, message, { retryAfterMs, context: baseContext, cause });
    }

    if (status === 429 || lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
      return ErrorFactory.llm.rateLimitExceeded({ retryAfterMs, context: baseContext, cause });
    }

    if (
      status === 401 ||
      status === 403 ||
      lowerMessage.includes('api key') ||
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('forbidden')
    ) {
      return ErrorFactory.auth.invalidApiKey({ context: baseContext, cause });
    }

    if (
      lowerMessage.includes('context') &&
      (lowerMessage.includes('length') || lowerMessage.includes('exceed') || lowerMessage.includes('too long'))
    ) {
      return new AppError(ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED, message, { context: baseContext, cause });
    }

    if (
      lowerMessage.includes('content filter') ||
      lowerMessage.includes('content policy') ||
      lowerMessage.includes('safety') ||
      lowerMessage.includes('datainspectionfailed') ||
      lowerMessage.includes('data inspection failed') ||
      lowerMessage.includes('inappropriate content')
    ) {
      return new AppError(ERROR_CODES.LLM_CONTENT_FILTER_TRIGGERED, message, { context: baseContext, cause });
    }

    const hasMalformedFunctionArguments =
      lowerMessage.includes('function.arguments') &&
      (lowerMessage.includes('json format') || lowerMessage.includes('json'));
    if (hasMalformedFunctionArguments) {
      return new AppError(ERROR_CODES.LLM_RESPONSE_PARSE_ERROR, message, {
        context: baseContext,
        cause,
      });
    }

    if (
      lowerMessage.includes('model') &&
      (lowerMessage.includes('invalid') || lowerMessage.includes('not found') || lowerMessage.includes('does not exist'))
    ) {
      return new AppError(ERROR_CODES.LLM_INVALID_MODEL, message, { context: baseContext, cause });
    }

    if (typeof status === 'number' && status >= 500) {
      return ErrorFactory.llm.providerUnavailable(provider, { retryAfterMs, context: baseContext, cause });
    }

    if (
      errorSignals.includes('network') ||
      errorSignals.includes('econnreset') ||
      errorSignals.includes('econnrefused') ||
      errorSignals.includes('enotfound') ||
      errorSignals.includes('dns') ||
      errorSignals.includes('socket hang up') ||
      errorSignals.includes('socket closed') ||
      errorSignals.includes('other side closed') ||
      errorSignals.includes('und_err_socket') ||
      errorSignals.includes('connection terminated') ||
      errorSignals.includes('terminated') ||
      errorSignals.includes('ssl')
    ) {
      return new AppError(ERROR_CODES.NETWORK_CONNECTION_FAILED, message, { retryAfterMs, context: baseContext, cause });
    }

    return new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, message, { context: baseContext, cause });
  }

  protected readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
