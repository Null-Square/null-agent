import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type OpenAI from 'openai';
import { z } from 'zod';

import { DefaultBuildStage } from '../../../../src/domains/agent-brain/application/orchestration/stages/BuildStage';
import { buildCompactionInstruction } from '../../../../src/domains/agent-brain/application/orchestration/stages/helpers/CompactionSummary';
import { CacheLineageObserver } from '../../../../src/domains/agent-brain/application/orchestration/CacheLineageObserver';
import { microcompactToolResults } from '../../../../src/domains/agent-brain/application/orchestration/stages/helpers/ToolResultMicrocompactor';
import { DeepSeekChatProvider } from '../../../../src/domains/agent-brain/adapters/providers/DeepSeekChatProvider';
import { projectAnthropicCacheSurface } from '../../../../src/domains/agent-brain/adapters/providers/anthropic/projectAnthropicCacheSurface';
import {
  compareProjections,
  digestOf,
  projectOpenAiCompatibleCacheSurface,
  type CacheIdentity,
} from '../../../../src/domains/agent-brain/domain/cache';
import { AppError, ERROR_CODES } from '../../../../src/shared/errors';
import type { Message, SessionState } from '../../../../src/domains/agent-brain/domain/types';
import type { ResolvedConfig } from '../../../../src/config/configTypes';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

/**
 * Harness 3.2 conformance and cache economics.
 *
 * Every other assembled scenario proves one epic against a deterministic provider. This one
 * answers the two questions those scenarios structurally cannot:
 *
 *   1. Which reducer actually owns context reduction on each routed model, and does the
 *      emergency trimmer ever discard history before compaction can summarise it?
 *   2. Does the E12 prefix claim survive contact with a real provider cache, or is it only
 *      true against our own estimator?
 *
 * Leg A and Leg B are deterministic and always run. Leg C makes real DeepSeek calls and runs
 * only when explicitly enabled, so the default suite stays free and offline.
 */

export const HARNESS_32_CONFORMANCE_SCENARIO_ID = 'harness-3-2-conformance-cache-economics';
export const HARNESS_32_CONFORMANCE_EVIDENCE_SCHEMA =
  'behavior-lab-harness-3-2-conformance-evidence/v1' as const;

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Routes are scaled down uniformly; the reducer budget arithmetic is ratio-based. */
const ROUTE_SCALE = 10;

const NL = String.fromCharCode(10);

const COMPACTION_SUMMARY = [
  '## Filed Findings', '- none',
  '## Attempted Techniques', '- probe | /api/v1/status | blocked by WAF',
  '## Failed Approaches', '- none',
  '## Credentials', '- none',
  '## Open Plan Steps', '- none',
  '## Discoveries', '- none',
  '## Constraints', '- none',
  '## Next Action', '- none',
].join(NL);

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  detail: string,
  authoritativeSource = 'assembled BuildStage run and provider telemetry',
): VerificationAssertion => ({ id, passed, expected, actual, authoritativeSource, detail });

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
};

// ---------------------------------------------------------------------------
// Shared BuildStage driver
// ---------------------------------------------------------------------------

type SeededRoute = {
  model: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  isDefault: boolean;
  cacheHitInputPer1m?: number;
  cacheMissInputPer1m?: number;
};

const loadSeededRoutes = (): SeededRoute[] => {
  const seedPath = path.join(BACKEND_ROOT, 'config', 'seeds', 'models.seed.json');
  const seeds = JSON.parse(readFileSync(seedPath, 'utf8')) as Array<Record<string, unknown>>;
  return seeds
    .filter((seed) => typeof seed.contextWindow === 'number'
      && typeof seed.maxOutputTokens === 'number')
    .map((seed) => {
      const rateCards = Array.isArray(seed.rateCards) ? seed.rateCards : [];
      const latest = rateCards[rateCards.length - 1] as Record<string, unknown> | undefined;
      return {
        model: String(seed.modelName),
        provider: String(seed.provider).toLowerCase(),
        contextWindow: Number(seed.contextWindow),
        maxOutputTokens: Number(seed.maxOutputTokens),
        isDefault: seed.isDefault === true,
        ...(typeof latest?.cacheHitInputPer1m === 'number'
          ? { cacheHitInputPer1m: latest.cacheHitInputPer1m }
          : {}),
        ...(typeof latest?.cacheMissInputPer1m === 'number'
          ? { cacheMissInputPer1m: latest.cacheMissInputPer1m }
          : {}),
      };
    });
};

const buildHistory = (count: number, tokensEach: number, salt = 'alpha'): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `conformance-msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${index} ${`${salt} `.repeat(Math.ceil((tokensEach * 4) / (salt.length + 1)))}`,
    timestamp: 1_700_000_000_000 + index,
  })) as Message[];

const convertMessages = (input: Message[]) => input.map((message) => ({
  role: message.role,
  content: message.content,
  ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
}));

const TOOL_SCHEMAS = [
  {
    name: 'http_request',
    description: 'Send an HTTP request to an in-scope target and return the response.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'file_read',
    description: 'Read a file from the run workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

type CapturedAuxiliaryCall = {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  cacheMode?: { kind: string };
};

type BuildObservation = {
  compacted: boolean;
  droppedMessages: number;
  historyTokensBeforeTrim: number;
  historyTokens: number;
  maxHistoryTokens: number;
  trimEvaluated: unknown;
  trimChanged: unknown;
  trimChangedBy: unknown;
  systemMessages: Array<Record<string, unknown>>;
  historyMessages: Array<Record<string, unknown>>;
  toolDefinitions: unknown[];
  compactionCall?: CapturedAuxiliaryCall;
};

/** Drives the shipping BuildStage and reports what the reducers actually did. */
const driveBuildStage = async (input: {
  route: SeededRoute;
  scale: number;
  messages: Message[];
  sessionId: string;
  turnNumber: number;
  staticPrompt?: string;
}): Promise<BuildObservation> => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let compactionCall: CapturedAuxiliaryCall | undefined;

  const session = {
    id: input.sessionId,
    profileKey: 'default',
    messages: input.messages,
    modelContextWindow: Math.floor(input.route.contextWindow / input.scale),
    modelMaxOutputTokens: Math.floor(input.route.maxOutputTokens / input.scale),
    flags: { securityops: { workflowDiscipline: 'pentest' } },
  } as unknown as SessionState;

  const result = await new DefaultBuildStage().run({
    session,
    turnNumber: input.turnNumber,
    contextProvider: { getContext: async () => ({ hard: '', soft: '' }) },
    promptBuilder: {
      resolveProfile: async () => ({ id: 'conformance' }),
      build: () => ({
        staticPrompt: input.staticPrompt ?? 'STATIC SECURITY PROMPT',
        dynamicPrompt: '',
        softContext: '',
        cacheablePrefix: '',
        dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
        sections: { static: [], soft: [], dynamic: [] },
      }),
    },
    cacheCoordinator: {
      build: () => ({ cacheIntent: { action: 'none' }, approxPrefixTokens: 0, prefixHash: 'none' }),
    },
    toolsRegistry: { getToolSchemas: () => TOOL_SCHEMAS },
    provider: {
      name: input.route.provider,
      getCapabilities: () => ({
        contextWindow: Math.floor(input.route.contextWindow / input.scale),
      }),
      supportsCacheControl: () => false,
      buildSystemMessages: () => [],
      mapError: (error: unknown) => (error instanceof AppError
        ? error
        : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))),
    },
    convertMessages,
    maxToolCalls: 4,
    modelName: input.route.model,
    executeModelCall: async (call: CapturedAuxiliaryCall) => {
      compactionCall = call;
      return { content: COMPACTION_SUMMARY } as never;
    },
    traceRecorder: {
      write: async (_sessionId: string, _turn: number, event: Record<string, unknown>) => {
        events.push(event as never);
      },
    },
  } as never);

  const trim = (events.find((entry) => entry.event === 'history.trim')?.payload
    ?? {}) as Record<string, unknown>;
  const budget = (events.find((entry) => entry.event === 'context.budget')?.payload
    ?? {}) as Record<string, unknown>;

  return {
    compacted: events.some((entry) => entry.event === 'context.compacted'),
    droppedMessages: Number(trim.droppedMessages ?? 0),
    historyTokensBeforeTrim: Number(budget.historyTokensBeforeTrim ?? 0),
    historyTokens: Number(budget.historyTokens ?? 0),
    maxHistoryTokens: Number(budget.maxHistoryTokens ?? 0),
    trimEvaluated: trim.evaluated,
    trimChanged: trim.changed,
    trimChangedBy: trim.changedBy,
    systemMessages: result.systemMessages as never,
    historyMessages: result.historyMessages as never,
    toolDefinitions: result.toolDefinitions as never,
    ...(compactionCall ? { compactionCall } : {}),
  };
};

