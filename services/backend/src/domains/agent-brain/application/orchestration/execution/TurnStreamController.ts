import type OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { ModelStream } from '../streaming/ModelStream';
import type {
  ModelReasoningStats,
  ModelRequestPort,
  ModelUsage,
  StreamToolCall,
} from '../../../ports';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { SessionStore } from '../../core/SessionStore';
import type { StreamBroker } from '../streaming/StreamBroker';
import type { UsageRecorder } from '../../../infrastructure/usage/UsageRecorder';
import { ModelRuntime } from '../ModelRuntime';
import type { PersistenceCapability } from '../../../domain/runtime/RuntimeHostCapabilities';
import type { ContextMeasurementHints } from '../../../domain/context';
import type { Message } from '../../../domain/types';
import {
  attachProviderReasoning,
  getProviderReasoning,
  metadataWithProviderReasoning,
  redactProviderReasoningMetadata,
} from '../../../domain/reasoning/providerReasoning';
import type { TurnMetricsAccumulator } from './TurnMetricsAccumulator';
import {
  estimateChatMessagesTokens,
  estimateToolSchemaTokens,
} from './SameTurnCompactor';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { logger } from '@/shared/logger';
import { toSafeError } from '@/shared/errors';
import { summarizeForNote } from '@/shared/utils/text';
import { sha256Hex } from '@/shared/utils/hash';
import { hasXmlToolCalls, parseXmlToolCalls } from '../parsing';
import {
  formatMermaidErrors,
  validateMermaidInMarkdown,
  type MermaidValidationResult,
} from '@/shared/markdown/validateMermaid';
import {
  buildInterruptedToolRecoveryProjection,
  repairUnsafeInterruptedToolResult,
  type InterruptedToolExecutionEvidence,
  type InterruptedToolRecoveryEventV1,
  type InterruptedToolRecoverySource,
} from '../../../domain/recovery/interruptedToolResult';

// summarizeForNote imported from @/shared/utils/text

const extractToolName = (
  tool: OpenAI.Chat.Completions.ChatCompletionTool,
): string | undefined => {
  if ('function' in tool) {
    return tool.function?.name;
  }
  return undefined;
};

const MAX_INPUT_CHARS = 250_000;
const CHAT_MERMAID_REPAIR_MARKER = 'NULLSQUARE_MERMAID_REPAIR_REQUEST';
const CHAT_MERMAID_REPAIR_LIMIT = 2;
type ModelMessageSnapshotMode = 'minimal' | 'all' | 'none';

type MessageSnapshotState = {
  callsStarted: number;
  firstArtifact?: string;
  firstDigest?: string;
  finalArtifact?: string;
  finalDigest?: string;
};

const buildTokenTelemetry = (
  usage: ModelUsage | undefined,
  reasoningStats: ModelReasoningStats | undefined,
): Record<string, number | boolean> | undefined => {
  if (!usage) {
    return undefined;
  }

  return {
    input: usage.promptTokens,
    output: usage.completionTokens,
    cached: usage.promptTokensDetails?.cachedTokens ?? 0,
    total: usage.totalTokens,
    ...(reasoningStats
      ? {
          reasoning: reasoningStats.tokens ?? reasoningStats.estimatedTokens,
          reasoningEstimated: reasoningStats.estimated,
        }
      : {}),
  };
};

const getModelMessageSnapshotMode = (): ModelMessageSnapshotMode => {
  const raw = process.env.TRACE_MODEL_MESSAGE_SNAPSHOTS?.trim().toLowerCase();
  if (raw === 'all' || raw === 'none' || raw === 'minimal') {
    return raw;
  }
  return 'minimal';
};

const getAssistantToolCalls = (
  msg: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] => {
  if (msg.role !== 'assistant') {
    return [];
  }
  const assistantMsg = msg as OpenAI.Chat.ChatCompletionAssistantMessageParam;
  return Array.isArray(assistantMsg.tool_calls)
    ? assistantMsg.tool_calls.filter(
      (call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
        'function' in call,
    )
    : [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isReadOnlyChatSession = (session: ReturnType<SessionStore['get']>): boolean => {
  const securityops = isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;
  return securityops?.assistantMode === 'read_only_chat';
};

const getSecurityOpsPhaseKey = (session: ReturnType<SessionStore['get']>): string | undefined => {
  const securityops = isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;
  const phaseKey = securityops?.activePhaseKey;
  return typeof phaseKey === 'string' && phaseKey.trim().length > 0
    ? phaseKey.trim().toLowerCase()
    : undefined;
};

const messageContentToText = (content: OpenAI.Chat.ChatCompletionMessageParam['content']): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('\n');
};

const countChatMermaidRepairAttempts = (messages: OpenAI.Chat.ChatCompletionMessageParam[]): number =>
  messages.filter((message) => messageContentToText(message.content).includes(CHAT_MERMAID_REPAIR_MARKER)).length;

const buildChatMermaidRepairMessage = (validation: MermaidValidationResult): string => [
  CHAT_MERMAID_REPAIR_MARKER,
  'Your previous chat answer included invalid Mermaid syntax. Do not send that answer to the user.',
  'Rewrite the full answer now.',
  '',
  'Mermaid rules for the rewrite:',
  '- Keep a Mermaid diagram only if you can make it syntactically valid.',
  '- Prefer simple graph TD, flowchart TD, or sequenceDiagram syntax.',
  '- Avoid punctuation-heavy node ids; put prose in quoted labels.',
  '- If you are not certain the diagram is valid, omit Mermaid and use a Markdown table or bullet list instead.',
  '- Do not mention this validation request or the internal marker.',
  '',
  'Validation errors:',
  formatMermaidErrors(validation),
].join('\n');

const downgradeMermaidFencesToText = (markdown: string): string =>
  markdown.replace(
    /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*mermaid\b([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*$/gmu,
    (_match, indent: string, fence: string, _info: string, body: string) =>
      `${indent}${fence}text\n${body}\n${indent}${fence}`,
  );

const getToolCallIdFromMessage = (
  msg: OpenAI.Chat.ChatCompletionMessageParam,
): string | undefined => {
  if (msg.role !== 'tool') {
    return undefined;
  }
  const toolMsg = msg as OpenAI.Chat.ChatCompletionToolMessageParam;
  return typeof toolMsg.tool_call_id === 'string' ? toolMsg.tool_call_id : undefined;
};

const hashJson = (value: unknown): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return `sha256:${sha256Hex(serialized)}`;
};

const buildMessageBreakdown = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Array<Record<string, unknown>> =>
  messages.map((m, idx) => ({
    index: idx,
    role: m.role,
    contentLength: typeof m.content === 'string' ? m.content.length : 0,
    contentPreview: typeof m.content === 'string' ? m.content.slice(0, 150) : '[non-string]',
    hasToolCalls: getAssistantToolCalls(m).length > 0,
    toolCalls: getAssistantToolCalls(m).map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
    })),
    toolCallId: getToolCallIdFromMessage(m),
  }));

