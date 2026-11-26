import type OpenAI from 'openai';
import {
  estimateContentTokens,
  estimateTextTokens,
  safeStringify,
} from '../stages/helpers/messageUtils';
import {
  isAlreadyCompacted,
  isCompactableToolName,
  summarizeToolResult,
} from '../stages/helpers/ToolResultMicrocompactor';
import { defaultToolResultPolicy } from '../tool-results/ToolResultPolicy';
import {
  planToolResultReduction,
  type ToolResultReductionDecision,
  type ToolResultReductionEconomics,
  type ToolResultSlot,
} from '../tool-results/ToolResultReductionPlan';
import type { ContextMeasurement } from '../../../domain/context';

export interface SameTurnCompactionOptions {
  enabled?: boolean;
  minPromptTokens?: number;
  keepLastToolResults?: number;
  maxResultTokens?: number;
  maxResultChars?: number;
  aggregateToolResultBudgetTokens?: number;
  aggregateToolResultTargetTokens?: number;
}

/**
 * What only the turn loop knows: how many further requests are expected, and whether the
 * provider is already holding a warm prefix this rewrite would throw away.
 */
export interface SameTurnCompactionEconomics {
  expectedRemainingRequests: number;
  /** True when this request is known to start cold, so there is no warm value to protect. */
  /**
   * What is known about the cached prefix this rewrite would invalidate. Read it from the
   * turn so far with `readPrefixCacheState`. Only `known_cold` removes the loss from the
   * arithmetic, and only evidence certifies it.
   */
  cacheState?: PrefixCacheState;
  cacheMissPremium?: number;
  safetyFactor?: number;
}

export interface SameTurnCompactionStats {
  enabled: boolean;
  reason:
    | 'disabled'
    | 'below_threshold'
    /** Candidates existed; the economic gate refused to rewrite a warm prefix for them. */
    | 'refused_uneconomic'
    | 'no_candidates'
    | 'compacted';
  messageCount: number;
  toolResultCount: number;
  keptRecentResults: number;
  compactedResults: number;
  candidateResults: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  messageTokensBefore: number;
  messageTokensAfter: number;
  toolSchemaTokens: number;
  minPromptTokens: number;
  compactedTools: Record<string, number>;
  aggregateBudgetEnforcements: number;
  aggregateBudgetOverageTokensBefore: number;
  aggregateBudgetOverageTokensAfter: number;
  /** E12 Slice B: the single reduction decision this pass acted on. */
  decision?: ToolResultReductionDecision;
}

export interface SameTurnCompactionResult {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  stats: SameTurnCompactionStats;
}

const DEFAULT_ENABLED = true;
const DEFAULT_MIN_PROMPT_TOKENS = 32_000;
const DEFAULT_POLICY_CONFIG = defaultToolResultPolicy.getConfig();
const DEFAULT_KEEP_LAST_TOOL_RESULTS = DEFAULT_POLICY_CONFIG.keepLastToolResults;
const DEFAULT_MAX_RESULT_TOKENS = DEFAULT_POLICY_CONFIG.maxResultTokens;
const DEFAULT_MAX_RESULT_CHARS = DEFAULT_POLICY_CONFIG.maxResultChars;
const DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET_TOKENS = DEFAULT_POLICY_CONFIG.aggregateToolResultPromptBudgetTokens;
const DEFAULT_AGGREGATE_TOOL_RESULT_TARGET_TOKENS = DEFAULT_POLICY_CONFIG.aggregateToolResultTargetTokens;

const readBooleanEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return fallback;
};

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const resolveSameTurnCompactionOptionsFromEnv = (): Required<SameTurnCompactionOptions> => ({
  enabled: readBooleanEnv('AGENT_SAME_TURN_COMPACTION', DEFAULT_ENABLED),
  minPromptTokens: readPositiveIntEnv(
    'AGENT_SAME_TURN_COMPACTION_MIN_PROMPT_TOKENS',
    DEFAULT_MIN_PROMPT_TOKENS,
  ),
  keepLastToolResults: readPositiveIntEnv(
    'AGENT_SAME_TURN_COMPACTION_KEEP_LAST_TOOL_RESULTS',
    DEFAULT_KEEP_LAST_TOOL_RESULTS,
  ),
  maxResultTokens: readPositiveIntEnv(
    'AGENT_SAME_TURN_COMPACTION_MAX_RESULT_TOKENS',
    DEFAULT_MAX_RESULT_TOKENS,
  ),
  maxResultChars: readPositiveIntEnv(
    'AGENT_SAME_TURN_COMPACTION_MAX_RESULT_CHARS',
    DEFAULT_MAX_RESULT_CHARS,
  ),
  aggregateToolResultBudgetTokens: readPositiveIntEnv(
    'AGENT_TOOL_RESULT_PROMPT_BUDGET_TOKENS',
    DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET_TOKENS,
  ),
  aggregateToolResultTargetTokens: readPositiveIntEnv(
    'AGENT_TOOL_RESULT_PROMPT_TARGET_TOKENS',
    DEFAULT_AGGREGATE_TOOL_RESULT_TARGET_TOKENS,
  ),
});