// ---------------------------------------------------------------------------
// Leg A — which reducer owns context reduction on each routed model
// ---------------------------------------------------------------------------

export type ReducerReachability = {
  model: string;
  provider: string;
  isDefault: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  outputReserveRatio: number;
  maxHistoryTokens: number;
  /** History size (tokens) at which the emergency trimmer first discarded a message. */
  firstTrimDropAtTokens: number | null;
  /** History size (tokens) at which compaction first produced a durable summary. */
  firstCompactionAtTokens: number | null;
  /** True when the trimmer discards history the summariser never got to see. */
  trimPreemptsCompaction: boolean;
};

/**
 * Grows history one step at a time and records which reducer engages first.
 *
 * The trimmer is a last-resort truncation: what it drops is gone from the prompt with no
 * summary standing in for it. Compaction replaces the same range with a checkpoint. A route
 * where the trimmer engages at a smaller history than compaction loses information the
 * summariser would have kept.
 */
const measureReducerReachability = async (
  route: SeededRoute,
): Promise<ReducerReachability> => {
  let firstTrimDropAtTokens: number | null = null;
  let firstCompactionAtTokens: number | null = null;
  let maxHistoryTokens = 0;

  for (let count = 6; count <= 400; count += 2) {
    const observation = await driveBuildStage({
      route,
      scale: ROUTE_SCALE,
      messages: buildHistory(count, 400),
      sessionId: `reachability-${route.model}-${count}`,
      turnNumber: 9,
    });
    maxHistoryTokens = observation.maxHistoryTokens;
    if (firstTrimDropAtTokens === null && observation.droppedMessages > 0) {
      firstTrimDropAtTokens = observation.historyTokensBeforeTrim;
    }
    if (observation.compacted) {
      firstCompactionAtTokens = observation.historyTokensBeforeTrim;
      break;
    }
  }

  return {
    model: route.model,
    provider: route.provider,
    isDefault: route.isDefault,
    contextWindow: route.contextWindow,
    maxOutputTokens: route.maxOutputTokens,
    outputReserveRatio: Number((route.maxOutputTokens / route.contextWindow).toFixed(4)),
    maxHistoryTokens,
    firstTrimDropAtTokens,
    firstCompactionAtTokens,
    trimPreemptsCompaction: firstTrimDropAtTokens !== null
      && (firstCompactionAtTokens === null || firstTrimDropAtTokens < firstCompactionAtTokens),
  };
};

// ---------------------------------------------------------------------------
// Leg B — what a turn costs the cache, measured on the shipping BuildStage
// ---------------------------------------------------------------------------

const LEG_B_IDENTITY: CacheIdentity = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  tenantDigest: digestOf('conformance-tenant'),
  translationVersion: 'openai-compatible/v1',
};

export type TurnPrefixMeasurement = {
  turn: number;
  historyMessages: number;
  compacted: boolean;
  droppedMessages: number;
  reducerChanged: unknown;
  estimatedTotalTokens: number;
  estimatedReusableTokens: number;
  reusableRatio: number;
  structuralRelation: string;
  firstDivergenceIndex: number | null;
};

/**
 * Replays consecutive turns on the default route and measures how much of the previous
 * request's prefix each new request can still reuse.
 *
 * A turn that only appends keeps the whole prefix. The turn that reduces rewrites it, and
 * the observer must name that rather than let it read as an ordinary append.
 */
const measureTurnPrefixEconomics = async (route: SeededRoute): Promise<{
  turns: TurnPrefixMeasurement[];
  compactionCall?: CapturedAuxiliaryCall;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
}> => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const observer = new CacheLineageObserver((event, payload) => events.push({ event, payload }));
  const turns: TurnPrefixMeasurement[] = [];
  let previousProjection: ReturnType<typeof projectOpenAiCompatibleCacheSurface> | undefined;
  let compactionCall: CapturedAuxiliaryCall | undefined;

  // Message counts chosen so the first turns only append and a later turn crosses the
  // compaction threshold measured by Leg A.
  const counts = [10, 20, 30, 40, 50, 60, 70, 80, 90];

  for (let index = 0; index < counts.length; index += 1) {
    const turnNumber = index + 1;
    const observation = await driveBuildStage({
      route,
      scale: ROUTE_SCALE,
      messages: buildHistory(counts[index]!, 400),
      sessionId: 'prefix-economics',
      turnNumber,
    });
    if (observation.compactionCall) compactionCall = observation.compactionCall;

    const projection = projectOpenAiCompatibleCacheSurface({
      envelope: {
        model: route.model,
        messages: [...observation.systemMessages, ...observation.historyMessages],
        tools: observation.toolDefinitions,
      },
      identity: LEG_B_IDENTITY,
    });

    const comparison = previousProjection
      ? compareProjections(previousProjection, projection)
      : undefined;

    const expectation = observer.recordExpectation({
      sessionId: 'prefix-economics',
      requestId: `turn-${turnNumber}`,
      branch: 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: `turn-${turnNumber - 1}` },
      projection,
      // A reduction that ran is declared; an append declares nothing.
      declaredTransformationIds: observation.compacted || observation.droppedMessages > 0
        ? [`reducer:turn-${turnNumber}`]
        : [],
    });

    turns.push({
      turn: turnNumber,
      historyMessages: observation.historyMessages.length,
      compacted: observation.compacted,
      droppedMessages: observation.droppedMessages,
      reducerChanged: observation.trimChanged,
      estimatedTotalTokens: projection.estimatedTotalTokens,
      estimatedReusableTokens: comparison?.estimatedReusableTokens ?? 0,
      reusableRatio: projection.estimatedTotalTokens > 0
        ? Number(((comparison?.estimatedReusableTokens ?? 0) / projection.estimatedTotalTokens)
          .toFixed(4))
        : 0,
      structuralRelation: expectation.structuralRelation,
      firstDivergenceIndex: expectation.firstChangedSegmentIndex,
    });

    previousProjection = projection;
  }

  return { turns, ...(compactionCall ? { compactionCall } : {}), events };
};

// ---------------------------------------------------------------------------
// Leg B2 — how often tool-result reduction rewrites the prefix
// ---------------------------------------------------------------------------

