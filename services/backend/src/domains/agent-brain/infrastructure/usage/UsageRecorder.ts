import * as fs from 'fs/promises';
import * as path from 'path';
import { type S3StorageService } from '@/shared/storage/S3StorageService';
import type { SessionStore } from '../../application/core/SessionStore';
import type { SessionUsage } from '../../domain/types';
import type { SessionTraceRecorder } from '../telemetry';
import type {
  BeginUsageAttemptInput,
  FailUsageAttemptInput,
  ModelAttemptReasoningSource,
  UsageAttemptHandle,
  UsageStorePort,
  UsageTrackerPort,
} from '../../ports';
import { logger } from '@/shared/logger';
import type { TokenGuard } from '../../application/services/TokenGuard';
import { readSessionExecutionProfile } from '../../domain/runtime/ExecutionRuntimeRegistry';

export const TOKEN_USAGE_FLAG = 'token_usage_totals';
export const TOKEN_USAGE_HISTORY_FLAG = 'token_usage_history';
const TURN_LATENCY_FLAG = 'turn_latency_stats';
const CONTEXT_BUDGET_TOTALS_FLAG = 'context_budget_totals';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const assertProviderTokenCount = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Provider usage ${field} must be a non-negative safe integer`);
  }
};

const readOrganizationId = (flags: Record<string, unknown> | undefined): string | undefined => {
  const securityops = isRecord(flags?.securityops) ? flags.securityops : undefined;
  return readString(securityops?.organizationId);
};

const readResolvedModelId = (flags: Record<string, unknown> | undefined): string | undefined => {
  const selection = isRecord(flags?.model_selection) ? flags.model_selection : undefined;
  return readString(selection?.resolvedModelId);
};

const readRequestedModelCategory = (flags: Record<string, unknown> | undefined): string | undefined => {
  const selection = isRecord(flags?.model_selection) ? flags.model_selection : undefined;
  return readString(selection?.requestedCategory);
};

/**
 * D7 - `promptTokens` meant two different things under one name. Here and in the database
 * column it is **uncached** input; in the `usage.recorded` trace payload it was **total**
 * input. Same vocabulary, same event name, two meanings, and an admin timeline that printed
 * a 1,117% cache rate as a result.
 *
 * The explicit fields below are the accounting primitives. `promptTokens` is retained only
 * so existing readers keep working, and it keeps its established meaning of uncached input.
 * Nothing new should read it.
 */
export interface RecordedUsageSummary {
  /** Uncached input only. Prefer `uncachedInputTokens`. */
  promptTokens: number;
  /** Every input token the provider billed, cached and uncached. */
  inputTokensTotal: number;
  /** Input tokens the provider served from its cache. */
  cacheReadTokens: number;
  /** Input tokens the provider charged to populate its cache. */
  cacheWriteTokens: number;
  /** Input tokens that were neither read from nor written to cache. */
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead: number;
  platformCost: number;
  platformPrice: number;
  credits: number;
  currency: string;
  model: string;
}

export class UsageRecorder {
  /**
   * D6 - `traceRecorder` here is a fallback for callers that own one for the whole
   * recorder's life, such as the Behavior Lab. Production does not: the trace recorder has
   * a per-turn lifetime, which is why `TurnRunner` passed `undefined` and every
   * `model.attempt.*` and `usage.recorded` event was silently lost for the life of the
   * feature. The authoritative path is the recorder handed to `beginAttempt`, which is
   * bound to the attempt and therefore has the right lifetime.
   */
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly usageTracker?: UsageTrackerPort,
    private readonly usageStore?: UsageStorePort,
    private modelName?: string,
    private readonly tokenGuard?: TokenGuard,
    private readonly tracesS3?: { client: S3StorageService; bucket: string },
    private readonly traceRecorder?: SessionTraceRecorder,
    private readonly traceRoot: string = 'storage/object-store/traces',
  ) {}
  private readonly log = logger.child({ scope: 'UsageRecorder' });
  private readonly attemptContexts = new Map<
    string,
    {
      sessionId: string;
      turn?: number | null;
      requestId?: string | null;
      /** Bound at `beginAttempt`, so the settle path writes to the same trace. */
      traceRecorder?: SessionTraceRecorder;
      attemptOrdinal: number;
      provider: string;
      model: string;
    }
  >();

  setModelName(modelName?: string): void {
    this.modelName = modelName;
  }

  async beginAttempt(
    sessionId: string,
    input: Omit<BeginUsageAttemptInput, 'sessionId' | 'userId' | 'organizationId' | 'modelId'>,
    traceRecorder?: SessionTraceRecorder,
  ): Promise<UsageAttemptHandle> {
    const session = this.sessionStore.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} was not found before model dispatch`);
    if (!this.usageStore) {
      throw new Error('Durable usage store is unavailable; provider dispatch is blocked');
    }
    const organizationId = readOrganizationId(session.flags) ?? null;
    const executionProfile = readSessionExecutionProfile(session.flags);
    const modelId = executionProfile?.pricingModelId ?? readResolvedModelId(session.flags) ?? null;
    // Declared here rather than derived by the store, because both are facts about which
    // runtime this process booted on, and the store's job is to price an attempt, not to
    // guess where it ran.
    const runtimeBackend = executionProfile?.executionBackend ?? 'api';
    const providerIdentity = executionProfile?.providerIdentity ?? input.provider;
    const effectiveModelName = executionProfile?.effectiveModel;
    const attempt = await this.usageStore.beginAttempt({
      ...input,
      sessionId,
      userId: session.userId ?? null,
      organizationId,
      modelId,
      requestedCategory: input.requestedCategory ?? readRequestedModelCategory(session.flags) ?? null,
      // `provider` is the model vendor; the process/transport that carried the request is recorded
      // independently as `executionBackend`. External runtimes make those values visibly differ.
      provider: providerIdentity,
      executionBackend: runtimeBackend,
      ...(effectiveModelName ? { effectiveModelName } : {}),
    });
    const attemptTrace = traceRecorder ?? this.traceRecorder;
    this.attemptContexts.set(attempt.id, {
      sessionId,
      turn: input.turn,
      requestId: input.modelRequestId,
      traceRecorder: attemptTrace,
      attemptOrdinal: attempt.attemptOrdinal,
      provider: attempt.provider,
      model: attempt.modelName,
    });
    if (attemptTrace) {
      await attemptTrace.write(sessionId, input.turn ?? 0, {
        event: 'model.attempt.started',
        severity: 'info',
        payload: {
          requestId: input.modelRequestId ?? undefined,
          attemptId: attempt.id,
          attemptOrdinal: attempt.attemptOrdinal,
          provider: attempt.provider,
          model: attempt.modelName,
          status: 'started',
          circuitState: input.circuitState,
          circuitDecision: input.circuitDecision,
        },
        note: `provider attempt ${attempt.attemptOrdinal} started`,
      });
    }
    return attempt;
  }

  async failAttempt(input: FailUsageAttemptInput): Promise<void> {
    if (!this.usageStore) {
      throw new Error('Durable usage store is unavailable while finalizing provider failure');
    }
    await this.usageStore.failAttempt(input);
    const context = this.attemptContexts.get(input.attemptId);
    const failTrace = context?.traceRecorder ?? this.traceRecorder;
    if (context && failTrace) {
      await failTrace.write(context.sessionId, context.turn ?? 0, {
        event: 'model.attempt.settled',
        severity: input.status === 'cancelled' ? 'warn' : 'info',
        payload: {
          requestId: context.requestId ?? undefined,
          attemptId: input.attemptId,
          attemptOrdinal: context.attemptOrdinal,
          provider: context.provider,
          model: context.model,
          providerRequestId: input.providerRequestId ?? undefined,
          status: input.status,
          errorClass: input.errorClass ?? undefined,
          retryDecision: input.retryDecision ?? undefined,
          backoffMs: input.backoffMs ?? undefined,
          reasoningTokens: input.reasoningTokens ?? 0,
          reasoningSource: input.reasoningSource ?? 'unavailable',
        },
        note: `provider attempt ${context.attemptOrdinal} ${input.status}`,
      });
    }
  }

  async recordUsage(
    sessionId: string,
    usage?: {
      promptTokens: number;
      cachedPromptTokens?: number;
      completionTokens: number;
      totalTokens: number;
      promptTokensDetails?: {
        cachedTokens?: number;
        cacheWriteTokens?: number;
      };
      cacheWriteTokens?: number;
      provider?: string;
      model?: string;
    },
    meta?: {
      turn?: number;
      attemptId: string;
      providerRequestId?: string;
      reportedModel?: string;
      reasoningTokens?: number;
      reasoningSource?: ModelAttemptReasoningSource;
    },
  ): Promise<RecordedUsageSummary | undefined> {
    if (!usage) {
      return undefined;
    }

    try {
      const promptTotal = usage.promptTokens ?? 0;
      const completionTotal = usage.completionTokens ?? 0;
      const cachedTokens = usage.cachedPromptTokens ?? usage.promptTokensDetails?.cachedTokens ?? 0;
      const cacheWriteTokens =
        usage.cacheWriteTokens ??
        (usage.promptTokensDetails as { cacheWriteTokens?: number } | undefined)?.cacheWriteTokens ??
        0;
      assertProviderTokenCount(promptTotal, 'promptTokens');
      assertProviderTokenCount(completionTotal, 'completionTokens');
      assertProviderTokenCount(cachedTokens, 'cachedPromptTokens');
      assertProviderTokenCount(cacheWriteTokens, 'cacheWriteTokens');
      if (cachedTokens + cacheWriteTokens > promptTotal) {
        throw new Error('Provider usage cache read and cache write tokens cannot exceed promptTokens');
      }
      const uncachedPrompt = Math.max(promptTotal - cachedTokens - cacheWriteTokens, 0);
      const totalTokens = uncachedPrompt + cachedTokens + cacheWriteTokens + completionTotal;
      const providerName = usage.provider;

      if (!meta?.attemptId || !this.usageStore) {
        throw new Error('Provider usage cannot finalize without its durable attempt identity');
      }
      const finalized = await this.usageStore.completeAttempt({
        attemptId: meta.attemptId,
        requestCompletedAt: new Date(),
        providerRequestId: meta.providerRequestId,
        reportedModel: meta.reportedModel,
        promptTokens: uncachedPrompt,
        cachedPromptTokens: cachedTokens,
        cacheWriteTokens,
        completionTokens: completionTotal,
        totalTokens,
        reasoningTokens: meta.reasoningTokens ?? 0,
        reasoningSource: meta.reasoningSource ?? 'unavailable',
        retryDecision: 'stop',
      });
      const nativeCost = finalized.nativeCost;
      const overhead = finalized.overhead;
      const platformCost = finalized.platformCost;
      const platformPrice = finalized.platformPrice;
      const credits = finalized.debitedCredits;
      const resolvedModelName = finalized.model || this.modelName || usage.model || 'unknown';
      const summary: RecordedUsageSummary = {
        promptTokens: uncachedPrompt,
        inputTokensTotal: promptTotal,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens,
        uncachedInputTokens: uncachedPrompt,
        outputTokens: completionTotal,
        reasoningTokens: meta?.reasoningTokens ?? 0,
        cachedPromptTokens: cachedTokens,
        completionTokens: completionTotal,
        totalTokens,
        nativeCost,
        overhead,
        platformCost,
        platformPrice,
        credits,
        currency: finalized.currency,
        model: resolvedModelName,
      };
      if (finalized.replayed) return summary;
      const session = this.sessionStore.get(sessionId);
      if (!session) return summary;
      const userId = session.userId;
      try {
        this.tokenGuard?.recordUsage({
          sessionId,
          userId,
          tokens: totalTokens,
        });
        if (userId && this.usageTracker) {
          await this.usageTracker.recordChatUsage({
            userId,
            sessionId,
            promptTokens: promptTotal,
            completionTokens: completionTotal,
            model: resolvedModelName,
          });
        }
      } catch (error) {
        this.log.warn({ err: error, sessionId }, 'Durable usage finalized but secondary usage telemetry failed');
      }
      const contextWindow = null;
      const contextRemaining = null;
      session.flags = session.flags ?? {};
      const aggregate = (session.flags[TOKEN_USAGE_FLAG] as Partial<SessionUsage> | undefined) ?? {};
      const nextTotals: SessionUsage = {
        promptTokens: (aggregate.promptTokens ?? 0) + uncachedPrompt,
        cachedPromptTokens: (aggregate.cachedPromptTokens ?? 0) + cachedTokens,
        cacheWriteTokens: (aggregate.cacheWriteTokens ?? 0) + cacheWriteTokens,
        completionTokens: (aggregate.completionTokens ?? 0) + completionTotal,
        totalTokens: (aggregate.totalTokens ?? 0) + totalTokens,
        cost: (aggregate.cost ?? 0) + nativeCost,
        overhead: (aggregate.overhead ?? 0) + overhead,
        platformCost: (aggregate.platformCost ?? 0) + platformCost,
        platformPrice: (aggregate.platformPrice ?? 0) + platformPrice,
        credits: (aggregate.credits ?? 0) + credits,
        currency: finalized.currency,
        model: resolvedModelName,
        contextWindow,
        contextRemaining,
      };
      const promptBudget = isRecord(session.flags.context_budget_last) ? session.flags.context_budget_last : undefined;
      const estimatedPromptTokens = readNumber(promptBudget?.totalPromptEstimate);
      const promptEstimateDelta = estimatedPromptTokens !== undefined ? promptTotal - estimatedPromptTokens : undefined;
      const promptEstimateErrorPct =
        estimatedPromptTokens !== undefined && promptTotal > 0
          ? Math.round((Math.abs(promptEstimateDelta ?? 0) / promptTotal) * 100)
          : undefined;
      const contextBudgetTotals = isRecord(session.flags[CONTEXT_BUDGET_TOTALS_FLAG])
        ? session.flags[CONTEXT_BUDGET_TOTALS_FLAG]
        : {};
      session.flags[CONTEXT_BUDGET_TOTALS_FLAG] = {
        calls: (readNumber(contextBudgetTotals.calls) ?? 0) + 1,
        estimatedPromptTokens:
          (readNumber(contextBudgetTotals.estimatedPromptTokens) ?? 0) + (estimatedPromptTokens ?? 0),
        actualPromptTokens: (readNumber(contextBudgetTotals.actualPromptTokens) ?? 0) + promptTotal,
        cachedPromptTokens: (readNumber(contextBudgetTotals.cachedPromptTokens) ?? 0) + cachedTokens,
        cacheWriteTokens: (readNumber(contextBudgetTotals.cacheWriteTokens) ?? 0) + cacheWriteTokens,
        toolSchemaTokens:
          (readNumber(contextBudgetTotals.toolSchemaTokens) ?? 0) + (readNumber(promptBudget?.toolSchemaTokens) ?? 0),
        toolResultTokens:
          (readNumber(contextBudgetTotals.toolResultTokens) ?? 0) + (readNumber(promptBudget?.toolResultTokens) ?? 0),
        softContextTokens:
          (readNumber(contextBudgetTotals.softContextTokens) ?? 0) + (readNumber(promptBudget?.softContextTokens) ?? 0),
        historyTokens:
          (readNumber(contextBudgetTotals.historyTokens) ?? 0) + (readNumber(promptBudget?.historyTokens) ?? 0),
        microcompactedToolResults:
          (readNumber(contextBudgetTotals.microcompactedToolResults) ?? 0) +
          (readNumber(promptBudget?.microcompactedToolResults) ?? 0),
        microcompactionSavedTokens:
          (readNumber(contextBudgetTotals.microcompactionSavedTokens) ?? 0) +
          (readNumber(promptBudget?.microcompactionSavedTokens) ?? 0),
      };

      const history: Record<string, unknown>[] = [];
      const rawHistory = session.flags[TOKEN_USAGE_HISTORY_FLAG];
      if (Array.isArray(rawHistory)) {
        for (const entry of rawHistory) {
          if (isRecord(entry)) {
            history.push(entry);
          }
        }
      } else if (isRecord(rawHistory) && Array.isArray(rawHistory.entries)) {
        for (const entry of rawHistory.entries) {
          if (isRecord(entry)) {
            history.push(entry);
          }
        }
      }
      history.push({
        ts: Date.now(),
        turn: meta?.turn ?? null,
        promptTokens: uncachedPrompt,
        cachedPromptTokens: cachedTokens,
        cacheWriteTokens,
        completionTokens: completionTotal,
        totalTokens,
        cost: nativeCost,
        overhead,
        platformCost,
        platformPrice,
        credits,
        provider: providerName,
        model: resolvedModelName,
        ...(estimatedPromptTokens !== undefined
          ? {
              estimatedPromptTokens,
              promptEstimateDelta,
              promptEstimateErrorPct,
            }
          : {}),
      });
      while (history.length > 50) {
        history.shift();
      }

      const historyPayload: Record<string, unknown> = { entries: history };

      session.flags = {
        ...session.flags,
        [TOKEN_USAGE_FLAG]: nextTotals,
        [TOKEN_USAGE_HISTORY_FLAG]: historyPayload,
      };

      session.usage = nextTotals;

      await this.appendCostLog({
        sessionId,
        turn: meta?.turn,
        promptTokens: uncachedPrompt,
        cachedPromptTokens: cachedTokens,
        cacheWriteTokens,
        completionTokens: completionTotal,
        totalTokens,
        cost: nativeCost,
        overhead,
        platformCost,
        platformPrice,
        credits,
        currency: nextTotals.currency,
        model: resolvedModelName,
      });

      this.sessionStore.set(sessionId, session);

      const attemptContext = this.attemptContexts.get(meta.attemptId);
      const usageTrace = attemptContext?.traceRecorder ?? this.traceRecorder;
      if (usageTrace) {
        await usageTrace.write(sessionId, meta?.turn ?? 0, {
          event: 'model.attempt.settled',
          severity: 'info',
          payload: {
            requestId: attemptContext?.requestId ?? undefined,
            attemptId: meta.attemptId,
            attemptOrdinal: attemptContext?.attemptOrdinal,
            provider: attemptContext?.provider ?? providerName,
            model: resolvedModelName,
            providerRequestId: meta.providerRequestId,
            status: 'succeeded',
            retryDecision: 'stop',
            usage: {
              uncachedInput: uncachedPrompt,
              cacheRead: cachedTokens,
              cacheWrite: cacheWriteTokens,
              output: completionTotal,
              reasoning: meta.reasoningTokens ?? 0,
              reasoningSource: meta.reasoningSource ?? 'unavailable',
            },
          },
          note: `provider attempt ${attemptContext?.attemptOrdinal ?? '?'} succeeded`,
        });
        await usageTrace.write(sessionId, meta?.turn ?? 0, {
          event: 'usage.recorded',
          severity: 'info',
          payload: {
            // D7 - explicit names only. `promptTokens` here meant total input
            // while the same field on the summary meant uncached input.
            inputTokensTotal: promptTotal,
            uncachedInputTokens: uncachedPrompt,
            cacheReadTokens: cachedTokens,
            cacheWriteTokens,
            outputTokens: completionTotal,
            cachedPromptTokens: cachedTokens,
            completionTokens: completionTotal,
            totalTokens,
            cost: nativeCost,
            nativeCost,
            overhead,
            platformCost,
            platformPrice,
            credits,
            currency: nextTotals.currency,
            model: resolvedModelName,
            requestId: this.attemptContexts.get(meta.attemptId)?.requestId ?? undefined,
            attemptId: meta.attemptId,
            attemptOrdinal: this.attemptContexts.get(meta.attemptId)?.attemptOrdinal,
            reasoningTokens: meta.reasoningTokens ?? 0,
            reasoningSource: meta.reasoningSource ?? 'unavailable',
            ...(estimatedPromptTokens !== undefined
              ? {
                  promptEstimate: {
                    estimatedPromptTokens,
                    actualPromptTokens: promptTotal,
                    delta: promptEstimateDelta,
                    errorPct: promptEstimateErrorPct,
                    cachedPromptTokens: cachedTokens,
                    contextWindow: readNumber(promptBudget?.contextWindow),
                    totalPromptEstimateBeforeTrim: readNumber(promptBudget?.totalPromptEstimateBeforeTrim),
                    toolSchemaTokens: readNumber(promptBudget?.toolSchemaTokens),
                    toolResultTokens: readNumber(promptBudget?.toolResultTokens),
                    softContextTokens: readNumber(promptBudget?.softContextTokens),
                    historyTokens: readNumber(promptBudget?.historyTokens),
                    microcompactedToolResults: readNumber(promptBudget?.microcompactedToolResults),
                    microcompactionSavedTokens: readNumber(promptBudget?.microcompactionSavedTokens),
                  },
                }
              : {}),
          },
          note:
            `prompt=${promptTotal} (cached=${cachedTokens}) completion=${completionTotal} ` +
            `native=${nativeCost.toFixed(6)} platformPrice=${platformPrice.toFixed(6)} credits=${credits.toFixed(4)}`,
        });
      }

      return summary;
    } catch (error) {
      this.log.error({ err: error, sessionId }, 'Failed to record chat usage');
      throw error;
    }
  }

  recordTurnLatency(sessionId: string, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      return;
    }
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      return;
    }
    session.flags = session.flags ?? {};
    const aggregate =
      (session.flags[TURN_LATENCY_FLAG] as {
        totalMs?: number;
        samples?: number;
      }) ?? {};
    const totalMs = (aggregate.totalMs ?? 0) + latencyMs;
    const samples = (aggregate.samples ?? 0) + 1;
    session.flags[TURN_LATENCY_FLAG] = { totalMs, samples };
    this.sessionStore.set(sessionId, session);
  }

  private async appendCostLog(entry: {
    sessionId: string;
    turn?: number | null;
    promptTokens: number;
    cachedPromptTokens?: number;
    cacheWriteTokens?: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    overhead: number;
    platformCost: number;
    platformPrice: number;
    credits: number;
    currency?: string;
    model?: string;
  }): Promise<void> {
    const header = [
      '# Token & Cost Log',
      '',
      '| turn | timestamp | prompt_tokens | cached_prompt_tokens | cache_write_tokens | completion_tokens | total_tokens | native_cost | overhead | platform_cost | platform_price | credits | currency | model |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ].join('\n');
    const row = [
      entry.turn ?? '',
      new Date().toISOString(),
      entry.promptTokens,
      entry.cachedPromptTokens ?? 0,
      entry.cacheWriteTokens ?? 0,
      entry.completionTokens,
      entry.totalTokens,
      entry.cost.toFixed(6),
      entry.overhead.toFixed(6),
      entry.platformCost.toFixed(6),
      entry.platformPrice.toFixed(6),
      entry.credits.toFixed(4),
      entry.currency ?? 'usd',
      entry.model ?? '',
    ]
      .map((value) => `${value}`)
      .join(' | ');

    const payload = `| ${row} |\n`;

    if (this.tracesS3) {
      const key = `${entry.sessionId}/cost.md`;
      const buffer = Buffer.from(`${header}\n${payload}`, 'utf-8');
      await this.tracesS3.client.ensureBucket();
      await this.tracesS3.client.uploadBuffer(key, buffer, 'text/markdown');
      return;
    }

    const root = path.resolve(process.cwd(), this.traceRoot, entry.sessionId);
    await fs.mkdir(root, { recursive: true });
    const logPath = path.join(root, 'cost.md');
    try {
      await fs.access(logPath);
    } catch {
      await fs.writeFile(logPath, `${header}\n`, 'utf-8');
    }
    await fs.appendFile(logPath, payload, 'utf-8');
  }
}
