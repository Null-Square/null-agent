import { ERROR_CODES, type ModelCategory } from '@null-ai/contracts';
import type OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type {
  ModelConfig,
  ModelConfigPort,
  ModelRequestPort,
  ModelStreamRequest,
  ModelStreamResult,
} from '../../ports';
import {
  CONTEXTUAL_MODEL_REQUEST_SCHEMA_VERSION,
  MODEL_REQUEST_SCHEMA_VERSION,
  supportsAtomicModelRequests,
} from '../../ports';
import type { UsageRecorder, RecordedUsageSummary } from '../../infrastructure/usage/UsageRecorder';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry/SessionTraceRecorder';
import type { ModelExecutionPort, PreparedModelRequest } from '../../ports';
import { executionUnavailableReason } from '../../domain/runtime/ExecutionRuntimeRegistry';
import { CircuitOpenError, getLLMCircuitBreaker } from '../services/CircuitBreaker';
import { logger } from '@/shared/logger';
import {
  RuntimeHostCapabilityRegistrationError,
  type PersistenceCapability,
} from '../../domain/runtime/RuntimeHostCapabilities';
import {
  buildContextMeasurement,
  type ContextMeasurementHints,
} from '../../domain/context';
import type { CacheMode } from '../../domain/cache';
import { buildRuntimeCacheIdentity, cacheLineage } from './cacheLineageRegistry';

type AttemptError = Error & {
  retryable?: boolean;
  retryAfterMs?: number;
  modelAttemptStatus?: 'failed' | 'uncertain';
  modelOutputStarted?: boolean;
  providerRequestId?: string;
  modelRequestId?: string;
  code?: string;
};

const errorClassOf = (error: AttemptError): string => {
  if (typeof error.code === 'string' && error.code.trim()) return error.code;
  return error.name?.trim() || 'provider_error';
};

const isContextOverflow = (error: AttemptError): boolean =>
  error.code === ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED;

const reasoningAccounting = (result: ModelStreamResult): {
  reasoningTokens: number;
  reasoningSource: 'reported' | 'estimated' | 'unavailable';
} => {
  const stats = result.reasoningStats;
  if (!stats) return { reasoningTokens: 0, reasoningSource: 'unavailable' };
  if (stats.source === 'reported' && stats.tokens !== undefined) {
    return {
      reasoningTokens: Math.min(stats.tokens, result.usage?.completionTokens ?? stats.tokens),
      reasoningSource: 'reported',
    };
  }
  if (stats.source === 'estimated') {
    return {
      reasoningTokens: Math.min(
        stats.estimatedTokens,
        result.usage?.completionTokens ?? stats.estimatedTokens,
      ),
      reasoningSource: 'estimated',
    };
  }
  return { reasoningTokens: 0, reasoningSource: 'unavailable' };
};

export type ModelRuntimeExecuteInput = {
  model: ModelExecutionPort;
  usageRecorder: UsageRecorder;
  /**
   * D6 - the trace recorder for this turn. Provider attempt accounting writes through it, so
   * it must arrive with the request rather than being captured when the recorder was built.
   */
  traceRecorder?: SessionTraceRecorder;
  request: ModelStreamRequest;
  sessionId: string;
  turn: number;
  callOrdinal: number;
  configuredModelName: string;
  requestedCategory?: ModelCategory | null;
  routeReason?: string;
  maxRetries?: number;
  modelRequestPort?: ModelRequestPort;
  modelRequestCapability?: PersistenceCapability;
  runId?: string;
  stepId?: string;
  routedContextCapacity?: number;
  contextMeasurementHints?: ContextMeasurementHints;
  contextMeasurementRefs?: string[];
  transformationRefs?: string[];
  /**
   * E12: what this request intends to do with the session's warm prefix. An auxiliary call
   * that must not inherit the session declares `isolated`.
   */
  cacheMode?: CacheMode;
};