const normalizeToolCallArguments = (
  rawArguments: string | undefined,
): { argumentsJson: string; repaired: boolean } => {
  if (typeof rawArguments !== 'string') {
    return { argumentsJson: '{}', repaired: true };
  }

  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return { argumentsJson: '{}', repaired: true };
  }

  try {
    JSON.parse(trimmed);
    return { argumentsJson: trimmed, repaired: false };
  } catch {
    return { argumentsJson: '{}', repaired: true };
  }
};

const estimateMessageLength = (msg: OpenAI.Chat.ChatCompletionMessageParam): number => {
  if (typeof msg.content === 'string') {
    return msg.content.length;
  }
  return 0;
};

const trimMessagesByChars = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxChars: number,
): { messages: OpenAI.Chat.ChatCompletionMessageParam[]; trimmed: boolean } => {
  let acc = 0;
  let trimmed = false;
  const kept: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const len = estimateMessageLength(msg);
    if (acc + len > maxChars) {
      if (acc === 0 && typeof msg.content === 'string') {
        kept.push(attachProviderReasoning(
          { ...msg, content: msg.content.slice(-(maxChars - acc)) },
          getProviderReasoning(msg),
        ));
        trimmed = true;
        break;
      }
      trimmed = true;
      continue;
    }
    acc += len;
    kept.push(msg);
  }
  return { messages: kept.reverse(), trimmed };
};

/**
 * Validates message structure for OpenAI/Anthropic API compatibility.
 * Logs issues for debugging without throwing to allow recovery via sanitization.
 * 
 * Following industry observability patterns (OpenAI, Anthropic, Google):
 * - Pre-flight validation before expensive API calls
 * - Structured logging for issue diagnosis
 * - Non-blocking validation (issues are logged, not thrown)
 */