const getAssistantToolCalls = (
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] => {
  if (message.role !== 'assistant') {
    return [];
  }
  const toolCalls = (message as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls;
  return Array.isArray(toolCalls)
    ? toolCalls.filter(
        (call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
          Boolean(call) && 'function' in call,
      )
    : [];
};

const getToolCallId = (message: OpenAI.Chat.ChatCompletionMessageParam): string | undefined => {
  if (message.role !== 'tool') {
    return undefined;
  }
  const raw = (message as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
};

export const estimateChatMessageTokens = (
  message: OpenAI.Chat.ChatCompletionMessageParam,
): number => {
  const contentTokens = estimateContentTokens((message as { content?: unknown }).content);
  const toolCallTokens = getAssistantToolCalls(message).reduce(
    (sum, call) => sum + estimateTextTokens(safeStringify(call)),
    0,
  );
  const toolCallIdTokens =
    message.role === 'tool' ? estimateTextTokens(getToolCallId(message) ?? '') : 0;
  const total = contentTokens + toolCallTokens + toolCallIdTokens;
  return total > 0 ? Math.max(1, total) : 0;
};

export const estimateChatMessagesTokens = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): number => messages.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0);

export const estimateToolSchemaTokens = (
  toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[],
): number => estimateContentTokens(safeStringify(toolDefinitions));

const buildToolNameByCallId = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Map<string, string> => {
  const toolNameByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of getAssistantToolCalls(message)) {
      const callId = typeof call.id === 'string' ? call.id : undefined;
      const toolName = typeof call.function?.name === 'string' ? call.function.name : undefined;
      if (callId && toolName) {
        toolNameByCallId.set(callId, toolName);
      }
    }
  }
  return toolNameByCallId;
};

const initialStats = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: Required<SameTurnCompactionOptions>,
  messageTokens: number,
  toolSchemaTokens: number,
  reason: SameTurnCompactionStats['reason'],
): SameTurnCompactionStats => {
  const toolResultCount = messages.filter((message) => message.role === 'tool').length;
  return {
    enabled: options.enabled,
    reason,
    messageCount: messages.length,
    toolResultCount,
    keptRecentResults: Math.min(toolResultCount, options.keepLastToolResults),
    compactedResults: 0,
    candidateResults: 0,
    beforeTokens: messageTokens + toolSchemaTokens,
    afterTokens: messageTokens + toolSchemaTokens,
    savedTokens: 0,
    messageTokensBefore: messageTokens,
    messageTokensAfter: messageTokens,
    toolSchemaTokens,
    minPromptTokens: options.minPromptTokens,
    compactedTools: {},
    aggregateBudgetEnforcements: 0,
    aggregateBudgetOverageTokensBefore: 0,
    aggregateBudgetOverageTokensAfter: 0,
  };
};

/** What is known about the cached prefix a rewrite would invalidate. */
export type PrefixCacheState = 'known_warm' | 'known_cold' | 'unknown';

/** How long a provider prefix entry is assumed to live when nothing says otherwise. */
export const DEFAULT_PREFIX_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Reads what is actually known about the cached prefix.
 *
 * An earlier version of this returned a boolean and called the prefix cold as soon as one
 * request had reported no cache read. That does not follow. On a provider that caches
 * implicitly, the request that missed is usually the request that *populated* the entry, so
 * the very next request would have hit — and calling it cold there rewrites the prefix the
 * previous request just paid to create. It certified cold from evidence about a different
 * request.
 *
 * Cold has to be earned. The only evidence available here is expiry: a prefix the provider
 * served from cache longer ago than its entry lives is genuinely gone. Everything else,
 * including a run of misses, is `unknown` — and unknown is priced as warm, because being
 * wrong about warm costs a cache reset and being wrong about cold costs nothing but some
 * re-sent tokens.
 */
