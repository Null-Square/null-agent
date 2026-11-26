import type OpenAI from 'openai';
import type { ProviderReasoningMetadata } from '../domain/reasoning/providerReasoning';

export interface StreamToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export type ModelChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'done' };

export interface ModelStreamRequest {
  sessionId?: string;
  /**
   * Host-orchestrator turn identity. API transports may ignore it; external agent runtimes use it
   * to distinguish an ordinary same-turn tool continuation from a new host turn.
   */
  turnNumber?: number;
  agentType?: string;
  missionPhaseKey?: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  stop?: string | string[];
  onToken?: (delta: string) => void;
}

export interface ModelUsage {
  promptTokens: number;
  promptTokensDetails?: {
    cachedTokens?: number;
    cacheWriteTokens?: number;
  };
  completionTokens: number;
  completionTokensDetails?: { reasoningTokens?: number };
  totalTokens: number;
}

export interface ModelReasoningStats {
  chars: number;
  estimatedTokens: number;
  tokens?: number;
  estimated: boolean;
  source: 'reported' | 'estimated' | 'unavailable';
}

export interface ModelStreamResult {
  message: OpenAI.Chat.ChatCompletionMessageParam;
  content: string;
  reasoning?: ProviderReasoningMetadata;
  toolCalls: StreamToolCall[];
  totalChars: number;
  preview: string;
  finishReason?: string | null;
  chunks: ModelChunk[];
  usage?: ModelUsage;
  providerRequestId?: string;
  reportedModel?: string;
  reasoningStats?: ModelReasoningStats;
}

/**
 * A request that has been serialized and digested but not yet dispatched.
 *
 * This lives on the port rather than inside `ModelStream` because `ModelRuntime` prepares once
 * and dispatches per attempt (E4's atomic model request): the same prepared value crosses the
 * seam on every retry, so it is part of the contract, not an implementation detail of one
 * adapter. `envelope` carries the request's intent; an external runtime builds its own wire
 * payload from it.
 */
export interface PreparedModelRequest {
  envelope: Record<string, unknown>;
  digest: string;
  signal: AbortSignal;
  onToken?: (delta: string) => void;
}