export const validateMessageStructure = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  requestContext?: { sessionId?: string; turnId?: string },
): {
  valid: boolean;
  issues: string[];
} => {
  const issues: string[] = [];

  // Track tool_call_ids and their responses
  const pendingToolCalls = new Map<string, number>(); // id -> assistant message index

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Check for assistant messages with tool_calls
    const toolCalls = getAssistantToolCalls(msg);
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const callId = call?.id;
        if (!callId || typeof callId !== 'string') {
          issues.push(`Message[${i}]: Assistant has tool_call with invalid/missing ID`);
        } else if (callId.includes('.role') || callId.includes('message[')) {
          issues.push(`Message[${i}]: Corrupted tool_call_id looks like error message: ${callId.slice(0, 50)}`);
        } else {
          pendingToolCalls.set(callId, i);
        }
      }
    }

    // Check for tool result messages
    if (msg.role === 'tool') {
      const toolCallId = getToolCallIdFromMessage(msg);
      if (!toolCallId || typeof toolCallId !== 'string') {
        issues.push(`Message[${i}]: Tool result has invalid/missing tool_call_id`);
      } else if (pendingToolCalls.has(toolCallId)) {
        pendingToolCalls.delete(toolCallId);
      } else {
        issues.push(`Message[${i}]: Orphan tool result for unknown tool_call_id: ${toolCallId.slice(0, 30)}`);
      }
    }
  }

  // Check for unresolved tool_calls
  for (const [callId, msgIdx] of pendingToolCalls) {
    issues.push(`Message[${msgIdx}]: Tool call ${callId.slice(0, 30)} has no corresponding result`);
  }

  // Log validation results for observability
  if (issues.length > 0) {
    logger.warn({
      event: 'message_validation_failed',
      component: 'TurnStreamController',
      sessionId: requestContext?.sessionId,
      turnId: requestContext?.turnId,
      issueCount: issues.length,
      issues: issues.slice(0, 10), // Limit to prevent log explosion
      totalMessages: messages.length,
      msg: `Message validation found ${issues.length} issues before API call`,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
};

/**
 * Sanitizes tool message ordering to match OpenAI/Anthropic requirements:
 * - Tool result messages must immediately follow the assistant message containing the tool_calls
 * - Tool results without matching tool_calls are dropped
 * - Messages are reordered if necessary to ensure proper sequence
 * - Missing tool results are replaced with placeholder error messages (prevents API errors)
 */
export const sanitizeToolOrdering = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: {
    source?: InterruptedToolRecoverySource;
    resolveEvidence?: (toolCallId: string) => InterruptedToolExecutionEvidence | undefined;
  } = {},
): {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  dropped: number;
  reordered: number;
  missingToolResults: string[];
  injectedPlaceholders: number;
  repairedToolCallArguments: number;
  recoveryEvents: InterruptedToolRecoveryEventV1[];
} => {
  const recoverySource = options.source ?? 'turn_stream_sanitizer';
  // Map tool_call_id -> the assistant message index that owns it
  const toolCallOwner = new Map<string, number>();
  // Map assistant message index -> list of tool results to insert after it
  const pendingToolResults = new Map<number, OpenAI.Chat.ChatCompletionMessageParam[]>();
  // Map assistant message index -> its index in the sanitized result array
  const ownerResultIndex = new Map<number, number>();
  // Track which assistant messages have tool_calls
  const assistantToolIndices: number[] = [];
  // Track all tool_call_ids we expect results for
  const allToolCallIds = new Set<string>();

  // First pass: build index of tool_call_ids to their owner assistant message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const toolCalls = getAssistantToolCalls(msg);
    if (toolCalls.length > 0) {
      assistantToolIndices.push(i);
      for (const call of toolCalls) {
        // CRITICAL: Validate tool_call has a proper string ID
        // Skip malformed entries (can happen from corrupted session data)
        const callId = call?.id;
        if (typeof callId === 'string' && callId.length > 0 && !callId.includes('.role')) {
          toolCallOwner.set(callId, i);
          allToolCallIds.add(callId);
        }
      }
    }
  }

  // Second pass: collect tool results and non-tool messages
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  let dropped = 0;
  let reordered = 0;
  let repairedToolCallArguments = 0;
  const respondedToolCallIds = new Set<string>();
  const recoveryEvents: InterruptedToolRecoveryEventV1[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'tool') {
      const toolCallId = getToolCallIdFromMessage(msg);
      const ownerIdx = toolCallId ? toolCallOwner.get(toolCallId) : undefined;

      if (ownerIdx !== undefined && toolCallId) {
        // Providers require one result per tool call. Retain the first durable result and
        // discard duplicates rather than projecting conflicting outcomes.
        if (respondedToolCallIds.has(toolCallId)) {
          dropped += 1;
          continue;
        }
        respondedToolCallIds.add(toolCallId);
        const upgraded = repairUnsafeInterruptedToolResult({
          toolCallId,
          content: msg.content,
          source: recoverySource,
        });
        const resultMessage = upgraded
          ? { ...msg, content: upgraded.content }
          : msg;
        if (upgraded) recoveryEvents.push(upgraded.event);
        // Store this tool result to be inserted after its owner
        if (!pendingToolResults.has(ownerIdx)) {
          pendingToolResults.set(ownerIdx, []);
        }
        pendingToolResults.get(ownerIdx)!.push(resultMessage);
      } else {
        dropped += 1;
      }
      continue;
    }

    // Add non-tool messages
    // CRITICAL: Filter corrupted tool_calls from assistant messages before adding
    let insertedMessage: OpenAI.Chat.ChatCompletionMessageParam | undefined;
    if (msg.role === 'assistant') {
      const toolCalls = getAssistantToolCalls(msg);
      if (toolCalls.length > 0) {
        // Filter out corrupted tool_calls
        const validToolCalls = toolCalls.filter((call) => {
          const callId = call?.id;
          return typeof callId === 'string' &&
            callId.length > 0 &&
            !callId.includes('.role') &&
            !callId.includes('message[');
        });

        if (validToolCalls.length === 0) {
          // All tool_calls were corrupted - remove the property entirely
          const { tool_calls: _toolCalls, ...cleanMsg } = msg as OpenAI.Chat.ChatCompletionAssistantMessageParam;
          insertedMessage = attachProviderReasoning(cleanMsg, getProviderReasoning(msg));
          result.push(insertedMessage);
        } else {
          const normalizedToolCalls = validToolCalls.map((call) => {
            const normalized = normalizeToolCallArguments(call.function?.arguments);
            if (!normalized.repaired && normalized.argumentsJson === call.function.arguments) {
              return call;
            }
            if (normalized.repaired) {
              repairedToolCallArguments += 1;
            }
            return {
              ...call,
              function: {
                ...call.function,
                arguments: normalized.argumentsJson,
              },
            };
          });

          const filteredCorruptedToolCalls = validToolCalls.length < toolCalls.length;
          const repairedArguments = normalizedToolCalls.some((call, idx) => call !== validToolCalls[idx]);

          if (validToolCalls.length < toolCalls.length) {
            // Some tool_calls were corrupted - use only valid ones
            logger.warn({
              event: 'corrupted_tool_calls_filtered',
              component: 'sanitizeToolOrdering',
              original: toolCalls.length,
              kept: validToolCalls.length,
              msg: `Filtered ${toolCalls.length - validToolCalls.length} corrupted tool_calls from assistant message`,
            });
          }

          if (filteredCorruptedToolCalls || repairedArguments) {
            const cleanMsg = attachProviderReasoning(
              { ...msg, tool_calls: normalizedToolCalls },
              getProviderReasoning(msg),
            );
            insertedMessage = cleanMsg;
            result.push(insertedMessage);
          } else {
            // All tool_calls are valid
            insertedMessage = msg;
            result.push(insertedMessage);
          }
        }
      } else {
        insertedMessage = msg;
        result.push(insertedMessage);
      }
    } else {
      insertedMessage = msg;
      result.push(insertedMessage);
    }

    if (insertedMessage && assistantToolIndices.includes(i)) {
      ownerResultIndex.set(i, result.length - 1);
    }

    // If this was an assistant+tools message, insert its tool results right after
    if (assistantToolIndices.includes(i) && pendingToolResults.has(i)) {
      result.push(...pendingToolResults.get(i)!);
      pendingToolResults.delete(i);
    }
  }

  // Handle any remaining tool results that came before their owner was processed
  // (this means we had to reorder them)
  const trailingInsertions = [...pendingToolResults.entries()].sort(
    ([leftOwnerIdx], [rightOwnerIdx]) =>
      (ownerResultIndex.get(rightOwnerIdx) ?? -1) - (ownerResultIndex.get(leftOwnerIdx) ?? -1),
  );
  for (const [ownerIdx, tools] of trailingInsertions) {
    const resultIdx = ownerResultIndex.get(ownerIdx) ?? -1;
    if (resultIdx !== -1) {
      result.splice(resultIdx + 1, 0, ...tools);
      reordered += tools.length;
    } else {
      // Owner not in result (shouldn't happen), drop these
      dropped += tools.length;
    }
  }

  // Find tool_calls that don't have corresponding results
  const missingToolResults: string[] = [];
  for (const toolCallId of allToolCallIds) {
    if (!respondedToolCallIds.has(toolCallId)) {
      missingToolResults.push(toolCallId);
    }
  }

  // CRITICAL FIX: Inject placeholder results for missing tool_calls
  // This prevents LLM API errors like "tool_calls must be followed by tool messages"
  // This can happen after watchdog timeout, crash recovery, turn timeout, or interrupted turns
  let injectedPlaceholders = 0;

  // Group missing tool_calls by their owner assistant message index
  const missingByOwner = new Map<number, string[]>();
  for (const missingId of missingToolResults) {
    const ownerIdx = toolCallOwner.get(missingId);
    if (ownerIdx === undefined) continue;

    if (!missingByOwner.has(ownerIdx)) {
      missingByOwner.set(ownerIdx, []);
    }
    missingByOwner.get(ownerIdx)!.push(missingId);
  }

  // Find assistant messages with tool_calls in result and inject placeholders
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    const toolCalls = getAssistantToolCalls(msg);

    if (msg.role !== 'assistant' || toolCalls.length === 0) {
      continue;
    }

    // Check each tool_call in this message
    for (const call of toolCalls) {
      const callId = call?.id;
      if (!callId) continue;

      // Check if this tool_call is missing a result
      if (missingToolResults.includes(callId)) {
        // Find the insertion point (after all existing tool results for this assistant message)
        let insertIdx = i + 1;
        while (insertIdx < result.length && result[insertIdx].role === 'tool') {
          insertIdx++;
        }

        // Inject placeholder
        const projection = buildInterruptedToolRecoveryProjection({
          toolCallId: callId,
          source: recoverySource,
          evidence: options.resolveEvidence?.(callId),
        });
        const placeholder: OpenAI.Chat.ChatCompletionMessageParam = {
          role: 'tool',
          tool_call_id: callId,
          content: projection.content,
        };

        result.splice(insertIdx, 0, placeholder);
        injectedPlaceholders++;
        recoveryEvents.push(projection.event);

        // Remove from missing list to avoid duplicate injection
        const idx = missingToolResults.indexOf(callId);
        if (idx !== -1) {
          missingToolResults.splice(idx, 1);
        }
      }
    }
  }

  // Log validation diagnostics (following OpenAI/Anthropic observability patterns)
  if (injectedPlaceholders > 0 || missingToolResults.length > 0) {
    logger.warn({
      event: 'message_sanitization',
      component: 'TurnStreamController',
      injectedPlaceholders,
      repairedToolCallArguments,
      missingToolResultsRemaining: missingToolResults.length,
      totalToolCalls: allToolCallIds.size,
      totalToolResults: respondedToolCallIds.size,
      droppedMessages: dropped,
      reorderedMessages: reordered,
      // Include sample IDs for debugging (limit to avoid log explosion)
      sampleMissingIds: missingToolResults.slice(0, 3),
      msg: 'Sanitized message history - injected placeholders for missing tool results',
    });
  }

  if (repairedToolCallArguments > 0) {
    logger.warn({
      event: 'malformed_tool_call_args_repaired',
      component: 'sanitizeToolOrdering',
      repairedToolCallArguments,
      msg: `Repaired ${repairedToolCallArguments} malformed tool_call argument payload(s)`,
    });
  }

  return {
    messages: result,
    dropped,
    reordered,
    missingToolResults,
    injectedPlaceholders,
    repairedToolCallArguments,
    recoveryEvents,
  };
};