export type ModelRuntimeExecuteResult = {
  result: ModelStreamResult;
  usageSummary?: RecordedUsageSummary;
  attempts: number;
  requestId?: string;
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Can this model actually be served by the runtime this process booted on?
 *
 * This used to read `model.apiKey` directly, which answers a narrower question than it appears to:
 * "is there an API key in the database" is only the right test while an API is the thing that
 * answers. Unregistered, `executionUnavailableReason` applies the identical API rule, so fallback
 * candidate selection is unchanged (I13).
 */
const isConfiguredCandidate = (model: ModelConfig | null | undefined): boolean =>
  executionUnavailableReason(model) === null;

const readEnvelopeArray = <T>(envelope: Record<string, unknown>, key: string): T[] =>
  Array.isArray(envelope[key]) ? structuredClone(envelope[key] as T[]) : [];

const readGenerationSettings = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const settings: Record<string, unknown> = {};
  for (const key of [
    'max_tokens',
    'max_completion_tokens',
    'temperature',
    'top_p',
    'stop',
    'seed',
    'frequency_penalty',
    'presence_penalty',
    'response_format',
    'reasoning_effort',
  ]) {
    if (envelope[key] !== undefined) settings[key] = structuredClone(envelope[key]);
  }
  return settings;
};

const resolveRoutedContextCapacity = (input: ModelRuntimeExecuteInput): number => {
  const configuredCapacity = input.routedContextCapacity;
  if (
    typeof configuredCapacity === 'number'
    && Number.isFinite(configuredCapacity)
    && configuredCapacity > 0
  ) {
    return Math.floor(configuredCapacity);
  }
  return input.model.getContextCapacity();
};

/**
 * The only owner of remote model retries and durable provider-attempt billing.
 * A ModelStream performs exactly one remote request; this runtime gives every
 * retry its own frozen quote and ledger row before dispatch.
 */
export class ModelRuntime {
  private readonly log = logger.child({ scope: 'ModelRuntime' });

  async resolveSessionModel(input: {
    modelConfigPort?: ModelConfigPort;
    requestedModelId?: string;
    requestedCategory?: ModelCategory;
    allowedCategories?: ModelCategory[] | null;
  }): Promise<ModelConfig | null | undefined> {
    const port = input.modelConfigPort;
    if (!port) return undefined;
    if (input.requestedModelId) return port.getModel(input.requestedModelId);
    if (input.requestedCategory) {
      if (input.allowedCategories?.length && !input.allowedCategories.includes(input.requestedCategory)) {
        return null;
      }
      return (await port.listModelsForCategory(input.requestedCategory)).find(isConfiguredCandidate) ?? null;
    }

    const defaultModel = await port.getDefaultModel();
    const allowed = input.allowedCategories;
    if (!allowed) {
      if (isConfiguredCandidate(defaultModel)) return defaultModel;
      if (defaultModel?.selectionCategory) {
        return (await port.listModelsForCategory(defaultModel.selectionCategory))
          .find(isConfiguredCandidate) ?? null;
      }
      return defaultModel;
    }
    // An empty allowlist is handled by the subscription gate so it can return
    // the product entitlement error instead of a misleading model-config error.
    if (allowed.length === 0) return defaultModel;
    if (
      isConfiguredCandidate(defaultModel) &&
      defaultModel?.selectionCategory &&
      allowed.includes(defaultModel.selectionCategory)
    ) {
      return defaultModel;
    }
    for (const category of allowed) {
      const candidate = (await port.listModelsForCategory(category)).find(isConfiguredCandidate);
      if (candidate) return candidate;
    }
    return null;
  }