export type ReductionStability = {
  turns: number;
  /** Turns on which the reducer rewrote an already-sent message. */
  prefixRewrites: number;
  rewriteTurns: number[];
  /** Sum over turns of tokens that must be re-read uncached because of a rewrite. */
  uncachedReReadTokens: number;
  totalPromptTokens: number;
  uncachedShare: number;
  generationsObserved: number[];
};

const toolPairHistory = (pairs: number): Message[] => {
  const messages: Message[] = [];
  for (let index = 0; index < pairs; index += 1) {
    messages.push({
      id: `assistant-${index}`,
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `call-${index}`,
        type: 'function',
        function: { name: 'http_payload', arguments: '{}' },
      }],
      timestamp: 1_700_000_000_000 + index * 2,
    } as never);
    messages.push({
      id: `tool-${index}`,
      role: 'tool',
      toolName: 'http_payload',
      tool_call_id: `call-${index}`,
      content: JSON.stringify({
        ok: true,
        data: { url: `https://example.com/api/${index}`, body_preview: `r${index} ${'x'.repeat(4_000)}` },
      }),
      timestamp: 1_700_000_000_000 + index * 2 + 1,
    } as never);
  }
  return messages;
};

/**
 * Replays a growing tool-heavy history and counts how often the reducer rewrites a message
 * the provider has already cached.
 *
 * The reduction projection does not mutate stored history — it is recomputed from raw
 * messages every turn. Before E12 Slice B the protected window slid forward, so one further
 * message was rewritten on every turn and the prefix broke on every turn.
 *
 * This leg drives the reducer with a **cold** cache, so the economic gate is satisfied by
 * construction and what is measured is the quantized boundary alone. The gate itself is
 * measured separately by `measureWarmCacheRefusal`.
 */
const measureReductionStability = (turnsToRun = 35): ReductionStability => {
  let previous: string[] | undefined;
  let uncachedReReadTokens = 0;
  let totalPromptTokens = 0;
  let prefixRewrites = 0;
  const rewriteTurns: number[] = [];
  const generationsObserved: number[] = [];

  for (let pairs = 6; pairs < 6 + turnsToRun; pairs += 1) {
    const reduced = microcompactToolResults(toolPairHistory(pairs), {
      economics: { expectedRemainingRequests: turnsToRun, cachedPrefixTokensAtRisk: 0 },
    });
    const projection = reduced.messages.map((message) => `${message.id}:${String(message.content ?? '').length}`);
    const perMessageTokens = reduced.messages.map((message) => Math.ceil(JSON.stringify(message).length / 4));
    totalPromptTokens += perMessageTokens.reduce((total, tokens) => total + tokens, 0);
    if (!generationsObserved.includes(reduced.stats.decision.generation)) {
      generationsObserved.push(reduced.stats.decision.generation);
    }

    let firstChanged = -1;
    if (previous) {
      const shared = Math.min(previous.length, projection.length);
      for (let index = 0; index < shared; index += 1) {
        if (previous[index] !== projection[index]) { firstChanged = index; break; }
      }
    }
    if (firstChanged >= 0) {
      prefixRewrites += 1;
      rewriteTurns.push(pairs);
      uncachedReReadTokens += perMessageTokens.slice(firstChanged)
        .reduce((total, tokens) => total + tokens, 0);
    } else if (previous) {
      // Pure append: only the new messages are uncached.
      uncachedReReadTokens += perMessageTokens.slice(previous.length)
        .reduce((total, tokens) => total + tokens, 0);
    } else {
      uncachedReReadTokens += perMessageTokens.reduce((total, tokens) => total + tokens, 0);
    }
    previous = projection;
  }

  return {
    turns: turnsToRun,
    prefixRewrites,
    rewriteTurns,
    uncachedReReadTokens,
    totalPromptTokens,
    uncachedShare: totalPromptTokens > 0
      ? Number((uncachedReReadTokens / totalPromptTokens).toFixed(4))
      : 0,
    generationsObserved,
  };
};

export type WarmCacheRefusal = {
  /** Turns where the quantized boundary said reduce and the economics said do not. */
  refusedTurns: number;
  refusalReasons: string[];
  /** The largest benefit-to-loss ratio the gate saw. Below 1 means nothing came close. */
  bestBenefitToLossRatio: number;
  /** What the same history reduces to when the cache is cold and nothing is at risk. */
  coldCacheReductions: number;
  /** Reasons the plan gave when no call site priced the rewrite at all. */
  unpricedReasons: string[];
  /** The highest quantized generation this fixture reached. */
  deepestGeneration: number;
  /** How far the rewrite boundary had moved by then, as a share of the history. */
  boundaryShareOfHistoryAtDeepest: number;
  /** Best ratio seen at that generation, so the D15 claim is measured and not asserted. */
  bestRatioAtDeepestGeneration: number;
};

/**
 * Leg B3 — the economic gate.
 *
 * Run r1 fired the ordinary path twice, both times with `forced: false`, and lost about
 * $0.0929 to recover $0.0005. Frequency was never the whole problem: a reduction that is
 * rare and unprofitable is still unprofitable.
 *
 * This replays the same histories against a **warm** prefix with a realistic number of
 * remaining requests, and asserts the plan refuses. The cold-cache control proves the
 * refusal is the gate talking and not an absence of candidates.
 */
const measureWarmCacheRefusal = (turnsToRun = 90): WarmCacheRefusal => {
  let refusedTurns = 0;
  let coldCacheReductions = 0;
  let bestBenefitToLossRatio = 0;
  const refusalReasons: string[] = [];
  const unpricedReasons: string[] = [];
  let deepestGeneration = 0;
  let boundaryShareOfHistoryAtDeepest = 0;
  let bestRatioAtDeepestGeneration = 0;

  for (let pairs = 6; pairs < 6 + turnsToRun; pairs += 1) {
    const history = toolPairHistory(pairs);
    const promptTokens = history.reduce(
      (total, message) => total + Math.ceil(JSON.stringify(message).length / 4),
      0,
    );

    // D15/D16 - price the loss where the boundary actually lands. Only the messages from
    // `firstChangedIndex` onward stop being served from cache; before D15 the boundary was
    // at the head and the honest answer was the whole prompt.
    const tokensFromIndex = (firstChangedIndex: number): number => {
      if (firstChangedIndex <= 0) return promptTokens;
      return history
        .slice(firstChangedIndex)
        .reduce((total, message) => total + Math.ceil(JSON.stringify(message).length / 4), 0);
    };

    const warm = microcompactToolResults(history, {
      // Four further requests is generous for a turn tail.
      economics: { expectedRemainingRequests: 4, cachedPrefixTokensAtRisk: tokensFromIndex },
    });
    const cold = microcompactToolResults(history, {
      economics: { expectedRemainingRequests: 4, cachedPrefixTokensAtRisk: 0 },
    });

    if (cold.stats.decision.changed) {
      coldCacheReductions += 1;
      // The same history with no economics at all: a call site that cannot price its own
      // rewrite must be refused, not allowed to guess.
      const unpriced = microcompactToolResults(history);
      if (!unpricedReasons.includes(unpriced.stats.decision.reason)) {
        unpricedReasons.push(unpriced.stats.decision.reason);
      }
      if (!warm.stats.decision.changed) {
        refusedTurns += 1;
        if (!refusalReasons.includes(warm.stats.decision.reason)) {
          refusalReasons.push(warm.stats.decision.reason);
        }
      }
      const assessment = warm.stats.decision.economics;
      const ratio = assessment && assessment.lossTokens > 0
        ? assessment.benefitTokens / assessment.lossTokens
        : 0;
      bestBenefitToLossRatio = Math.max(bestBenefitToLossRatio, ratio);

      // D15 - track how late the boundary gets as the history deepens. The claim is that it
      // marches toward the tail; this is where that is measured rather than asserted.
      const generation = cold.stats.decision.generation;
      const boundary = cold.stats.decision.firstChangedIndex ?? 0;
      if (generation > deepestGeneration) {
        deepestGeneration = generation;
        bestRatioAtDeepestGeneration = ratio;
        boundaryShareOfHistoryAtDeepest = history.length > 0
          ? Number((boundary / history.length).toFixed(4))
          : 0;
      } else if (generation === deepestGeneration) {
        bestRatioAtDeepestGeneration = Math.max(bestRatioAtDeepestGeneration, ratio);
        boundaryShareOfHistoryAtDeepest = Math.max(
          boundaryShareOfHistoryAtDeepest,
          history.length > 0 ? Number((boundary / history.length).toFixed(4)) : 0,
        );
      }
    }
  }

  return {
    refusedTurns,
    refusalReasons,
    bestBenefitToLossRatio: Number(bestBenefitToLossRatio.toFixed(4)),
    coldCacheReductions,
    unpricedReasons,
    deepestGeneration,
    boundaryShareOfHistoryAtDeepest,
    bestRatioAtDeepestGeneration: Number(bestRatioAtDeepestGeneration.toFixed(4)),
  };
};