export type StreamControllerDeps = {
  model: ModelStream | null;
  sessionStore: SessionStore;
  usageRecorder: UsageRecorder;
  modelRuntime?: ModelRuntime;
  resolveInterruptedToolEvidence?: (
    sessionId: string,
    toolCallId: string,
  ) => InterruptedToolExecutionEvidence | undefined;
  resolveModelRequestPersistence?: (sessionId: string) => {
    port?: ModelRequestPort;
    capability?: PersistenceCapability;
    runId?: string;
    stepId?: string;
    routedContextCapacity?: number;
  };
};

export type StreamControllerArgs = {
  sessionId: string;
  turnNumber: number;
  abortSignal: AbortSignal;
  currentMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[];
  stream: StreamBroker;
  recorder?: SessionTraceRecorder;
  modelName?: string;
  configuredModelName: string;
  maxTokens?: number;
  temperature?: number;
  contextMeasurementHints?: ContextMeasurementHints;
  transformationRefs?: string[];
  onHeartbeat?: () => void;
  /** Optional metrics accumulator for wide turn events */
  metricsAccumulator?: TurnMetricsAccumulator;
};

export type StreamControllerResult = {
  toolCalls: StreamToolCall[];
  currentMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  doneEmitted: boolean;
  toolCallCount: number;
  messagesLength: number;
  /** Immutable E4 request that produced the returned tool calls. */
  modelRequestId?: string;
  assistantText?: string;
  usage?: {
    promptTokens: number;
    promptTokensDetails?: { cachedTokens?: number };
    completionTokens: number;
    totalTokens: number;
  };
  status?: 'completed' | 'retry_mermaid_validation';
  mermaidValidation?: {
    attempts: number;
    retryLimit: number;
    blocks: number;
    errors: string;
    downgraded?: boolean;
  };
  /**
   * Pending assistant message with tool_calls for atomic persistence.
   * This message should be persisted AFTER all tool results are collected.
   * Used by TurnRunner to batch persist assistant + tool results atomically.
   * Note: This message will have tool_calls set (it's an assistant message with tool calls).
   */
  pendingAssistantMessage?: Message;
};

export class TurnStreamController {
  private deps: StreamControllerDeps;
  private readonly modelRuntime: ModelRuntime;
  private readonly callOrdinals = new Map<string, number>();
  private readonly toolSnapshotArtifactCache = new Map<string, string>();
  private readonly messageSnapshotState = new Map<string, MessageSnapshotState>();

  constructor(deps: StreamControllerDeps) {
    this.deps = deps;
    this.modelRuntime = deps.modelRuntime ?? new ModelRuntime();
  }

  /** Set the model stream (for lazy initialization) */
  setModel(model: ModelStream): void {
    this.deps = { ...this.deps, model };
  }

  private writeToolSnapshotArtifact(
    recorder: SessionTraceRecorder,
    sessionId: string,
    turnNumber: number,
    configuredModelName: string,
    toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[],
    toolDigest: string,
  ): string | undefined {
    const cacheKey = `${sessionId}:${turnNumber}:${configuredModelName}:${toolDigest}`;
    const cached = this.toolSnapshotArtifactCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const artifact = recorder.writeJsonArtifact(
      sessionId,
      `model-call-turn-${turnNumber}-tools-${toolDigest.replace(/^sha256:/, '').slice(0, 12)}`,
      {
        model: configuredModelName,
        turn: turnNumber,
        toolDigest,
        tools: toolDefinitions,
      },
    );
    if (artifact) {
      if (this.toolSnapshotArtifactCache.size > 500) {
        this.toolSnapshotArtifactCache.clear();
      }
      this.toolSnapshotArtifactCache.set(cacheKey, artifact);
    }
    return artifact;
  }

  private getMessageSnapshotState(
    sessionId: string,
    turnNumber: number,
    configuredModelName: string,
  ): MessageSnapshotState {
    const cacheKey = `${sessionId}:${turnNumber}:${configuredModelName}`;
    const cached = this.messageSnapshotState.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (this.messageSnapshotState.size > 500) {
      this.messageSnapshotState.clear();
    }
    const state: MessageSnapshotState = { callsStarted: 0 };
    this.messageSnapshotState.set(cacheKey, state);
    return state;
  }