  async execute(input: ModelRuntimeExecuteInput): Promise<ModelRuntimeExecuteResult> {
    const maxRetries = Math.max(0, input.maxRetries ?? 3);
    const routeReason = input.routeReason ?? 'session_pinned';
    const logicalCallKey = `${input.sessionId}:${input.turn}:${routeReason}:${input.callOrdinal}`;
    // Turn identity is lifecycle metadata at the model port. API adapters ignore it. An external
    // agent runtime needs it to avoid resuming a suspended provider turn after the host has already
    // advanced to a new turn (for example, after a terminal planning or phase-handoff tool).
    const request: ModelStreamRequest = input.request.turnNumber === input.turn
      ? input.request
      : { ...input.request, turnNumber: input.turn };
    const circuit = getLLMCircuitBreaker(input.model.providerName);
    let lastError: Error | undefined;
    const requiresAtomicRequest = (input.modelRequestCapability?.schemaVersion ?? 1) >= 2;
    const requiresContextMeasurement =
      (input.modelRequestCapability?.schemaVersion ?? 1) >= CONTEXTUAL_MODEL_REQUEST_SCHEMA_VERSION;
    let preparedRequest: PreparedModelRequest | undefined;
    let requestId: string | undefined;

    if (requiresAtomicRequest) {
      if (!supportsAtomicModelRequests(input.modelRequestPort)) {
        throw new RuntimeHostCapabilityRegistrationError([
          `lifecycle=modelRequests schemaVersion=${input.modelRequestCapability?.schemaVersion ?? 'missing'} adapter=missing_v2_contract`,
        ]);
      }
      preparedRequest = input.model.prepare(request);
      requestId = uuidv4();
      const envelope = preparedRequest.envelope;
      const routedContextCapacity = resolveRoutedContextCapacity(input);
      const measurement = requiresContextMeasurement
        ? buildContextMeasurement({
            measurementId: uuidv4(),
            requestId,
            sessionId: input.sessionId,
            runId: input.runId,
            stepId: input.stepId,
            turn: input.turn,
            callOrdinal: input.callOrdinal,
            provider: input.model.providerName,
            model: input.configuredModelName,
            routedCapacity: routedContextCapacity,
            capacitySource: input.contextMeasurementHints?.capacitySource
              ?? (input.routedContextCapacity ? 'model_config' : 'provider_capability_fallback'),
            reducerProfile: input.contextMeasurementHints?.reducerProfile,
            reducerReason: input.contextMeasurementHints?.reducerReason,
            transformationId: input.contextMeasurementHints?.transformationId,
            envelope,
          })
        : undefined;
      const messages = readEnvelopeArray<OpenAI.Chat.ChatCompletionMessageParam>(envelope, 'messages');
      const tools = readEnvelopeArray<OpenAI.Chat.Completions.ChatCompletionTool>(envelope, 'tools');
      const persisted = await input.modelRequestPort.append({
        requestId,
        schemaVersion: measurement
          ? CONTEXTUAL_MODEL_REQUEST_SCHEMA_VERSION
          : MODEL_REQUEST_SCHEMA_VERSION,
        sessionId: input.sessionId,
        runId: input.runId,
        stepId: input.stepId,
        turn: input.turn,
        callOrdinal: input.callOrdinal,
        routeReason,
        provider: input.model.providerName,
        model: input.configuredModelName,
        routedContextCapacity,
        messages,
        systemContent: messages
          .filter((message) => message.role === 'system')
          .map((message) => structuredClone(message.content)),
        tools,
        toolChoice: envelope.tool_choice === undefined
          ? undefined
          : structuredClone(envelope.tool_choice),
        generationSettings: readGenerationSettings(envelope),
        contextMeasurementRefs: [
          ...(measurement ? [measurement.measurementId] : []),
          ...(input.contextMeasurementRefs ?? []),
        ],
        transformationRefs: [...(input.transformationRefs ?? [])],
        contextMeasurement: measurement,
        envelope: structuredClone(envelope),
        digest: preparedRequest.digest,
      });
      if (persisted.digest !== preparedRequest.digest) {
        throw new Error(
          `model_request_persistence_digest_mismatch: requestId=${requestId} expected=${preparedRequest.digest} actual=${persisted.digest}`,
        );
      }

      // E12 Slice A: observe-only. The record is durable and the digest is verified, so the
      // projection describes exactly what is about to be dispatched. A failure here must
      // never block a model call.
      try {
        const projection = input.model.projectCacheSurface(
          envelope,
          buildRuntimeCacheIdentity({
            provider: input.model.providerName,
            model: input.configuredModelName,
          }),
        );
        if (projection) {
          cacheLineage.track(input.sessionId);
          const expectation = cacheLineage.observe().recordExpectation({
            sessionId: input.sessionId,
            requestId,
            branch: routeReason === 'session_pinned' ? 'main' : 'auxiliary',
            cacheMode: input.cacheMode ?? { kind: 'reuse_ancestor', ancestorRequestId: 'session' },
            projection,
            declaredTransformationIds: [...(input.transformationRefs ?? [])],
          });

          // D8 - the lineage observer's logic was sound and its output went to `log.debug`
          // and an in-memory map, so all five session traces from run r1 contained zero
          // lineage events and no production question about the cache could be answered.
          // The expectation belongs beside the E4 request record it describes.
          if (input.traceRecorder) {
            await input.traceRecorder.write(input.sessionId, input.turn ?? 0, {
              event: 'cache.lineage_expectation',
              severity: 'info',
              payload: {
                requestId,
                branch: expectation.branch,
                structuralRelation: expectation.structuralRelation,
                cacheAncestorRequestId: expectation.cacheAncestorRequestId,
                lineageRootId: expectation.lineageRootId,
                estimatedReusableTokens: expectation.estimatedReusableTokens,
                estimatedTotalTokens: expectation.estimatedTotalTokens,
                firstChangedSegmentIndex: expectation.firstChangedSegmentIndex,
                firstDivergence: expectation.firstDivergence ?? null,
                undeclaredEarlierDivergence: expectation.undeclaredEarlierDivergence ?? false,
                declaredTransformationIds: [...(input.transformationRefs ?? [])],
              },
              note: `cache lineage ${expectation.structuralRelation} against `
                + `${expectation.cacheAncestorRequestId ?? 'no ancestor'}`,
            });
          }
        }
      } catch (error) {
        this.log.warn({ err: error, requestId }, 'Cache lineage expectation not recorded');
      }
    }

    for (let attemptOrdinal = 1; attemptOrdinal <= maxRetries + 1; attemptOrdinal += 1) {
      if (input.request.signal.aborted) throw lastError ?? new Error('Aborted');
      const circuitState = circuit.getState().toLowerCase() as 'closed' | 'open' | 'half_open';
      const circuitAllowed = circuit.canExecute();

      const attempt = await input.usageRecorder.beginAttempt(input.sessionId, {
        turn: input.turn,
        logicalCallKey,
        modelRequestId: requestId ?? null,
        schemaVersion: requestId ? 2 : 1,
        attemptOrdinal,
        callOrdinal: input.callOrdinal,
        provider: input.model.providerName,
        modelName: input.configuredModelName,
        // Which process carried the request, kept apart from provider identity (§4.3). The
        // recorder decides the accounting mode from the runtime; this only names the backend.
        executionBackend: input.model.providerName,
        requestedCategory: input.requestedCategory ?? null,
        routeReason,
        fallbackOrdinal: 0,
        requestStartedAt: new Date(),
        circuitState,
        circuitDecision: circuitAllowed ? 'allow' : 'reject',
        estimatedInputTokens: input.request.messages.reduce((total, message) => {
          const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
          return total + Math.ceil(content.length / 4);
        }, 0) + Math.ceil(JSON.stringify(input.request.tools).length / 4),
        maxOutputTokens: input.request.maxTokens,
      }, input.traceRecorder);

      if (!circuitAllowed) {
        const circuitError = new CircuitOpenError(
          `llm:${input.model.providerName}`,
          circuit.getRetryAfterMs(),
        ) as AttemptError;
        circuitError.code = 'llm.circuit_open';
        if (requestId) circuitError.modelRequestId = requestId;
        await input.usageRecorder.failAttempt({
          attemptId: attempt.id,
          status: 'failed',
          requestCompletedAt: new Date(),
          errorClass: circuitError.code,
          retryDecision: 'stop',
        });
        throw circuitError;
      }

      let cancellationPromise: Promise<void> | undefined;
      const persistCancellation = (): Promise<void> => {
        cancellationPromise ??= input.usageRecorder.failAttempt({
          attemptId: attempt.id,
          status: 'cancelled',
          requestCompletedAt: new Date(),
          errorClass: 'request_cancelled',
          retryDecision: 'stop',
        });
        return cancellationPromise;
      };
      const onAbort = (): void => {
        void persistCancellation().catch((error) => {
          this.log.error({ err: error, attemptId: attempt.id }, 'Failed to persist provider-attempt cancellation');
        });
      };
      input.request.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const result = preparedRequest
          ? await input.model.startPrepared(preparedRequest)
          : await input.model.start(request);
        if (input.request.signal.aborted) {
          await persistCancellation();
          throw Object.assign(new Error('Provider result arrived after cancellation'), {
            code: 'request_cancelled',
            retryable: false,
            modelAttemptStatus: 'failed' as const,
          });
        }
        circuit.recordSuccess();

        // E12 Slice A: join the provider's reported cache usage to this attempt. Missing
        // telemetry stays missing here; it must never become a zero-token miss downstream.
        if (requestId) {
          try {
            const cachedTokens = result.usage?.promptTokensDetails?.cachedTokens;
            const assessment = cacheLineage.observe().recordObservation({
              sessionId: input.sessionId,
              requestId,
              attemptId: attempt.id,
              attemptOrdinal,
              telemetryState: typeof cachedTokens === 'number' ? 'reported' : 'not_reported',
              ...(typeof cachedTokens === 'number' ? { cacheReadTokens: cachedTokens } : {}),
              ...(typeof result.usage?.promptTokens === 'number' && typeof cachedTokens === 'number'
                ? { uncachedInputTokens: Math.max(0, result.usage.promptTokens - cachedTokens) }
                : {}),
              providerRequestId: result.providerRequestId ?? null,
            });

            // D8 - and the observation belongs beside the E7 attempt it settles, so a run can
            // be asked afterwards what the cache actually did.
            if (input.traceRecorder && assessment) {
              await input.traceRecorder.write(input.sessionId, input.turn ?? 0, {
                event: 'cache.lineage_observed',
                severity: 'info',
                payload: {
                  requestId,
                  attemptId: attempt.id,
                  attemptOrdinal,
                  outcome: assessment.outcome,
                  structuralRelation: assessment.structuralRelation,
                  telemetryState: cachedTokens === undefined ? 'not_reported' : 'reported',
                  estimatedReusableTokens: assessment.estimatedReusableTokens,
                  actualCacheReadTokens: assessment.actualCacheReadTokens ?? null,
                  shortfallTokens: assessment.shortfallTokens ?? null,
                },
                note: `cache lineage ${assessment.outcome}`,
              });
            }
          } catch (error) {
            this.log.warn({ err: error, requestId }, 'Cache lineage observation not recorded');
          }
        }

        if (result.reportedModel && result.reportedModel !== input.configuredModelName) {
          this.log.warn({
            sessionId: input.sessionId,
            logicalCallKey,
            configuredModel: input.configuredModelName,
            reportedModel: result.reportedModel,
            providerRequestId: result.providerRequestId,
          }, 'Provider reported a different model; the frozen configured-model quote remains authoritative');
        }
        if (!result.usage) {
          const reasoning = reasoningAccounting(result);
          try {
            await input.usageRecorder.failAttempt({
              attemptId: attempt.id,
              status: 'uncertain',
              requestCompletedAt: new Date(),
              providerRequestId: result.providerRequestId,
              reportedModel: result.reportedModel,
              errorClass: 'provider_usage_missing',
              retryDecision: 'stop',
              ...reasoning,
            });
          } catch (error) {
            this.log.error({ err: error, attemptId: attempt.id }, 'Failed to mark missing-usage attempt uncertain');
          }
          return { result, attempts: attemptOrdinal, requestId };
        }

        let usageSummary: RecordedUsageSummary | undefined;
        const reasoning = reasoningAccounting(result);
        for (let finalizationAttempt = 1; finalizationAttempt <= 3; finalizationAttempt += 1) {
          try {
            usageSummary = await input.usageRecorder.recordUsage(input.sessionId, result.usage, {
              turn: input.turn,
              attemptId: attempt.id,
              providerRequestId: result.providerRequestId,
              reportedModel: result.reportedModel,
              ...reasoning,
            });
            break;
          } catch (error) {
            const exhausted = finalizationAttempt === 3;
            this.log[exhausted ? 'error' : 'warn'](
              { err: error, attemptId: attempt.id, finalizationAttempt },
              exhausted
                ? 'Provider result preserved while usage finalization remains pending'
                : 'Retrying usage finalization without repeating the provider call',
            );
            if (!exhausted) {
              await new Promise((resolve) => setTimeout(resolve, finalizationAttempt * 50));
            }
          }
        }
        if (!usageSummary) {
          try {
            await input.usageRecorder.failAttempt({
              attemptId: attempt.id,
              status: 'uncertain',
              requestCompletedAt: new Date(),
              providerRequestId: result.providerRequestId,
              reportedModel: result.reportedModel,
              errorClass: 'usage_finalization_pending',
              retryDecision: 'stop',
              ...reasoning,
            });
          } catch (error) {
            this.log.error(
              { err: error, attemptId: attempt.id },
              'Failed to mark pending usage finalization uncertain',
            );
          }
        }
        return { result, usageSummary, attempts: attemptOrdinal, requestId };
      } catch (error: unknown) {
        const attemptError = (error instanceof Error ? error : new Error(String(error))) as AttemptError;
        if (requestId) attemptError.modelRequestId = requestId;
        lastError = attemptError;
        const cancelled = input.request.signal.aborted || attemptError.code === 'request_cancelled';
        // Deterministic request/account outcomes are not service-health failures. Counting content
        // refusals, exhausted subscription quotas, invalid models, or authentication errors opened
        // the shared runtime circuit and made unrelated sessions fail fast as if the provider were
        // down. Unknown errors still count fail-closed; canonical non-retryable errors do not.
        if (!cancelled && attemptError.retryable !== false) circuit.recordFailure();
        const overflowRecovery = isContextOverflow(attemptError);
        const canRetry =
          !cancelled &&
          !overflowRecovery &&
          attemptOrdinal <= maxRetries &&
          attemptError.retryable === true &&
          attemptError.modelOutputStarted !== true;
        const delayMs = canRetry
          ? Math.min(
              attemptError.retryAfterMs ?? 1000 * Math.pow(2, attemptOrdinal - 1),
              8000,
            )
          : undefined;
        try {
          if (cancelled) {
            await persistCancellation();
          } else {
            await input.usageRecorder.failAttempt({
              attemptId: attempt.id,
              status: attemptError.modelAttemptStatus ?? 'uncertain',
              requestCompletedAt: new Date(),
              providerRequestId: attemptError.providerRequestId,
              errorClass: errorClassOf(attemptError),
              retryDecision: overflowRecovery
                ? 'overflow_recovery'
                : canRetry
                  ? 'retry'
                  : 'stop',
              backoffMs: delayMs,
              reasoningTokens: 0,
              reasoningSource: 'unavailable',
            });
          }
        } catch (finalizationError) {
          this.log.error(
            { err: finalizationError, attemptId: attempt.id },
            'Provider failure preserved while attempt finalization remains pending',
          );
          throw attemptError;
        }

        if (!canRetry) throw attemptError;

        this.log.warn({
          sessionId: input.sessionId,
          logicalCallKey,
          attemptOrdinal,
          delayMs,
          provider: input.model.providerName,
          status: attemptError.modelAttemptStatus,
        }, 'Retrying provider call with a new durable attempt');
        await waitForRetry(delayMs ?? 0, input.request.signal);
      } finally {
        input.request.signal.removeEventListener('abort', onAbort);
      }
    }

    throw lastError ?? new Error('Model runtime exhausted attempts');
  }
}