// ---------------------------------------------------------------------------
// Leg C — real DeepSeek cache telemetry
// ---------------------------------------------------------------------------

const liveEnabled = (): boolean =>
  process.env.BEHAVIOR_LIVE === '1' || process.env.BEHAVIOR_LIVE_CACHE === '1';

export type LiveCall = {
  id: string;
  intent: string;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  /** What our own projection predicted was reusable against the warm ancestor. */
  predictedReusableTokens: number | null;
  /** cacheHitTokens as read back through the shipping provider adapter. */
  normalizedCachedTokens: number | undefined;
  structuralRelation: string;
  assessedOutcome: string;
};

export type LiveCacheEvidence = {
  ran: true;
  model: string;
  runNonce: string;
  calls: LiveCall[];
  warmPrefixTokens: number;
  newShapeHitTokens: number;
  oldShapeHitTokens: number;
  recoveredTokensPerCompaction: number;
  earlyRewriteHitTokens: number;
  /** What our own projection predicted the rewrite would leave reusable. */
  earlyRewritePredictedReusableTokens: number;
  lateRewriteHitTokens: number;
  lateRewritePredictedReusableTokens: number;
  toolChangeHitTokens: number;
  /**
   * Calls where the provider delivered materially less reuse than the structural prefix
   * suggested. The projection is an upper bound on reuse, never a prediction of it.
   */
  overclaimedCalls: Array<{ id: string; predicted: number; actual: number }>;
  /**
   * Our estimator counts characters, the provider counts tokens. Recording the ratio keeps a
   * conservative estimate from being read as a cache shortfall.
   */
  estimatorBias: {
    predictedPrefixTokens: number;
    providerPromptTokens: number;
    ratio: number;
  };
  rate: { cacheHitInputPer1m: number; cacheMissInputPer1m: number; ratio: number };
  savedUsdPerCompaction: number;
};

export type LiveCacheSkipped = { ran: false; reason: string };

const LIVE_IDENTITY: CacheIdentity = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  tenantDigest: digestOf('live-cache-probe'),
  translationVersion: 'openai-compatible/v1',
};