  private writeMessageSnapshotArtifact(
    recorder: SessionTraceRecorder,
    sessionId: string,
    turnNumber: number,
    configuredModelName: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    messageBreakdown: Array<Record<string, unknown>>,
    messageDigest: string,
    snapshotKind: string,
    callOrdinal: number,
  ): string | undefined {
    return recorder.writeJsonArtifact(
      sessionId,
      `model-call-turn-${turnNumber}-messages-${snapshotKind}`,
      {
        model: configuredModelName,
        turn: turnNumber,
        snapshotKind,
        callOrdinal,
        messageDigest,
        messageBreakdown,
        messages,
      },
    );
  }

  private writeFirstMessageSnapshotArtifact(
    recorder: SessionTraceRecorder,
    sessionId: string,
    turnNumber: number,
    configuredModelName: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    messageBreakdown: Array<Record<string, unknown>>,
    messageDigest: string,
    state: MessageSnapshotState,
    callOrdinal: number,
  ): string | undefined {
    if (state.firstArtifact) {
      return undefined;
    }
    const artifact = this.writeMessageSnapshotArtifact(
      recorder,
      sessionId,
      turnNumber,
      configuredModelName,
      messages,
      messageBreakdown,
      messageDigest,
      'first',
      callOrdinal,
    );
    if (artifact) {
      state.firstArtifact = artifact;
      state.firstDigest = messageDigest;
    }
    return artifact;
  }

  private writeFinalMessageSnapshotArtifact(
    recorder: SessionTraceRecorder,
    sessionId: string,
    turnNumber: number,
    configuredModelName: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    messageBreakdown: Array<Record<string, unknown>>,
    messageDigest: string,
    state: MessageSnapshotState,
    callOrdinal: number,
  ): string | undefined {
    if (state.firstDigest === messageDigest && state.firstArtifact) {
      return state.firstArtifact;
    }
    if (state.finalDigest === messageDigest && state.finalArtifact) {
      return state.finalArtifact;
    }
    const artifact = this.writeMessageSnapshotArtifact(
      recorder,
      sessionId,
      turnNumber,
      configuredModelName,
      messages,
      messageBreakdown,
      messageDigest,
      'final',
      callOrdinal,
    );
    if (artifact) {
      state.finalArtifact = artifact;
      state.finalDigest = messageDigest;
    }
    return artifact;
  }

  private writeErrorMessageSnapshotArtifact(
    recorder: SessionTraceRecorder,
    sessionId: string,
    turnNumber: number,
    configuredModelName: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    messageBreakdown: Array<Record<string, unknown>>,
    messageDigest: string,
    state: MessageSnapshotState,
    callOrdinal: number,
  ): string | undefined {
    if (state.firstDigest === messageDigest && state.firstArtifact) {
      return state.firstArtifact;
    }
    if (state.finalDigest === messageDigest && state.finalArtifact) {
      return state.finalArtifact;
    }
    return this.writeMessageSnapshotArtifact(
      recorder,
      sessionId,
      turnNumber,
      configuredModelName,
      messages,
      messageBreakdown,
      messageDigest,
      'error',
      callOrdinal,
    );
  }

