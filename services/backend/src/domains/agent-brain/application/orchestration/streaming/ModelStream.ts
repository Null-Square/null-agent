import type OpenAI from 'openai';

import type { ChatProvider, ModelChunk, ModelStreamRequest, ModelStreamResult, ModelUsage, PreparedModelRequest, StreamToolCall } from '../../../ports';
import { recordLLMRequest, recordAPIError } from '@/shared/metrics/prometheusMetrics';
import { toSafeError } from '@/shared/errors';
import {
  attachProviderReasoning,
  buildProviderReasoningMetadata,
} from '../../../domain/reasoning/providerReasoning';
import { estimateTextTokens } from '../stages/helpers/messageUtils';
import {
  assertModelRequestDigest,
  canonicalizeModelRequestEnvelope,
} from '../../../domain/modelRequests/canonicalModelRequest';

type FunctionToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

import type {
  CacheIdentity,
  ProviderCacheProjection,
} from '../../../domain/cache';

type ModelStreamDeps = {
  provider: ChatProvider;
};

/** Defined on the port (`ports/modelStream.ts`); re-exported here so existing importers keep working. */
export type { PreparedModelRequest };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getErrorStatus = (error: unknown): number | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  const status = error['status'] ?? error['statusCode'];
  return typeof status === 'number' ? status : undefined;
};