type FunctionTool = OpenAI.Chat.ChatCompletionTool & {
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

/**
 * A controlled cache experiment against the real DeepSeek endpoint.
 *
 * Every fixture carries a per-run nonce in its first token, so each run starts from a
 * genuinely cold prefix and the negative controls cannot be contaminated by an earlier run.
 */
const runLiveCacheProbe = async (
  route: SeededRoute,
): Promise<LiveCacheEvidence | LiveCacheSkipped> => {
  if (!liveEnabled()) {
    return { ran: false, reason: 'live probe not enabled (pass --live or set BEHAVIOR_LIVE_CACHE=1)' };
  }
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || process.env.BEHAVIOR_API_KEY?.trim();
  if (!apiKey) {
    return { ran: false, reason: 'DEEPSEEK_API_KEY is not set' };
  }

  const provider = new DeepSeekChatProvider(
    {
      runtime: { apiBaseUrl: 'https://api.deepseek.com', apiKey },
    } as unknown as ResolvedConfig,
    {},
  );
  const client = provider.getClient();
  const model = route.model;

  const runNonce = `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // A prefix large enough that DeepSeek's 64-token cache granularity is not the story.
  const systemContent = [
    `RUN-NONCE ${runNonce}`,
    'You are a NULL-AI security agent operating under a signed engagement brief.',
    ...Array.from({ length: 120 }, (_, index) =>
      `Rule ${index + 1}: stay inside the authorised scope, record evidence for every claim, `
      + 'and never assert a finding you have not proven against the live target.'),
  ].join(NL);

  const baseMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: 'Begin the assessment of the staging perimeter.' },
    {
      role: 'assistant',
      content: `Enumerating the perimeter. ${'Recording each observed response header. '.repeat(40)}`,
    },
    {
      role: 'user',
      content: `Continue. ${'The previous sweep returned a 403 on every administrative path. '.repeat(40)}`,
    },
  ];

  const tools: FunctionTool[] = TOOL_SCHEMAS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

  const dispatch = async (
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    callTools: FunctionTool[],
  ): Promise<{ raw: RawUsage; normalizedCachedTokens: number | undefined }> => {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: callTools,
      max_tokens: 32,
      temperature: 0,
    });
    const raw = (response.usage ?? {}) as RawUsage;
    const normalized = provider.normalizeUsage(raw as never);
    return { raw, normalizedCachedTokens: normalized?.promptTokensDetails?.cachedTokens };
  };

  const observerEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const observer = new CacheLineageObserver((event, payload) =>
    observerEvents.push({ event, payload }));

  const ancestorProjection = projectOpenAiCompatibleCacheSurface({
    envelope: { model, messages: baseMessages, tools },
    identity: LIVE_IDENTITY,
  });

  const calls: LiveCall[] = [];

  const record = async (input: {
    id: string;
    intent: string;
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools?: FunctionTool[];
    branch?: 'main' | 'auxiliary';
    declaredTransformationIds?: string[];
  }): Promise<LiveCall> => {
    const callTools = input.tools ?? tools;
    const projection = projectOpenAiCompatibleCacheSurface({
      envelope: { model, messages: input.messages, tools: callTools },
      identity: LIVE_IDENTITY,
    });
    const comparison = compareProjections(ancestorProjection, projection);

    const expectation = observer.recordExpectation({
      sessionId: 'live-cache-probe',
      requestId: input.id,
      branch: input.branch ?? 'main',
      cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'cold' },
      projection,
      declaredTransformationIds: input.declaredTransformationIds ?? [],
    });

    const { raw, normalizedCachedTokens } = await dispatch(input.messages, callTools);

    observer.recordObservation({
      sessionId: 'live-cache-probe',
      requestId: input.id,
      attemptId: `${input.id}-attempt-1`,
      attemptOrdinal: 1,
      telemetryState: typeof raw.prompt_cache_hit_tokens === 'number' ? 'reported' : 'not_reported',
      ...(typeof raw.prompt_cache_hit_tokens === 'number'
        ? { cacheReadTokens: raw.prompt_cache_hit_tokens }
        : {}),
      ...(typeof raw.prompt_cache_miss_tokens === 'number'
        ? { uncachedInputTokens: raw.prompt_cache_miss_tokens }
        : {}),
    });

    const observed = observerEvents
      .filter((entry) => entry.event === 'cache.lineage.observed')
      .find((entry) => entry.payload.requestId === input.id);

    const call: LiveCall = {
      id: input.id,
      intent: input.intent,
      promptTokens: raw.prompt_tokens ?? 0,
      cacheHitTokens: raw.prompt_cache_hit_tokens ?? 0,
      cacheMissTokens: raw.prompt_cache_miss_tokens ?? 0,
      completionTokens: raw.completion_tokens ?? 0,
      predictedReusableTokens: input.id === 'cold' ? null : comparison.estimatedReusableTokens,
      normalizedCachedTokens,
      structuralRelation: expectation.structuralRelation,
      assessedOutcome: String(observed?.payload.outcome ?? 'not_assessed'),
    };
    calls.push(call);
    return call;
  };

  // 1. Cold. The nonce guarantees this prefix has never been seen.
  await record({ id: 'cold', intent: 'cold dispatch of the base prefix', messages: baseMessages });

  // 2. The identical request again. This is the reusable ceiling for every later call.
  const warm = await record({
    id: 'warm_repeat',
    intent: 'identical repeat establishes the warm prefix ceiling',
    messages: baseMessages,
  });

  // 3. An ordinary turn: append only. Every probe from here is a side branch against the
  //    same warm ancestor, so one probe's shape never becomes the next probe's baseline.
  await record({
    id: 'append_extension',
    intent: 'ordinary turn appends one message',
    branch: 'auxiliary',
    messages: [
      ...baseMessages,
      { role: 'assistant', content: 'Acknowledged. Selecting the next probe.' },
      { role: 'user', content: 'Proceed with the next probe.' },
    ],
  });

  // 4. The E12 Slice C compaction shape: same prefix, directive appended last.
  const newShape = await record({
    id: 'compaction_new_shape',
    intent: 'E12 compaction replays the warm prefix and appends the directive',
    branch: 'auxiliary',
    messages: [
      ...baseMessages,
      { role: 'user', content: buildCompactionInstruction('pentest') },
    ],
  });

  // 5. Negative control: the pre-E12 shape, a bespoke system prompt over a flattened
  //    transcript. The nonce rides along so this fixture is also cold per run.
  const oldShape = await record({
    id: 'compaction_old_shape',
    intent: 'pre-E12 compaction shape: bespoke system prompt over a rendered transcript',
    branch: 'auxiliary',
    messages: [
      {
        role: 'system',
        content: `RUN-NONCE ${runNonce}${NL}You compress pentest run history for future turns.`,
      },
      {
        role: 'user',
        content: baseMessages
          .map((message) => `${message.role}: ${String((message as { content?: string }).content ?? '')}`)
          .join(NL)
          .slice(0, 2000),
      },
    ],
    tools: [],
  });

  // 6. Negative control for the unbuilt Slice B: rewrite an early message while warm.
  const earlyRewriteMessages = baseMessages.map((message, index) => (index === 2
    ? { ...message, content: `Enumerating the perimeter. ${'REWRITTEN BY A REDUCER. '.repeat(40)}` }
    : message)) as OpenAI.Chat.ChatCompletionMessageParam[];
  const earlyRewrite = await record({
    id: 'early_rewrite',
    intent: 'a reducer rewrites an early message while the prefix is warm',
    branch: 'auxiliary',
    messages: [
      ...earlyRewriteMessages,
      { role: 'assistant', content: 'Acknowledged. Selecting the next probe.' },
      { role: 'user', content: 'Proceed with the next probe.' },
    ],
    declaredTransformationIds: ['reducer:tool_result_rewrite'],
  });

  // 6b. The discriminating probe: change only the LAST message of the prefix. If the provider
  //     serves interior-prefix matches this hits nearly everything, and the early-rewrite loss
  //     is proportional to how early the edit landed. If this also reports zero, then any
  //     in-place edit costs the whole prefix regardless of position.
  const lateRewriteMessages = baseMessages.map((message, index) => (index === 3
    ? { ...message, content: `Continue. ${'REWRITTEN TAIL BY A REDUCER. '.repeat(40)}` }
    : message)) as OpenAI.Chat.ChatCompletionMessageParam[];
  const lateRewrite = await record({
    id: 'late_rewrite',
    intent: 'a reducer rewrites the last prefix message; isolates interior-match behaviour',
    branch: 'auxiliary',
    messages: lateRewriteMessages,
    declaredTransformationIds: ['reducer:tool_result_rewrite'],
  });

  // 7. Diagnostic: where do tool schemas sit in the real cached prefix?
  const toolChange = await record({
    id: 'tool_schema_change',
    intent: 'one tool description changes; measures where tools sit in the real prefix',
    branch: 'auxiliary',
    messages: baseMessages,
    tools: tools.map((tool, index) => (index === 0
      ? {
        ...tool,
        function: { ...tool.function, description: 'CHANGED: send an HTTP request.' },
      }
      : tool)),
  });

  const cacheHitInputPer1m = route.cacheHitInputPer1m ?? 0.022;
  const cacheMissInputPer1m = route.cacheMissInputPer1m ?? 0.66;
  const recovered = newShape.cacheHitTokens - oldShape.cacheHitTokens;

  return {
    ran: true,
    model,
    runNonce,
    calls,
    warmPrefixTokens: warm.cacheHitTokens,
    newShapeHitTokens: newShape.cacheHitTokens,
    oldShapeHitTokens: oldShape.cacheHitTokens,
    recoveredTokensPerCompaction: recovered,
    earlyRewriteHitTokens: earlyRewrite.cacheHitTokens,
    earlyRewritePredictedReusableTokens: earlyRewrite.predictedReusableTokens ?? 0,
    lateRewriteHitTokens: lateRewrite.cacheHitTokens,
    lateRewritePredictedReusableTokens: lateRewrite.predictedReusableTokens ?? 0,
    toolChangeHitTokens: toolChange.cacheHitTokens,
    overclaimedCalls: calls
      .filter((call) => typeof call.predictedReusableTokens === 'number'
        && call.cacheHitTokens < call.predictedReusableTokens * 0.75)
      .map((call) => ({
        id: call.id,
        predicted: call.predictedReusableTokens ?? 0,
        actual: call.cacheHitTokens,
      })),
    estimatorBias: {
      predictedPrefixTokens: ancestorProjection.estimatedTotalTokens,
      providerPromptTokens: warm.promptTokens,
      ratio: warm.promptTokens > 0
        ? Number((ancestorProjection.estimatedTotalTokens / warm.promptTokens).toFixed(3))
        : 0,
    },
    rate: {
      cacheHitInputPer1m,
      cacheMissInputPer1m,
      ratio: Number((cacheMissInputPer1m / cacheHitInputPer1m).toFixed(2)),
    },
    savedUsdPerCompaction: Number(
      ((recovered / 1_000_000) * (cacheMissInputPer1m - cacheHitInputPer1m)).toFixed(6),
    ),
  };
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const reachabilitySchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  isDefault: z.boolean(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  outputReserveRatio: z.number(),
  maxHistoryTokens: z.number().int().nonnegative(),
  firstTrimDropAtTokens: z.number().int().nonnegative().nullable(),
  firstCompactionAtTokens: z.number().int().nonnegative().nullable(),
  trimPreemptsCompaction: z.boolean(),
});

const turnSchema = z.object({
  turn: z.number().int().positive(),
  historyMessages: z.number().int().nonnegative(),
  compacted: z.boolean(),
  droppedMessages: z.number().int().nonnegative(),
  reducerChanged: z.unknown(),
  estimatedTotalTokens: z.number().int().nonnegative(),
  estimatedReusableTokens: z.number().int().nonnegative(),
  reusableRatio: z.number(),
  structuralRelation: z.string().min(1),
  firstDivergenceIndex: z.number().int().nullable(),
});

const liveCallSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  promptTokens: z.number().int().nonnegative(),
  cacheHitTokens: z.number().int().nonnegative(),
  cacheMissTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  predictedReusableTokens: z.number().int().nonnegative().nullable(),
  normalizedCachedTokens: z.number().int().nonnegative().optional(),
  structuralRelation: z.string().min(1),
  assessedOutcome: z.string().min(1),
});

export const harness32ConformanceEvidenceSchema = z.object({
  schema: z.literal(HARNESS_32_CONFORMANCE_EVIDENCE_SCHEMA),
  scenarioId: z.literal(HARNESS_32_CONFORMANCE_SCENARIO_ID),
  generatedAt: z.string().datetime(),
  commit: z.string().min(1),
  claim: z.object({
    text: z.string().min(1),
    answers: z.array(z.string().min(1)).min(1),
  }),
  configuration: z.object({
    routeScale: z.number().int().positive(),
    liveProbeEnabled: z.boolean(),
    seededRoutes: z.number().int().positive(),
  }),
  reducerReachability: z.array(reachabilitySchema).min(1),
  turnPrefixEconomics: z.array(turnSchema).min(1),
  reductionStability: z.object({
    turns: z.number().int().positive(),
    prefixRewrites: z.number().int().nonnegative(),
    rewriteTurns: z.array(z.number().int()),
    uncachedReReadTokens: z.number().int().nonnegative(),
    totalPromptTokens: z.number().int().nonnegative(),
    uncachedShare: z.number(),
    generationsObserved: z.array(z.number().int()),
  }),
  compactionShape: z.object({
    directiveIsTrailingUserMessage: z.boolean(),
    cacheModeDeclared: z.string(),
    toolsPreserved: z.boolean(),
    structuredHistoryPreserved: z.boolean(),
  }),
  providerSurfaceSeam: z.object({
    openAiPrefixDigest: z.string().min(1),
    anthropicPrefixDigest: z.string().min(1),
    digestsDiffer: z.boolean(),
    anthropicTranslationVersion: z.string().min(1),
  }),
  live: z.union([
    z.object({
      ran: z.literal(false),
      reason: z.string().min(1),
    }),
    z.object({
      ran: z.literal(true),
      model: z.string().min(1),
      runNonce: z.string().min(1),
      calls: z.array(liveCallSchema).min(1),
      warmPrefixTokens: z.number().int().nonnegative(),
      newShapeHitTokens: z.number().int().nonnegative(),
      oldShapeHitTokens: z.number().int().nonnegative(),
      recoveredTokensPerCompaction: z.number().int(),
      earlyRewriteHitTokens: z.number().int().nonnegative(),
      earlyRewritePredictedReusableTokens: z.number().int().nonnegative(),
      lateRewriteHitTokens: z.number().int().nonnegative(),
      lateRewritePredictedReusableTokens: z.number().int().nonnegative(),
      toolChangeHitTokens: z.number().int().nonnegative(),
      overclaimedCalls: z.array(z.object({
        id: z.string().min(1),
        predicted: z.number().int().nonnegative(),
        actual: z.number().int().nonnegative(),
      })),
      estimatorBias: z.object({
        predictedPrefixTokens: z.number().int().nonnegative(),
        providerPromptTokens: z.number().int().nonnegative(),
        ratio: z.number(),
      }),
      rate: z.object({
        cacheHitInputPer1m: z.number(),
        cacheMissInputPer1m: z.number(),
        ratio: z.number(),
      }),
      savedUsdPerCompaction: z.number(),
    }),
  ]),
  assertions: z.array(z.object({
    id: z.string().min(1),
    passed: z.boolean(),
    expected: z.unknown(),
    actual: z.unknown(),
    authoritativeSource: z.string().min(1),
    detail: z.string().min(1),
  })).min(1),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    namedMismatches: z.array(z.string()),
    routesWhereTrimPreemptsCompaction: z.array(z.string()),
  }),
});

export type Harness32ConformanceEvidence = z.infer<typeof harness32ConformanceEvidenceSchema>;

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

const run = async (): Promise<AssembledScenarioResult<Harness32ConformanceEvidence>> => {
  const routes = loadSeededRoutes();
  const defaultRoute = routes.find((route) => route.isDefault) ?? routes[0]!;

  // Leg A
  const reducerReachability: ReducerReachability[] = [];
  for (const route of routes) {
    reducerReachability.push(await measureReducerReachability(route));
  }
  const defaultReachability = reducerReachability.find((entry) => entry.isDefault)
    ?? reducerReachability[0]!;
  const routesWhereTrimPreemptsCompaction = reducerReachability
    .filter((entry) => entry.trimPreemptsCompaction)
    .map((entry) => entry.model);

  // Leg B
  const { turns, compactionCall } = await measureTurnPrefixEconomics(defaultRoute);
  const appendOnlyTurns = turns.filter((turn) => !turn.compacted && turn.droppedMessages === 0
    && turn.turn > 1);
  const reducingTurns = turns.filter((turn) => turn.compacted || turn.droppedMessages > 0);

  // Compaction request shape, read off the request the shipping stage dispatched.
  const auxiliaryMessages = compactionCall?.messages ?? [];
  const trailing = auxiliaryMessages[auxiliaryMessages.length - 1];
  const compactionShape = {
    directiveIsTrailingUserMessage: trailing?.role === 'user'
      && String(trailing.content ?? '').includes('THE CONVERSATION ABOVE'),
    cacheModeDeclared: String(compactionCall?.cacheMode?.kind ?? 'none'),
    toolsPreserved: Array.isArray(compactionCall?.tools) && compactionCall.tools.length > 0,
    structuredHistoryPreserved: auxiliaryMessages.slice(0, -1)
      .some((message) => message.role === 'assistant'),
  };

  // The provider seam: the recorded envelope is not what Anthropic caches on.
  const seamEnvelope = {
    model: 'seam-check',
    messages: [
      { role: 'system', content: 'you are a security agent' },
      { role: 'user', content: 'enumerate the target' },
    ],
    tools: [{ type: 'function', function: { name: 'http_request', description: 'send http' } }],
  };
  const seamIdentity: CacheIdentity = {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    tenantDigest: digestOf('seam'),
    translationVersion: 'placeholder',
  };
  const openAiSeam = projectOpenAiCompatibleCacheSurface({
    envelope: seamEnvelope,
    identity: seamIdentity,
  });
  const anthropicSeam = projectAnthropicCacheSurface({
    envelope: seamEnvelope,
    identity: seamIdentity,
  });
  const providerSurfaceSeam = {
    openAiPrefixDigest: openAiSeam.prefixDigest,
    anthropicPrefixDigest: anthropicSeam.prefixDigest,
    digestsDiffer: openAiSeam.prefixDigest !== anthropicSeam.prefixDigest,
    anthropicTranslationVersion: anthropicSeam.identity.translationVersion,
  };

  // Leg B2
  const reductionStability = measureReductionStability();

  // Leg B3
  const warmRefusal = measureWarmCacheRefusal();

  // Leg C
  const live = await runLiveCacheProbe(defaultRoute);

  // -------------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------------

  const assertions: VerificationAssertion[] = [
    assertion(
      'reducer.default_route_summarises_before_it_truncates',
      defaultReachability.trimPreemptsCompaction === false
        && defaultReachability.firstCompactionAtTokens !== null,
      { trimPreemptsCompaction: false, compactionReachable: true },
      {
        trimPreemptsCompaction: defaultReachability.trimPreemptsCompaction,
        firstCompactionAtTokens: defaultReachability.firstCompactionAtTokens,
        firstTrimDropAtTokens: defaultReachability.firstTrimDropAtTokens,
      },
      'On the default route the summariser must reach the history before the trimmer discards it.',
    ),
    assertion(
      'reducer.no_route_truncates_before_it_summarises',
      routesWhereTrimPreemptsCompaction.length === 0,
      { routesWhereTrimPreemptsCompaction: [] },
      { routesWhereTrimPreemptsCompaction },
      'D18: the trimmer capped history on the model window while compaction triggered on the '
        + 'routed soft threshold, so on four of five seeded routes head-tail dropping ran '
        + 'first and the summariser never saw the range it would have preserved. What the '
        + 'trimmer drops is gone with no summary standing in for it.',
    ),
    assertion(
      'reducer.every_route_reaches_compaction',
      reducerReachability.every((entry) => entry.firstCompactionAtTokens !== null),
      'compaction reachable on every seeded route',
      reducerReachability.map((entry) => ({
        model: entry.model,
        firstCompactionAtTokens: entry.firstCompactionAtTokens,
      })),
      'A route that can never compact has an emergency truncation as its only reducer.',
    ),
    assertion(
      'prefix.append_only_turns_reuse_the_whole_prefix',
      appendOnlyTurns.length > 0
        && appendOnlyTurns.every((turn) => turn.structuralRelation === 'append_extension'
          && turn.firstDivergenceIndex === null),
      { relation: 'append_extension', firstDivergenceIndex: null },
      appendOnlyTurns.map((turn) => ({
        turn: turn.turn,
        relation: turn.structuralRelation,
        firstDivergenceIndex: turn.firstDivergenceIndex,
        reusableRatio: turn.reusableRatio,
      })),
      'An ordinary turn must extend the cached prefix, never rewrite it.',
    ),
    assertion(
      'prefix.a_reducing_turn_is_named_not_hidden',
      reducingTurns.length > 0
        && reducingTurns.every((turn) => turn.structuralRelation !== 'append_extension'),
      'reducing turns classified as a rewrite',
      reducingTurns.map((turn) => ({
        turn: turn.turn,
        compacted: turn.compacted,
        dropped: turn.droppedMessages,
        relation: turn.structuralRelation,
        reusableRatio: turn.reusableRatio,
      })),
      'The turn that reduces pays the cache; it must be attributable, not read as an append.',
    ),
    assertion(
      'compaction.request_is_an_exact_prefix_extension',
      compactionShape.directiveIsTrailingUserMessage
        && compactionShape.cacheModeDeclared === 'reuse_ancestor'
        && compactionShape.toolsPreserved
        && compactionShape.structuredHistoryPreserved,
      {
        directiveIsTrailingUserMessage: true,
        cacheModeDeclared: 'reuse_ancestor',
        toolsPreserved: true,
        structuredHistoryPreserved: true,
      },
      compactionShape,
      'E12 Slice C: the summariser reads the warm prefix and appends only the directive.',
    ),
    assertion(
      'reduction.does_not_rewrite_the_prefix_on_every_turn',
      reductionStability.prefixRewrites <= Math.ceil(reductionStability.turns / 10),
      { atMostRewrites: Math.ceil(reductionStability.turns / 10), turns: reductionStability.turns },
      {
        prefixRewrites: reductionStability.prefixRewrites,
        rewriteTurns: reductionStability.rewriteTurns,
      },
      'Before E12 Slice B the protected window slid one message per turn, so every turn rewrote an already-cached message.',
    ),
    assertion(
      'reduction.keeps_most_of_the_prompt_cacheable',
      reductionStability.uncachedShare <= 0.2,
      { uncachedShareAtMost: 0.2 },
      {
        uncachedShare: reductionStability.uncachedShare,
        uncachedReReadTokens: reductionStability.uncachedReReadTokens,
        totalPromptTokens: reductionStability.totalPromptTokens,
      },
      'The same fixture re-read 72.9% of its prompt tokens uncached before the boundary was quantized.',
    ),
    assertion(
      'reduction.advances_the_boundary_in_generations',
      reductionStability.generationsObserved.length > 1
        && reductionStability.prefixRewrites
          <= reductionStability.generationsObserved.length,
      'one rewrite per generation crossing at most',
      {
        generationsObserved: reductionStability.generationsObserved,
        prefixRewrites: reductionStability.prefixRewrites,
      },
      'A quantized boundary must move in jumps; a boundary that creeps is the defect itself.',
    ),
    assertion(
      'reduction.refuses_to_rewrite_a_warm_prefix_it_cannot_pay_for',
      warmRefusal.coldCacheReductions > 0
        && warmRefusal.refusedTurns === warmRefusal.coldCacheReductions,
      { everyWarmCandidateRefused: true },
      {
        coldCacheReductions: warmRefusal.coldCacheReductions,
        refusedTurns: warmRefusal.refusedTurns,
        refusalReasons: warmRefusal.refusalReasons,
      },
      'Run r1 fired this path twice unforced and lost about $0.0929 to recover $0.0005. '
        + 'Rare and unprofitable is still unprofitable.',
    ),
    assertion(
      'reduction.prices_the_rewrite_and_never_calls_a_loss_a_saving',
      warmRefusal.bestBenefitToLossRatio < 1,
      { bestBenefitToLossRatioBelow: 1 },
      { bestBenefitToLossRatio: warmRefusal.bestBenefitToLossRatio },
      'While selection is oldest-first the boundary lands near the head, so the whole warm '
        + 'prefix is at risk and no ordinary firing can pay. D15 is what changes this.',
    ),
    assertion(
      'reduction.the_boundary_marches_toward_the_tail_as_history_deepens',
      warmRefusal.deepestGeneration >= 3
        && warmRefusal.boundaryShareOfHistoryAtDeepest > 0.25,
      { deepestGenerationAtLeast: 3, boundaryShareAbove: 0.25 },
      {
        deepestGeneration: warmRefusal.deepestGeneration,
        boundaryShareOfHistoryAtDeepest: warmRefusal.boundaryShareOfHistoryAtDeepest,
        bestRatioAtDeepestGeneration: warmRefusal.bestRatioAtDeepestGeneration,
      },
      'Before D15 the plan reduced everything behind the horizon oldest-first, so the boundary '
        + 'sat at message 3 or 4 no matter how long the run got. Each generation now owns one '
        + 'band and the boundary advances with it.',
    ),
    assertion(
      'reduction.an_unpriced_reduction_is_refused_not_guessed',
      warmRefusal.unpricedReasons.length === 1
        && warmRefusal.unpricedReasons[0] === 'economics_unknown',
      { reasons: ['economics_unknown'] },
      { reasons: warmRefusal.unpricedReasons },
      'A call site that cannot price its own rewrite must not perform one. Measured only on '
        + 'histories the cold-cache control proves have candidates.',
    ),
    assertion(
      'seam.recorded_envelope_is_not_the_provider_cache_surface',
      providerSurfaceSeam.digestsDiffer
        && providerSurfaceSeam.anthropicTranslationVersion === 'anthropic-request-translator/v1',
      { digestsDiffer: true, translationVersion: 'anthropic-request-translator/v1' },
      providerSurfaceSeam,
      'Anthropic hoists system content during translation; comparing the recorded envelope would compare the wrong representation.',
    ),
  ];

  if (live.ran) {
    const ceiling = live.warmPrefixTokens;
    const appendCall = live.calls.find((call) => call.id === 'append_extension')!;
    const newShapeCall = live.calls.find((call) => call.id === 'compaction_new_shape')!;
    const oldShapeCall = live.calls.find((call) => call.id === 'compaction_old_shape')!;
    const earlyRewriteCall = live.calls.find((call) => call.id === 'early_rewrite')!;

    assertions.push(
      assertion(
        'live.repeat_of_a_warm_prefix_hits_the_provider_cache',
        ceiling > 0,
        'cacheHitTokens > 0 on an identical repeat',
        { warmPrefixTokens: ceiling },
        'Establishes the reusable ceiling every later live assertion is measured against.',
      ),
      assertion(
        'live.append_extension_preserves_the_prefix',
        appendCall.cacheHitTokens >= ceiling * 0.9,
        { atLeast: Math.round(ceiling * 0.9) },
        { cacheHitTokens: appendCall.cacheHitTokens },
        'An ordinary turn must keep the whole warm prefix on the real provider.',
      ),
      assertion(
        'live.new_compaction_shape_preserves_the_prefix',
        newShapeCall.cacheHitTokens >= ceiling * 0.9,
        { atLeast: Math.round(ceiling * 0.9) },
        { cacheHitTokens: newShapeCall.cacheHitTokens },
        'The E12 Slice C claim, measured against real DeepSeek cache telemetry.',
      ),
      assertion(
        'live.negative_control_old_compaction_shape_loses_the_prefix',
        oldShapeCall.cacheHitTokens <= ceiling * 0.2,
        { atMost: Math.round(ceiling * 0.2) },
        { cacheHitTokens: oldShapeCall.cacheHitTokens },
        'Restoring the pre-E12 shape must measurably lose the cache, or the gate proves nothing.',
      ),
      assertion(
        'live.negative_control_early_rewrite_loses_the_suffix',
        earlyRewriteCall.cacheHitTokens < appendCall.cacheHitTokens,
        { lessThan: appendCall.cacheHitTokens },
        { cacheHitTokens: earlyRewriteCall.cacheHitTokens },
        'Evidence for the unbuilt Slice B: rewriting an early message while warm discards everything after it.',
      ),
      assertion(
        'live.provider_adapter_reads_the_cache_telemetry',
        live.calls.every((call) => call.normalizedCachedTokens === call.cacheHitTokens),
        'normalizeUsage reports the provider cache field on every call',
        live.calls.map((call) => ({
          id: call.id,
          raw: call.cacheHitTokens,
          normalized: call.normalizedCachedTokens,
        })),
        'E7 accounting is only as good as the adapter that reads the provider payload.',
      ),
      assertion(
        'live.lineage_classifies_each_probe_against_the_warm_ancestor',
        appendCall.structuralRelation === 'auxiliary_extension'
          && newShapeCall.structuralRelation === 'auxiliary_extension'
          && oldShapeCall.structuralRelation === 'unexplained_divergence'
          && earlyRewriteCall.structuralRelation === 'declared_rewrite',
        {
          append_extension: 'auxiliary_extension',
          compaction_new_shape: 'auxiliary_extension',
          compaction_old_shape: 'unexplained_divergence',
          early_rewrite: 'declared_rewrite',
        },
        Object.fromEntries(live.calls.map((call) => [call.id, call.structuralRelation])),
        'Slice A must reach the same structural verdict the provider telemetry then confirms.',
      ),
      assertion(
        'live.projection_is_an_upper_bound_and_never_overclaims_a_hit',
        live.calls.every((call) => call.assessedOutcome !== 'hit_as_expected'
          || call.cacheHitTokens >= (call.predictedReusableTokens ?? 0) * 0.9),
        'no call is assessed hit_as_expected while the provider delivered less reuse than predicted',
        live.calls.map((call) => ({
          id: call.id,
          predicted: call.predictedReusableTokens,
          actual: call.cacheHitTokens,
          outcome: call.assessedOutcome,
        })),
        'The provider can deliver far less than the structural prefix suggests; an estimate must never be reported as a confirmed hit.',
      ),
      assertion(
        'live.assessment_separates_divergence_from_provider_miss',
        newShapeCall.assessedOutcome !== 'telemetry_unavailable'
          && oldShapeCall.assessedOutcome !== 'telemetry_unavailable',
        'every live call reaches a real assessment',
        live.calls.map((call) => ({
          id: call.id,
          relation: call.structuralRelation,
          outcome: call.assessedOutcome,
        })),
        'Slice A must classify real telemetry, not only its own fixtures.',
      ),
    );
  }

  const namedMismatches = assertions.filter((entry) => !entry.passed).map((entry) => entry.id);
  const negativeControlDetected = live.ran
    ? live.oldShapeHitTokens <= live.warmPrefixTokens * 0.2
      && live.earlyRewriteHitTokens
        < (live.calls.find((call) => call.id === 'append_extension')?.cacheHitTokens ?? 0)
    : reducingTurns.some((turn) => turn.structuralRelation !== 'append_extension');

  const evidence: Harness32ConformanceEvidence = {
    schema: HARNESS_32_CONFORMANCE_EVIDENCE_SCHEMA,
    scenarioId: HARNESS_32_CONFORMANCE_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: commit(),
    claim: {
      text: 'Harness 3.2 reduces context by summarising rather than truncating on the routed default model, and its compaction request keeps the provider cache warm on a real provider.',
      answers: [
        'Which reducer engages first on each routed model, and where the trimmer pre-empts the summariser.',
        'What a turn costs the cached prefix, measured on the shipping BuildStage.',
        'Whether the E12 compaction shape keeps the prefix on real DeepSeek telemetry, and what the pre-E12 shape lost.',
        'Whether rewriting an early message while warm is expensive enough to justify the unbuilt convergent reducer.',
      ],
    },
    configuration: {
      routeScale: ROUTE_SCALE,
      liveProbeEnabled: live.ran,
      seededRoutes: routes.length,
    },
    reducerReachability,
    turnPrefixEconomics: turns,
    reductionStability,
    compactionShape,
    providerSurfaceSeam,
    live,
    assertions,
    verdict: {
      correctedFixturePassed: namedMismatches.length === 0,
      negativeControlDetected,
      namedMismatches,
      routesWhereTrimPreemptsCompaction,
    },
  };

  const parsed = harness32ConformanceEvidenceSchema.safeParse(evidence);
  const passed = namedMismatches.length === 0 && negativeControlDetected && parsed.success;

  return {
    id: HARNESS_32_CONFORMANCE_SCENARIO_ID,
    title: 'Harness 3.2 conformance and prompt-cache economics',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(passed ? {} : {
      error: `mismatches=${namedMismatches.join(',')}; negativeControlDetected=${negativeControlDetected}; schema=${parsed.success}`
        + (parsed.success ? '' : `; schemaErrors=${parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`),
    }),
  };
};

export const harness32ConformanceScenario:
AssembledBehaviorScenario<Harness32ConformanceEvidence> = {
  id: HARNESS_32_CONFORMANCE_SCENARIO_ID,
  title: 'Harness 3.2 conformance and prompt-cache economics',
  why: 'Proves which reducer owns context reduction on every routed model, measures what a turn costs the cached prefix, and — with --live — verifies the E12 prefix claim against real DeepSeek cache telemetry with two negative controls.',
  run,
};