export const readPrefixCacheState = (turnSoFar: {
  llmCallCount?: number;
  llmCachedTokens?: number;
  lastCacheReadAtMs?: number;
  nowMs?: number;
  cacheTtlMs?: number;
}): PrefixCacheState => {
  const lastReadAt = turnSoFar.lastCacheReadAtMs;
  if (lastReadAt === undefined) {
    return 'unknown';
  }
  const now = turnSoFar.nowMs ?? Date.now();
  const ttl = turnSoFar.cacheTtlMs ?? DEFAULT_PREFIX_CACHE_TTL_MS;
  return now - lastReadAt > ttl ? 'known_cold' : 'known_warm';
};

export const compactSameTurnMessages = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[],
  rawOptions: SameTurnCompactionOptions = {},
  contextMeasurement?: ContextMeasurement,
  economics?: SameTurnCompactionEconomics,
): SameTurnCompactionResult => {
  const options: Required<SameTurnCompactionOptions> = {
    enabled: rawOptions.enabled ?? DEFAULT_ENABLED,
    minPromptTokens: contextMeasurement?.thresholds.softTokens
      ?? rawOptions.minPromptTokens
      ?? DEFAULT_MIN_PROMPT_TOKENS,
    keepLastToolResults: rawOptions.keepLastToolResults ?? DEFAULT_KEEP_LAST_TOOL_RESULTS,
    maxResultTokens: rawOptions.maxResultTokens ?? DEFAULT_MAX_RESULT_TOKENS,
    maxResultChars: rawOptions.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
    aggregateToolResultBudgetTokens:
      rawOptions.aggregateToolResultBudgetTokens ?? DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET_TOKENS,
    aggregateToolResultTargetTokens:
      rawOptions.aggregateToolResultTargetTokens ?? DEFAULT_AGGREGATE_TOOL_RESULT_TARGET_TOKENS,
  };
  const messageTokensBefore = estimateChatMessagesTokens(messages);
  const toolSchemaTokens = estimateToolSchemaTokens(toolDefinitions);
  const beforeTokens = messageTokensBefore + toolSchemaTokens;

  if (!options.enabled) {
    return {
      messages,
      stats: initialStats(messages, options, messageTokensBefore, toolSchemaTokens, 'disabled'),
    };
  }

  /**
   * Two different authorities were reading one threshold.
   *
   * `softTokens` is 70% of routed capacity and means "context management should start". It
   * does not mean the request will not fit. Forcing on it handed the soft threshold the same
   * destructive power as an overflow, and since a long tool-heavy turn sits above 70% for
   * most of its life, the economic gate was bypassed almost every time it mattered — the
   * exact spend D16 exists to prevent, waved through by the condition above it.
   *
   * `hardTokens` is 90% and is a capacity statement. That one may force.
   */
  const promptPressure: 'none' | 'soft' | 'hard' = contextMeasurement
    ? (contextMeasurement.counts.totalWithReservedOutputTokens >= contextMeasurement.thresholds.hardTokens
      ? 'hard'
      : contextMeasurement.counts.totalWithReservedOutputTokens >= contextMeasurement.thresholds.softTokens
        ? 'soft'
        : 'none')
    // Without a measurement there is no capacity to compare against, so the caller's own
    // minimum stands in for it and keeps its previous authority.
    : (beforeTokens >= options.minPromptTokens ? 'hard' : 'none');

  const toolNameByCallId = buildToolNameByCallId(messages);
  const stats = initialStats(messages, options, messageTokensBefore, toolSchemaTokens, 'no_candidates');

  // E12 Slice B: the same planner the cross-turn owner uses. This function only reads and
  // writes the OpenAI message shape; it does not hold a second copy of the rule.
  const slots: ToolResultSlot[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCallId = getToolCallId(message);
    const toolName = toolCallId ? toolNameByCallId.get(toolCallId) : undefined;
    slots.push({
      index,
      toolName,
      contentChars: content.length,
      tokens: estimateChatMessageTokens(message),
      alreadyReduced: content.length === 0 || isAlreadyCompacted(content),
      reducible: typeof message.content === 'string' && isCompactableToolName(toolName),
    });
  }

  // Everything the provider is currently expected to serve from cache is at risk, because
  // the plan still selects oldest-first and the boundary lands near the head. When the
  // boundary moves to the tail this becomes the tokens after it, and the gate starts
  // passing on its own.
  // D15/D16 - only the tokens from the rewrite boundary onward are lost, and this call site
  // knows exactly which messages those are. Before D15 the boundary landed at the head and
  // the honest answer was "all of it"; now it is measurable.
  const tokensFromMessageIndex = (firstChangedIndex: number): number => {
    if (firstChangedIndex <= 0) return beforeTokens;
    let atRisk = 0;
    for (let index = firstChangedIndex; index < messages.length; index += 1) {
      atRisk += estimateChatMessageTokens(messages[index]!);
    }
    return atRisk;
  };

  const resolvedEconomics: ToolResultReductionEconomics | undefined = economics
    ? {
      expectedRemainingRequests: economics.expectedRemainingRequests,
      cachedPrefixTokensAtRisk: economics.cacheState === 'known_cold' ? 0 : tokensFromMessageIndex,
      ...(economics.cacheMissPremium !== undefined
        ? { cacheMissPremium: economics.cacheMissPremium }
        : {}),
      ...(economics.safetyFactor !== undefined ? { safetyFactor: economics.safetyFactor } : {}),
    }
    : undefined;

  const decision = planToolResultReduction(slots, {
    windowTokens: options.aggregateToolResultBudgetTokens,
    targetTokens: options.aggregateToolResultTargetTokens,
    keepLastToolResults: options.keepLastToolResults,
    maxResultTokens: options.maxResultTokens,
    maxResultChars: options.maxResultChars,
    // Only a capacity statement bypasses the quantized boundary and the economic gate. Soft
    // pressure still reduces if the arithmetic says it pays, and waits if it does not.
    ...(promptPressure === 'hard' ? { forceReduction: true } : {}),
    ...(resolvedEconomics ? { economics: resolvedEconomics } : {}),
  });
  stats.decision = decision;
  stats.candidateResults = decision.eligibleCandidates;
  stats.keptRecentResults = decision.protectedRecentResults;
  stats.aggregateBudgetEnforcements = decision.changed && decision.forced ? 1 : 0;
  stats.aggregateBudgetOverageTokensBefore = Math.max(
    0,
    decision.toolResultTokensBefore - options.aggregateToolResultBudgetTokens,
  );

  const projectedToolResultTokens = decision.projectedToolResultTokens;

  const compactedMessages = messages.map((message, index): OpenAI.Chat.ChatCompletionMessageParam => {
    if (!decision.reduceIndices.has(index) || typeof message.content !== 'string') {
      return message;
    }

    const toolCallId = getToolCallId(message);
    const toolName = toolCallId ? toolNameByCallId.get(toolCallId) : undefined;
    if (!isCompactableToolName(toolName)) {
      return message;
    }

    const beforeMessageTokens = estimateChatMessageTokens(message);
    const { summary, artifactPath } = summarizeToolResult(toolName, message.content);
    const compactedContent = safeStringify({
      status: 'tool_result_compacted',
      tool: toolName,
      summary,
      ...(artifactPath ? { artifactPath } : {}),
      reason: 'older large tool result compacted before same-turn model call',
      originalApproxTokens: beforeMessageTokens,
    });
    const compactedMessage = {
      ...message,
      content: compactedContent,
    } as OpenAI.Chat.ChatCompletionToolMessageParam;
    const afterMessageTokens = estimateChatMessageTokens(compactedMessage);
    stats.compactedResults += 1;
    stats.savedTokens += Math.max(0, beforeMessageTokens - afterMessageTokens);
    stats.compactedTools[toolName] = (stats.compactedTools[toolName] ?? 0) + 1;
    return compactedMessage;
  });

  const messageTokensAfter = estimateChatMessagesTokens(compactedMessages);
  // Say what actually happened. A refused reduction is not an absent one, and a trace that
  // reports "no candidates" when the gate declined hides the decision it should expose.
  const refusedByGate = decision.reason === 'negative_economics'
    || decision.reason === 'economics_unknown';
  stats.reason = stats.compactedResults > 0
    ? 'compacted'
    : decision.reason === 'below_trigger'
      ? 'below_threshold'
      : refusedByGate
        ? 'refused_uneconomic'
        : 'no_candidates';
  stats.messageTokensAfter = messageTokensAfter;
  stats.afterTokens = messageTokensAfter + toolSchemaTokens;
  stats.savedTokens = Math.max(stats.savedTokens, Math.max(0, beforeTokens - stats.afterTokens));
  if (stats.aggregateBudgetEnforcements > 0) {
    stats.aggregateBudgetOverageTokensAfter = Math.max(
      0,
      projectedToolResultTokens - options.aggregateToolResultBudgetTokens,
    );
  }
  return {
    messages: stats.compactedResults > 0 ? compactedMessages : messages,
    stats,
  };
};