  async run(args: StreamControllerArgs): Promise<StreamControllerResult> {
    const {
      sessionId,
      turnNumber,
      abortSignal,
      currentMessages,
      toolDefinitions,
      stream,
      recorder,
      modelName,
      configuredModelName,
      maxTokens,
      temperature,
      metricsAccumulator,
    } = args;

    const toolCallCount = 0;
    const doneEmitted = false;
    let workingMessages = [...currentMessages];

    const { messages: limitedMessages, trimmed } = trimMessagesByChars(
      workingMessages,
      MAX_INPUT_CHARS,
    );
    workingMessages = limitedMessages;
    if (trimmed && recorder) {
      await recorder.write(sessionId, turnNumber, {
        event: 'input.truncated',
        severity: 'warn',
        payload: {
          maxChars: MAX_INPUT_CHARS,
          messages: workingMessages.length,
        },
        note: `input truncated to ${MAX_INPUT_CHARS} chars`,
      });
    }

    const {
      messages: sanitizedMessages,
      dropped,
      reordered,
      missingToolResults,
      injectedPlaceholders,
      repairedToolCallArguments,
      recoveryEvents,
    } = sanitizeToolOrdering(workingMessages, {
      source: 'turn_stream_sanitizer',
      resolveEvidence: (toolCallId) =>
        this.deps.resolveInterruptedToolEvidence?.(sessionId, toolCallId),
    });
    workingMessages = sanitizedMessages;

    void reordered;

    // Log if orphan tool messages were dropped
    if (dropped > 0 && recorder) {
      await recorder.write(sessionId, turnNumber, {
        event: 'input.sanitized',
        severity: 'warn',
        payload: { droppedToolMessages: dropped },
        note: `dropped ${dropped} orphan tool message(s)`,
      });
    }

    // Record exactly one typed recovery event for each repaired result.
    if (recorder) {
      for (const recoveryEvent of recoveryEvents) {
        await recorder.write(sessionId, turnNumber, {
          event: 'input.recovery.interrupted_tool_result',
          severity: 'warn',
          payload: recoveryEvent,
          note: `repaired interrupted tool result as ${recoveryEvent.decision}`,
        });
      }
    }

    if (repairedToolCallArguments > 0 && recorder) {
      await recorder.write(sessionId, turnNumber, {
        event: 'input.sanitized.tool_call_args_repaired',
        severity: 'warn',
        payload: {
          repairedToolCallArguments,
        },
        note: `repaired ${repairedToolCallArguments} malformed tool_call argument payload(s)`,
      });
    }

    // Log validation warning if tool_calls don't have matching results
    // (Now just informational since we inject placeholders to fix this)
    if (missingToolResults.length > 0 && recorder && injectedPlaceholders === 0) {
      await recorder.write(sessionId, turnNumber, {
        event: 'input.validation.missing_tool_results',
        severity: 'warn',
        payload: { missingToolCallIds: missingToolResults },
        note: `${missingToolResults.length} tool_call(s) have no matching tool result: ${missingToolResults.join(', ')}`,
      });
    }

    const model = this.deps.model;
    if (!model) {
      throw new Error('ModelStream not set');
    }

    const callStartedAt = Date.now();
    /**
     * When the first streamed output token arrived, if one ever did.
     *
     * The only finer measurement than per-call latency this code had was none:
     * a slow first token and a slow generation were the same number, so nothing
     * downstream could tell a queued provider from a long answer. This is the
     * cheapest place to separate them — the token callback is already on the
     * hot path.
     *
     * A call that streams no text (a response that is only tool calls) leaves
     * this undefined, and undefined is carried through as absent rather than
     * substituted with the call latency.
     */
    let firstTokenAtMs: number | undefined;
    let messageBreakdown: Array<Record<string, unknown>> | undefined;
    const messageDigest = hashJson(workingMessages);
    const toolDigest = hashJson(toolDefinitions);
    let messageSnapshotState: MessageSnapshotState | undefined;
    const callOrdinalKey = `${sessionId}:${turnNumber}`;
    const modelCallOrdinal = (this.callOrdinals.get(callOrdinalKey) ?? 0) + 1;
    this.callOrdinals.set(callOrdinalKey, modelCallOrdinal);
    let startMessageSnapshotArtifact: string | undefined;
    const messageSnapshotMode = getModelMessageSnapshotMode();
    if (recorder) {
      const toolNames = toolDefinitions
        .map((tool) => extractToolName(tool))
        .filter((name): name is string => Boolean(name));
      messageBreakdown = buildMessageBreakdown(workingMessages);
      messageSnapshotState = this.getMessageSnapshotState(sessionId, turnNumber, configuredModelName);
      messageSnapshotState.callsStarted = modelCallOrdinal;
      const estimatedMessageTokens = estimateChatMessagesTokens(workingMessages);
      const estimatedToolSchemaTokens = estimateToolSchemaTokens(toolDefinitions);
      if (messageSnapshotMode === 'all') {
        startMessageSnapshotArtifact = this.writeMessageSnapshotArtifact(
          recorder,
          sessionId,
          turnNumber,
          configuredModelName,
          workingMessages,
          messageBreakdown,
          messageDigest,
          `call-${modelCallOrdinal}`,
          modelCallOrdinal,
        );
      } else if (messageSnapshotMode === 'minimal') {
        startMessageSnapshotArtifact = this.writeFirstMessageSnapshotArtifact(
          recorder,
          sessionId,
          turnNumber,
          configuredModelName,
          workingMessages,
          messageBreakdown,
          messageDigest,
          messageSnapshotState,
          modelCallOrdinal,
        );
      }
      const toolSnapshotArtifact = this.writeToolSnapshotArtifact(
        recorder,
        sessionId,
        turnNumber,
        configuredModelName,
        toolDefinitions,
        toolDigest,
      );
      await recorder.write(sessionId, turnNumber, {
        event: 'model.call.start',
        severity: 'info',
        payload: {
          model: configuredModelName,
          messages: workingMessages.length,
          messageDigest,
          messageShape: workingMessages.map((message) => message.role).join(' -> '),
          messageBreakdownPreview: messageBreakdown.slice(-8),
          messageSnapshotMode,
          tools: toolNames,
          toolCount: toolDefinitions.length,
          toolDigest,
          estimatedTokens: {
            messages: estimatedMessageTokens,
            tools: estimatedToolSchemaTokens,
            total: estimatedMessageTokens + estimatedToolSchemaTokens,
          },
          provider: model.providerName,
        },
        links: {
          ...(startMessageSnapshotArtifact ? { messages: startMessageSnapshotArtifact } : {}),
          ...(toolSnapshotArtifact ? { tools: toolSnapshotArtifact } : {}),
        },
        note: `model=${configuredModelName}`,
      });
    }

    if (modelName) {
      model.setModelName(modelName);
      this.deps.usageRecorder.setModelName(modelName);
    }

    let streamResult: Awaited<ReturnType<ModelStream['start']>>;
    let usageSummary: Awaited<ReturnType<UsageRecorder['recordUsage']>>;
    let modelRequestId: string | undefined;

    try {
      const requestPersistence = this.deps.resolveModelRequestPersistence?.(sessionId);
      const session = this.deps.sessionStore.get(sessionId);
      const runtimeResult = await this.modelRuntime.execute({
        model,
        usageRecorder: this.deps.usageRecorder,
        traceRecorder: recorder,
        sessionId,
        turn: turnNumber,
        callOrdinal: modelCallOrdinal,
        configuredModelName: modelName ?? configuredModelName,
        modelRequestPort: requestPersistence?.port,
        modelRequestCapability: requestPersistence?.capability,
        runId: requestPersistence?.runId,
        stepId: requestPersistence?.stepId,
        routedContextCapacity: requestPersistence?.routedContextCapacity,
        contextMeasurementHints: args.contextMeasurementHints,
        contextMeasurementRefs: isRecord(session?.flags?.context_budget_last)
          ? [`session:${sessionId}:flags/context_budget_last`]
          : [],
        transformationRefs: [
          ...(args.transformationRefs ?? []),
          `messages:${messageDigest}`,
          `tools:${toolDigest}`,
        ],
        request: {
          sessionId,
          agentType: this.deps.sessionStore.get(sessionId)?.agentType,
          missionPhaseKey: getSecurityOpsPhaseKey(this.deps.sessionStore.get(sessionId)),
          messages: workingMessages,
          tools: toolDefinitions,
          signal: abortSignal,
          maxTokens,
          temperature,
          onToken: (delta) => {
            firstTokenAtMs ??= Date.now();
            args.onHeartbeat?.();
            stream.token(delta);
          },
        },
      });
      streamResult = runtimeResult.result;
      usageSummary = runtimeResult.usageSummary;
      modelRequestId = runtimeResult.requestId;
    } catch (error: unknown) {
      const err = toSafeError(error);
      const callLatencyMs = Date.now() - callStartedAt;
      if (recorder) {
        const errorMessageSnapshotArtifact =
          messageBreakdown && messageDigest && messageSnapshotState
            ? this.writeErrorMessageSnapshotArtifact(
                recorder,
                sessionId,
                turnNumber,
                configuredModelName,
                workingMessages,
                messageBreakdown,
                messageDigest,
                messageSnapshotState,
                modelCallOrdinal,
              )
            : undefined;
        await recorder.write(sessionId, turnNumber, {
          event: 'model.call.error',
          severity: 'error',
          payload: {
            model: configuredModelName,
            message: err.message,
            latencyMs: callLatencyMs,
            retryCount: 0,
          },
          links: {
            ...(errorMessageSnapshotArtifact ? { messages: errorMessageSnapshotArtifact } : {}),
          },
          note: summarizeForNote(err.message || 'model call error'),
        });
      }
      throw err;
    }
    const callLatencyMs = Date.now() - callStartedAt;
    const ttftMs = firstTokenAtMs === undefined ? undefined : firstTokenAtMs - callStartedAt;
    this.deps.usageRecorder.recordTurnLatency(sessionId, callLatencyMs);
    if (usageSummary) {
      stream.raw('usage.recorded', {
        turn: turnNumber,
        // D7 - this event and the trace event of the same name used to disagree about what
        // `promptTokens` meant. Both now carry the explicit names; `promptTokens` keeps its
        // established meaning here of uncached input, and nothing new should read it.
        inputTokensTotal: usageSummary.inputTokensTotal,
        uncachedInputTokens: usageSummary.uncachedInputTokens,
        cacheReadTokens: usageSummary.cacheReadTokens,
        cacheWriteTokens: usageSummary.cacheWriteTokens,
        outputTokens: usageSummary.outputTokens,
        reasoningTokens: usageSummary.reasoningTokens,
        promptTokens: usageSummary.promptTokens,
        cachedPromptTokens: usageSummary.cachedPromptTokens,
        completionTokens: usageSummary.completionTokens,
        totalTokens: usageSummary.totalTokens,
        nativeCost: usageSummary.nativeCost,
        overhead: usageSummary.overhead,
        platformCost: usageSummary.platformCost,
        platformPrice: usageSummary.platformPrice,
        credits: usageSummary.credits,
        currency: usageSummary.currency,
        model: usageSummary.model,
      });
    }
    const cachedTokens = streamResult.usage?.promptTokensDetails?.cachedTokens ?? 0;
    opsMetrics.recordCacheResult(cachedTokens > 0 ? 'hit' : 'miss', cachedTokens);

    // Record LLM call metrics for wide turn events
    if (metricsAccumulator && streamResult.usage) {
      metricsAccumulator.recordLlmCall({
        inputTokens: streamResult.usage.promptTokens,
        outputTokens: streamResult.usage.completionTokens,
        cachedTokens,
        latencyMs: callLatencyMs,
        ...(ttftMs === undefined ? {} : { ttftMs }),
      });
    }
    if (metricsAccumulator && usageSummary) {
      metricsAccumulator.recordBilling({
        nativeCostUsd: usageSummary.nativeCost,
        overheadUsd: usageSummary.overhead,
        platformCostUsd: usageSummary.platformCost,
        platformPriceUsd: usageSummary.platformPrice,
        creditsUsed: usageSummary.credits,
        currency: usageSummary.currency,
      });
    }

    const { message, content: initialContent, toolCalls: initialToolCalls } = streamResult;
    let fullAssistantMessage = message;
    let content = initialContent;
    let toolCalls = initialToolCalls;
    let assistantText = '';

    // XML TOOL CALL FALLBACK: Parse XML-style tool calls from cheap models
    // Many open-source models (Qwen, Llama, Deepseek) output XML format instead of native function calls
    // This has zero overhead for models that use native tool calls
    if (toolCalls.length === 0 && content && hasXmlToolCalls(content)) {
      const parseResult = parseXmlToolCalls(content);
      if (parseResult.hasXmlToolCalls) {
        toolCalls = parseResult.toolCalls;
        content = parseResult.cleanedText || '';
        
        // Update the full assistant message to reflect parsed tool calls
        // Convert StreamToolCall to ChatCompletionMessageToolCall (add 'type' property)
        fullAssistantMessage = {
          role: 'assistant' as const,
          content: content || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: tc.function,
          })),
        };
        attachProviderReasoning(fullAssistantMessage, streamResult.reasoning);