const getErrorProviderRequestId = (error: unknown): string | undefined => {
  if (!isRecord(error)) return undefined;
  for (const key of ['request_id', 'requestId']) {
    const value = error[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const headers = error['headers'];
  if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
    const value = headers.get('x-request-id');
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

export class ModelStream {
  private readonly provider: ChatProvider;
  private model: string;
  public readonly providerName: string;

  constructor(deps: ModelStreamDeps) {
    this.provider = deps.provider;
    this.providerName = this.provider.name;
    this.model = 'unknown';
  }

  setModelName(name: string): void {
    if (typeof name === 'string' && name.trim().length > 0) {
      this.model = name.trim();
    }
  }

  getContextCapacity(): number {
    return this.provider.getCapabilities().contextWindow;
  }

  /**
   * E12 Slice A: the provider owns its own cache-surface projection because only the
   * adapter knows how the recorded envelope is translated onto the wire.
   */
  projectCacheSurface(
    envelope: Record<string, unknown>,
    identity: CacheIdentity,
  ): ProviderCacheProjection | undefined {
    return this.provider.projectCacheSurface?.({ envelope, identity });
  }

  prepare(request: ModelStreamRequest): PreparedModelRequest {
    const streamBody: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: request.messages,
      stream: true,
      stream_options: {
        include_usage: true,
      },
    };
    if (typeof request.maxTokens === 'number' && Number.isFinite(request.maxTokens) && request.maxTokens > 0) {
      streamBody.max_tokens = Math.floor(request.maxTokens);
    }
    if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) {
      streamBody.temperature = request.temperature;
    }
    if (request.stop !== undefined) {
      streamBody.stop = request.stop;
    }
    // Some providers reject an explicit empty tools array. Omit tools entirely when none are requested.
    if (request.tools.length > 0) {
      streamBody.tools = request.tools;
    }
    const decoratedBody = this.provider.decorateRequest(streamBody, {
      sessionId: request.sessionId,
      agentType: request.agentType,
      missionPhaseKey: request.missionPhaseKey,
    });
    const canonical = canonicalizeModelRequestEnvelope(
      decoratedBody as unknown as Record<string, unknown>,
    );
    return {
      envelope: canonical.envelope,
      digest: canonical.digest,
      signal: request.signal,
      onToken: request.onToken,
    };
  }

  async start(request: ModelStreamRequest): Promise<ModelStreamResult> {
    return this.startPrepared(this.prepare(request));
  }

  async startPrepared(request: PreparedModelRequest): Promise<ModelStreamResult> {
    // Verify before entering provider-specific error mapping so a local mutation cannot be
    // mistaken for an upstream failure and can never reach the transport.
    assertModelRequestDigest(request.envelope, request.digest);
    const llmStart = Date.now();
    let statusCode = 200; // Default to success
    let outputStarted = false;
    
    try {
      const client = this.provider.getClient();

      const stream = await client.chat.completions.create(
        request.envelope as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: request.signal },
      );

      const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: '',
      };

      const toolCalls: StreamToolCall[] = [];
      const chunks: ModelChunk[] = [];
      let finishReason: string | null | undefined;
      let preview = '';
      let totalChars = 0;
      let usage: ModelUsage | undefined;
      let reasoningContent = '';
      let providerRequestId: string | undefined;
      let reportedModel: string | undefined;

      for await (const chunk of stream) {
        providerRequestId ??= typeof chunk.id === 'string' ? chunk.id : undefined;
        reportedModel ??= typeof chunk.model === 'string' ? chunk.model : undefined;
        const usageChunk = (chunk as { usage?: unknown }).usage;
        if (usageChunk && isRecord(usageChunk)) {
          usage = this.provider.normalizeUsage(usageChunk) ?? usage;
        }

        const choice = chunk.choices[0];
        if (!choice) {
          continue;
        }

        const reasoningDelta = this.extractReasoningContent(choice.delta);
        if (reasoningDelta) {
          outputStarted = true;
          reasoningContent += reasoningDelta;
        }

        if (choice.delta?.content) {
          const contentDelta = this.extractContent(choice.delta.content);
          if (contentDelta) {
            outputStarted = true;
            chunks.push({ type: 'text', delta: contentDelta });
            totalChars += contentDelta.length;
            if (preview.length < 256) {
              preview += contentDelta.slice(0, 256 - preview.length);
            }
            request.onToken?.(contentDelta);
            const existing = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
            assistantMessage.content = existing + contentDelta;
          }
        }

        if (choice.delta?.tool_calls) {
          outputStarted = true;
          for (const toolCallDelta of choice.delta.tool_calls) {
            if (toolCallDelta.index === undefined) {
              continue;
            }
            if (!toolCalls[toolCallDelta.index]) {
              toolCalls[toolCallDelta.index] = {
                id: toolCallDelta.id ?? '',
                function: { name: '', arguments: '' },
              };
            }
            const call = toolCalls[toolCallDelta.index];
            if (toolCallDelta.id) {
              call.id = toolCallDelta.id;
            }
            if (toolCallDelta.function?.name) {
              call.function.name = toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              call.function.arguments += toolCallDelta.function.arguments;
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

      }

      const normalizedToolCalls: StreamToolCall[] = toolCalls
        .filter((call) => call.function?.name)
        .map((call) => ({
          id: call.id,
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        }));

      const toolCallMessages: FunctionToolCall[] = normalizedToolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }));

      if (toolCallMessages.length > 0) {
        assistantMessage.tool_calls = toolCallMessages;
        toolCallMessages.forEach((call) => {
          chunks.push({
            type: 'tool_call',
            name: call.function.name,
            args: call.function.arguments,
          });
        });
      }

      const reasoning = buildProviderReasoningMetadata({
        provider: this.providerName,
        model: this.model,
        content: reasoningContent,
      });
      attachProviderReasoning(assistantMessage, reasoning);
      const reportedReasoningTokens = usage?.completionTokensDetails?.reasoningTokens;
      const reasoningStats =
        reasoningContent.length > 0 || reportedReasoningTokens !== undefined
          ? {
              chars: reasoningContent.length,
              estimatedTokens: reasoningContent.length > 0 ? estimateTextTokens(reasoningContent) : 0,
              tokens: reportedReasoningTokens,
              estimated: reportedReasoningTokens === undefined,
              source: reportedReasoningTokens !== undefined ? 'reported' as const : 'estimated' as const,
            }
          : undefined;

      chunks.push({ type: 'done' });

      return {
        message: assistantMessage,
        content: typeof assistantMessage.content === 'string' ? assistantMessage.content : '',
        reasoning,
        toolCalls: normalizedToolCalls,
        totalChars,
        preview,
        finishReason,
        chunks,
        usage,
        providerRequestId,
        reportedModel,
        reasoningStats,
      };
    } catch (error: unknown) {
      // Capture error status for metrics
      statusCode = getErrorStatus(error) ?? 500;
      
      // Categorize error for API error counter
      const errorCategory = this.categorizeError(error);
      recordAPIError(errorCategory, this.providerName);

      const mapped = this.provider.mapError(error, { model: this.model, provider: this.providerName });
      Object.assign(mapped, {
        modelAttemptStatus: outputStarted || getErrorStatus(error) === undefined ? 'uncertain' : 'failed',
        modelOutputStarted: outputStarted,
        providerRequestId: getErrorProviderRequestId(error),
      });
      throw mapped;
    } finally {
      // Record LLM request to Prometheus histogram
      const llmDurationMs = Date.now() - llmStart;
      recordLLMRequest(this.providerName, this.model, llmDurationMs, statusCode);
    }
  }

  private categorizeError(error: unknown): string {
    const err = toSafeError(error);
    const message = err.message.toLowerCase();
    const status = getErrorStatus(error);

    if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
    if (status === 429 || message.includes('rate limit')) return 'rate_limit';
    if (status === 401 || status === 403) return 'auth';
    if (message.includes('context') && (message.includes('length') || message.includes('exceed'))) return 'context_too_large';
    if (typeof status === 'number' && status >= 500) return 'server_error';
    if (message.includes('network') || message.includes('econnrefused')) return 'network';
    return 'unknown';
  }

  private extractReasoningContent(delta: unknown): string {
    if (!isRecord(delta)) {
      return '';
    }
    const reasoning = delta['reasoning_content'];
    return typeof reasoning === 'string' ? reasoning : '';
  }

  private extractContent(content: string | Array<Record<string, unknown>>): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const isTextPart = (part: Record<string, unknown>): part is { type: 'text'; text?: string } =>
        part['type'] === 'text';
      return content
        .filter((part): part is Record<string, unknown> => isRecord(part))
        .filter(isTextPart)
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('');
    }
    return '';
  }
}