        if (recorder) {
          await recorder.write(sessionId, turnNumber, {
            event: 'xml_tool_calls.parsed',
            severity: 'info',
            payload: {
              parsedCount: toolCalls.length,
              toolNames: toolCalls.map(tc => tc.function.name),
            },
            note: `Parsed ${toolCalls.length} XML tool call(s): ${toolCalls.map(tc => tc.function.name).join(', ')}`,
          });
        }

        logger.info({
          sessionId,
          turnNumber,
          parsedToolCalls: toolCalls.length,
          toolNames: toolCalls.map(tc => tc.function.name),
        }, '[TurnStreamController] XML tool calls parsed from model output');
      }
    }

    assistantText = typeof content === 'string' ? content.trim() : '';

    if (assistantText.length > 0 && toolCalls.length === 0 && isReadOnlyChatSession(this.deps.sessionStore.get(sessionId))) {
      const mermaidValidation = await validateMermaidInMarkdown(assistantText);
      if (!mermaidValidation.ok) {
        const attempts = countChatMermaidRepairAttempts(workingMessages);
        const errorSummary = formatMermaidErrors(mermaidValidation);

        if (attempts < CHAT_MERMAID_REPAIR_LIMIT) {
          const repairMessage: OpenAI.Chat.ChatCompletionMessageParam = {
            role: 'user',
            content: buildChatMermaidRepairMessage(mermaidValidation),
          };
          const retryMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            ...workingMessages,
            { role: 'assistant', content: assistantText },
            repairMessage,
          ];

          if (recorder) {
            await recorder.write(sessionId, turnNumber, {
              event: 'assistant.mermaid_validation_retry',
              severity: 'warn',
              payload: {
                attempts: attempts + 1,
                retryLimit: CHAT_MERMAID_REPAIR_LIMIT,
                blocks: mermaidValidation.blocks,
                errors: mermaidValidation.errors.map((error) => ({
                  blockIndex: error.blockIndex,
                  startLine: error.startLine,
                  errorLine: error.errorLine,
                  message: error.message,
                })),
              },
              note: `invalid Mermaid in chat response; repair retry ${attempts + 1}/${CHAT_MERMAID_REPAIR_LIMIT}`,
            });
          }

          return {
            status: 'retry_mermaid_validation',
            toolCalls: [],
            currentMessages: retryMessages,
            doneEmitted,
            toolCallCount: 0,
            messagesLength: this.deps.sessionStore.get(sessionId)?.messages.length ?? 0,
            usage: streamResult.usage,
            assistantText,
            mermaidValidation: {
              attempts: attempts + 1,
              retryLimit: CHAT_MERMAID_REPAIR_LIMIT,
              blocks: mermaidValidation.blocks,
              errors: errorSummary,
            },
          };
        }

        content = downgradeMermaidFencesToText(assistantText);
        assistantText = typeof content === 'string' ? content.trim() : '';
        if (recorder) {
          await recorder.write(sessionId, turnNumber, {
            event: 'assistant.mermaid_validation_downgraded',
            severity: 'warn',
            payload: {
              attempts,
              retryLimit: CHAT_MERMAID_REPAIR_LIMIT,
              blocks: mermaidValidation.blocks,
            },
            note: 'invalid Mermaid persisted as plain code after repair retries were exhausted',
          });
        }
      }
    }

    // IMPORTANT: Only persist a content-only assistant message if there are NO tool_calls
    // If there ARE tool_calls, we'll persist a combined message (content + tool_calls) later
    // This prevents duplicate assistant messages that confuse deduplication
    if (assistantText.length > 0 && toolCalls.length === 0) {
      stream.messageStart({ role: 'assistant' });

      const assistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        metadata: metadataWithProviderReasoning(undefined, streamResult.reasoning),
      };

      await this.deps.sessionStore.recordModelResponseAcceptedAsync?.(
        sessionId,
        turnNumber,
        modelRequestId,
        assistantMessage,
      );
      await this.deps.sessionStore.appendMessageAsync(sessionId, assistantMessage);
      stream.message({
        ...assistantMessage,
        metadata: redactProviderReasoningMetadata(assistantMessage.metadata),
      });
      stream.messageEnd({ messageId: assistantMessage.id });

    } else if (assistantText.length > 0 && toolCalls.length > 0) {
      // Content + tool_calls: stream content but don't persist yet (will persist combined message later)
      stream.messageStart({ role: 'assistant' });

      const streamOnlyMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
      };
      stream.message(streamOnlyMessage);
      stream.messageEnd({ messageId: streamOnlyMessage.id, hasToolCalls: true });

    } else if (toolCalls.length > 0) {
      stream.messageStart({ role: 'assistant' });
      stream.messageEnd({ hasToolCalls: true });
    }

    if (toolCalls.length === 0) {
      if (recorder) {
        const usage = streamResult.usage;
        const finalMessageSnapshotArtifact =
          messageBreakdown && messageDigest && messageSnapshotState && messageSnapshotMode !== 'none'
            ? messageSnapshotMode === 'all'
              ? startMessageSnapshotArtifact
              : this.writeFinalMessageSnapshotArtifact(
                  recorder,
                  sessionId,
                  turnNumber,
                  configuredModelName,
                  workingMessages,
                  messageBreakdown,
                  messageDigest,
                  messageSnapshotState,
                  modelCallOrdinal,
                )
            : undefined;
        await recorder.write(sessionId, turnNumber, {
          event: 'model.call.finish',
          severity: 'info',
          payload: {
            latencyMs: callLatencyMs,
            // Omitted, never zeroed: a response with no streamed text has no
            // first token, and a 0 here would read as an instant one.
            ...(ttftMs === undefined ? {} : { ttftMs }),
            toolCalls: 0,
            status: 'completed',
            finishReason: streamResult.finishReason,
            assistantChars: assistantText.length,
            assistantPreview: assistantText ? assistantText.slice(0, 512) : undefined,
            reasoning: streamResult.reasoningStats,
            tokens: buildTokenTelemetry(usage, streamResult.reasoningStats),
          },
          links: {
            ...(finalMessageSnapshotArtifact ? { messages: finalMessageSnapshotArtifact } : {}),
          },
          note: `latency=${callLatencyMs}ms, toolCalls=0${
            streamResult.finishReason ? `, finishReason=${streamResult.finishReason}` : ''
          }${usage ? `, tokens=${usage.totalTokens}` : ''}`,
        });
      }
      const messagesLength = this.deps.sessionStore.get(sessionId)?.messages.length ?? 0;
      return {
        status: 'completed',
        toolCallCount,
        messagesLength,
        doneEmitted,
        toolCalls: [],
        currentMessages: workingMessages,
        assistantText,
      };
    }

    // ATOMIC PERSISTENCE: Don't persist here - return for batch persistence
    // This prevents orphaned tool_calls when execution is interrupted
    // TurnRunner will persist assistant + all tool results together
    const assistantWithToolCalls: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: content || '',
      timestamp: Date.now(),
      metadata: metadataWithProviderReasoning(
        modelRequestId ? { modelRequestId } : undefined,
        streamResult.reasoning,
      ),
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };

    // Note: We no longer call appendMessageAsync here!
    // The pending message will be persisted atomically with tool results in TurnRunner

    workingMessages.push(fullAssistantMessage);

    if (recorder) {
      const usage = streamResult.usage;
      await recorder.write(sessionId, turnNumber, {
        event: 'model.call.finish',
        severity: 'info',
        payload: {
          latencyMs: callLatencyMs,
          ...(ttftMs === undefined ? {} : { ttftMs }),
          toolCalls: toolCalls.length,
          toolNames: toolCalls.map((toolCall) => toolCall.function.name),
          status: 'tool_calls',
          finishReason: streamResult.finishReason,
          assistantChars: assistantText.length,
          assistantPreview: assistantText ? assistantText.slice(0, 512) : undefined,
          reasoning: streamResult.reasoningStats,
          tokens: buildTokenTelemetry(usage, streamResult.reasoningStats),
        },
        note: `latency=${callLatencyMs}ms, toolCalls=${toolCalls.length}${streamResult.finishReason ? `, finishReason=${streamResult.finishReason}` : ''}${usage ? `, tokens=${usage.totalTokens}` : ''}`,
      });
    }

    return {
      toolCalls,
      currentMessages: workingMessages,
      doneEmitted,
      toolCallCount: toolCalls.length,
      messagesLength: this.deps.sessionStore.get(sessionId)?.messages.length ?? 0,
      usage: streamResult.usage,
      ...(modelRequestId ? { modelRequestId } : {}),
      pendingAssistantMessage: assistantWithToolCalls,  // Return for atomic persistence
      assistantText,
    };
  }
}
