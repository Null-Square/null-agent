import type OpenAI from 'openai';
import type { TurnRunArgs, TurnRunResult, TurnRunStatus, TurnRunnerDeps } from '../types';
import { TurnStreamController } from './TurnStreamController';
import type { ModelStream } from '../streaming/ModelStream';
import type { AuxiliaryModelCallInput } from '../../../ports';
import { ModelRuntime } from '../ModelRuntime';
import { TurnToolExecutor, type TurnToolExecutorResult } from './TurnToolExecutor';
import { TurnMetricsAccumulator } from './TurnMetricsAccumulator';
import {
  buildTerminalObligationNudge,
  countPendingPlanSteps,
  countPlanSteps,
  decideObligationYield,
  findTerminalObligation,
} from './terminalObligations';
import { shouldRequireReportForSession } from '../../../domain/workers/workerContracts';
import {
  buildPrematureStopCorrectiveMessage,
  checkContinuation as checkContinuationGuard,
  emitToolInvocationRollup,
  getActivePhaseKey,
  markDiminishingReturns as markDiminishingReturnsResult,
  markRecoverableGuard as markRecoverableGuardResult,
  createExitCheckpoint,
  reconcilePlanForExit as reconcilePlanForExitGuard,
  type ReconcilePlanForExitReason,
  type ExitCheckpointReason,
} from './TurnLoopGuards';
import {
  compactSameTurnMessages,
  readPrefixCacheState,
  resolveSameTurnCompactionOptionsFromEnv,
} from './SameTurnCompactor';
import { UsageRecorder } from '../../../infrastructure/usage/UsageRecorder';
import { logger } from '@/shared/logger';
import { recordTurnCommit } from '@/shared/metrics/prometheusMetrics';
import type { Message, SessionState } from '../../../domain/types';
import { PlanRuntime } from '../../tools/runtime/PlanRuntime';
import type { StreamEvent } from '../../../domain/types';
import { awaitUser, stopProcessing } from '../utils/sessionProcessing';
import { deriveSessionStatusForEvent, emitSessionStatusEvent } from '../utils/sessionStatusEvents';
import {
  resolveRootReportingReserveToolCalls,
  resolveWorkerMaxToolCalls,
} from '../../../domain/workers/workerContracts';
import { EMPTY_COMPLETION_RETRY_MESSAGE } from '../../../domain/prompts';
import type { ToolProgressKind } from '../../tools/runtime/Tool';
import {
  createActionSummaryEvent,
  createDiscoveryEvent,
  createMemoryUpdateEvent,
  createMilestoneEvent,
  type MilestonePhase,
  type MilestonePayload as _MilestonePayload,
} from '../../../infrastructure/telemetry/types';
import { checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import {
  getHostedRunModelRequestLifecycle,
  getHostedRunRuntimeCapabilities,
} from '@/domains/security-ops/runs/HostedRunPersistencePort';
import { buildContextMeasurement } from '../../../domain/context';
export type { TurnRunStatus } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const resolveMilestonePhase = (session: SessionState | undefined, fallback: MilestonePhase): MilestonePhase => {
  const activePhaseKey = getActivePhaseKey(session);
  switch (activePhaseKey) {
    case 'recon':
      return 'recon';
    case 'enumeration':
      return 'enumeration';
    case 'validation':
      return 'validation';
    case 'evidence':
      return 'evidence';
    case 'reporting':
      return 'reporting';
    default:
      return fallback;
  }
};

const EMPTY_COMPLETION_RETRY_LIMIT = 2;
const MERMAID_VALIDATION_RETRY_LIMIT = 3;
const DIMINISHING_RETURNS_CONTINUATION_THRESHOLD = 3;
const DIMINISHING_RETURNS_COMPLETION_TOKEN_THRESHOLD = 500;
const DIMINISHING_RETURNS_MIN_TOOL_CALLS = 12;

const TURN_HEARTBEAT_INTERVAL_MS = 5_000;

// Same-turn finish correction: retry when model stops without calling any tools
const PREMATURE_STOP_RETRY_LIMIT = 1;

const hasSecurityOpsCloseoutArtifacts = (session: SessionState | undefined): boolean => {
  const securityops = isRecord(session?.flags?.securityops)
    ? session.flags.securityops
    : undefined;
  return typeof securityops?.artifactsFinalizedAt === 'string';
};

const getRepeatedLifecycleGate = (
  session: SessionState | undefined,
): { code?: string; count: number } | undefined => {
  const failures = isRecord(session?.flags?.lifecycleGateFailures)
    ? session.flags.lifecycleGateFailures
    : undefined;
  const phaseHandoff = isRecord(failures?.phaseHandoff) ? failures.phaseHandoff : undefined;
  if (!phaseHandoff) {
    return undefined;
  }
  const count = typeof phaseHandoff.count === 'number' && Number.isFinite(phaseHandoff.count)
    ? phaseHandoff.count
    : 0;
  const code = typeof phaseHandoff.code === 'string' ? phaseHandoff.code : undefined;
  return count > 0 ? { code, count } : undefined;
};

const getDiminishingReturnsRepairTurn = (session: SessionState | undefined): number | undefined => {
  const state = isRecord(session?.flags?.diminishingReturns) ? session.flags.diminishingReturns : undefined;
  const repairTurn = state?.repairTurn;
  return typeof repairTurn === 'number' && Number.isFinite(repairTurn)
    ? repairTurn
    : undefined;
};

type ToolProgressKindResolver = (toolName: string) => ToolProgressKind | undefined;

const actionSummaryIsProgress = (
  summary: TurnToolExecutorResult['actionSummaries'][number],
  resolveToolProgressKind?: ToolProgressKindResolver,
): boolean => {
  if (typeof summary.finding === 'string' && summary.finding.trim().length > 0) {
    return true;
  }
  // D2: progress is about whether the tool ran, not about what the target answered. A probe
  // that returns 401 has enforced-auth evidence; one that returns 404 has falsified an
  // exposure hypothesis. Both are progress, and both used to be read as failures here.
  if (summary.execution !== 'succeeded') {
    return false;
  }
  return resolveToolProgressKind?.(summary.tool) !== undefined;
};

const toolExecutionProducedProgress = (
  toolExecResult: TurnToolExecutorResult,
  resolveToolProgressKind?: ToolProgressKindResolver,
): boolean =>
  toolExecResult.discoveries.length > 0 ||
  toolExecResult.memoryUpdates.length > 0 ||
  toolExecResult.actionSummaries.some((summary) => actionSummaryIsProgress(summary, resolveToolProgressKind));

/**
 * TurnRunner orchestrates a single turn using modular components.
 */
/**
 * How many future requests a same-turn rewrite may assume it will be amortized over.
 *
 * Small on purpose: the arithmetic decides whether to destroy a cached prefix, and a forecast
 * further out than this has no evidence behind it.
 */
const CONSERVATIVE_AMORTIZATION_REQUESTS = 2;

export class TurnRunner {
  private readonly maxToolCalls: number;
  private readonly streamController: TurnStreamController;
  private readonly toolExecutor: TurnToolExecutor;
  private readonly usageRecorder: UsageRecorder;
  private readonly modelRuntime = new ModelRuntime();
  private readonly auxiliaryCallOrdinals = new Map<string, number>();
  private readonly log = logger.child({ scope: 'TurnRunner' });
  private modelName: string;
  private model: ModelStream | null;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.maxToolCalls = deps.maxToolCalls;
    this.modelName = deps.modelName;
    this.model = deps.model;
    this.usageRecorder = new UsageRecorder(
      deps.sessionStore,
      deps.usageTracker,
      deps.usageStore,
      deps.modelName,
      deps.tokenGuard,
      deps.tracesS3,
      undefined,
      deps.traceRoot,
    );
    this.streamController = new TurnStreamController({
      model: deps.model,
      sessionStore: deps.sessionStore,
      usageRecorder: this.usageRecorder,
      modelRuntime: this.modelRuntime,
      resolveModelRequestPersistence: (sessionId) =>
        this.resolveModelRequestPersistence(sessionId),
    });
    this.toolExecutor = new TurnToolExecutor({
      sessionStore: deps.sessionStore,
      toolsRegistry: deps.toolsRegistry,
      checkpointManager: deps.checkpointManager,
      checkpointIntervalToolCalls: deps.checkpointIntervalToolCalls,
      workContinuationGuard: deps.workContinuationGuard,
      executeModelCall: (input) => this.executeModelCall(input),
    });
  }

  setModelName(modelName?: string): void {
    if (modelName) {
      this.modelName = modelName;
      this.usageRecorder.setModelName(modelName);
    }
  }

  /** Set the model stream (for lazy initialization) */
  setModel(model: ModelStream): void {
    this.model = model;
    this.streamController.setModel(model);
  }

  async executeModelCall(input: AuxiliaryModelCallInput) {
    if (!this.model) throw new Error('ModelStream not set for auxiliary model call');
    const ordinalKey = `${input.sessionId}:${input.turnNumber}:${input.routeReason}`;
    const callOrdinal = (this.auxiliaryCallOrdinals.get(ordinalKey) ?? 0) + 1;
    this.auxiliaryCallOrdinals.set(ordinalKey, callOrdinal);
    this.model.setModelName(this.modelName);
    this.usageRecorder.setModelName(this.modelName);
    const requestPersistence = this.resolveModelRequestPersistence(input.sessionId);
    const executed = await this.modelRuntime.execute({
      model: this.model,
      usageRecorder: this.usageRecorder,
      sessionId: input.sessionId,
      turn: input.turnNumber,
      callOrdinal,
      configuredModelName: this.modelName,
      routeReason: input.routeReason,
      // E12: a cache-affine auxiliary declares which prefix it intends to extend. An
      // undeclared auxiliary is treated as isolated so it never claims a warm ancestor.
      cacheMode: input.cacheMode?.kind === 'reuse_ancestor'
        ? { kind: 'reuse_ancestor', ancestorRequestId: 'session' }
        : { kind: 'isolated', reason: input.cacheMode?.reason ?? `auxiliary:${input.routeReason}` },
      modelRequestPort: requestPersistence.port,
      modelRequestCapability: requestPersistence.capability,
      runId: requestPersistence.runId,
      stepId: requestPersistence.stepId,
      routedContextCapacity: requestPersistence.routedContextCapacity,
      transformationRefs: [`auxiliary:${input.routeReason}`],
      contextMeasurementHints: {
        capacitySource: requestPersistence.routedContextCapacity
          ? 'model_config'
          : 'provider_capability_fallback',
        reducerProfile: 'auxiliary',
        reducerReason: input.routeReason,
      },
      request: {
        sessionId: input.sessionId,
        agentType: this.deps.sessionStore.get(input.sessionId)?.agentType,
        messages: input.messages,
        tools: input.tools ?? [],
        signal: input.signal,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
      },
    });
    return executed.result;
  }

  private resolveModelRequestPersistence(sessionId: string) {
    const session = this.deps.sessionStore.get(sessionId);
    const securityops = isRecord(session?.flags?.securityops)
      ? session.flags.securityops
      : undefined;
    const runHost = typeof securityops?.runHost === 'string' ? securityops.runHost : undefined;
    const runId = typeof securityops?.runId === 'string' ? securityops.runId : undefined;
    const hostedCapabilities = getHostedRunRuntimeCapabilities({ runHost, runId });
    const hostedPort = getHostedRunModelRequestLifecycle({ runHost, runId });
    return {
      port: hostedPort ?? this.deps.modelRequestPort,
      capability: hostedCapabilities?.modelRequests
        ?? this.deps.runtimeHostCapabilities?.modelRequests,
      runId,
      stepId: session?.currentPlanStepId,
      routedContextCapacity: session?.modelContextWindow,
    };
  }

  async runTurn(args: TurnRunArgs): Promise<TurnRunResult> {
    const turnStarted = Date.now();
    const { sessionId, turnNumber, abortSignal } = args;
    let lastHeartbeatAt = 0;
    const heartbeat = async (force = false): Promise<void> => {
      if (!this.deps.sessionRepository?.touchLastActive) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastHeartbeatAt < TURN_HEARTBEAT_INTERVAL_MS) {
        return;
      }
      lastHeartbeatAt = now;
      try {
        await this.deps.sessionRepository.touchLastActive(sessionId, new Date(now));
      } catch (error) {
        this.log.warn({ err: error, sessionId, turnNumber }, '[TurnRunner] Failed to persist active-turn heartbeat');
      }
    };

    // Increase max listeners to prevent warning during long tool chains (64+ tools)
    // Each tool execution may add a listener for abort handling
    try {
       
      const events = require('events') as { setMaxListeners?: (n: number, ...eventTargets: EventTarget[]) => void };
      if (events.setMaxListeners && abortSignal) {
        events.setMaxListeners(100, abortSignal);
      }
    } catch {
      // Ignore if setMaxListeners not available (older Node versions)
    }

    try {
      await heartbeat(true);
      return await this.runTurnInternal({
        ...args,
        abortSignal,
        heartbeat,
      });
    } finally {
      // CRITICAL: Persist session metadata (including usage) to DB after each turn
      // This ensures data survives backend restarts and prevents N/A values in frontend
      const sessionToPersist = this.deps.sessionStore.get(sessionId);
      if (sessionToPersist) {
        this.deps.sessionStore.queuePersistMetadata(sessionToPersist);
        this.log.debug({ sessionId, turnNumber }, '[TurnRunner] Queued metadata persistence');
      }

      const durationMs = Date.now() - turnStarted;
      this.log.info({ sessionId, turnNumber, durationMs }, '[TurnRunner] Turn completed');
    }
  }

  private async runTurnInternal(args: TurnRunArgs): Promise<TurnRunResult> {
    const turnStarted = Date.now();
    const {
      sessionId,
      turnNumber,
      abortSignal,
      systemMessages,
      historyMessages,
      toolDefinitions,
      contextMeasurementHints,
      transformationRefs,
      stream,
      recorder,
      modelName,
    } = args;
    const resolveToolProgressKind: ToolProgressKindResolver = (toolName) =>
      this.deps.toolsRegistry.getToolProgressKind?.(toolName);

    let toolCallCount = 0;
    let requestedToolCallCount = 0;
    let modelCallCount = 0;
    let emptyCompletionRetryCount = 0;
    let prematureStopRetryCount = 0;
    let mermaidValidationRetryCount = 0;
    const doneEmitted = false;
    const effectiveMaxToolCalls = resolveWorkerMaxToolCalls(
      this.deps.sessionStore.get(sessionId),
      args.maxToolCalls ?? this.maxToolCalls,
    );
    const reportingReserveToolCalls = resolveRootReportingReserveToolCalls(
      this.deps.sessionStore.get(sessionId),
      effectiveMaxToolCalls,
    );
    let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [...systemMessages, ...historyMessages];
    const planStreamBroker = {
      emit: (_targetSessionId: string, event: StreamEvent) => {
        stream.raw(event.type, 'data' in event ? event.data : undefined);
      },
    };
    const planRuntime = new PlanRuntime({
      sessionStore: this.deps.sessionStore,
      streamBroker: planStreamBroker,
      traceRecorder: recorder,
    });

    // Create metrics accumulator for wide turn events
    const metricsAccumulator = new TurnMetricsAccumulator();
    const sameTurnCompactionOptions = resolveSameTurnCompactionOptionsFromEnv();
    let previousCompletionTokens: number | undefined;
    let lowYieldContinuationCount = 0;
    // D11/D12 - the model call at which an outstanding terminal obligation was first seen,
    // so the grace it is given is bounded and a phase that cannot close still ends.
    let obligationFirstSeenAtModelCall = Number.MAX_SAFE_INTEGER;

    const emitTurnToolInvocationRollup = async (status: TurnRunStatus): Promise<void> => {
      const session = this.deps.sessionStore.get(sessionId);
      const metrics = metricsAccumulator.toPayload();
      const phase = resolveMilestonePhase(session, 'execution');
      const activePhaseKey = getActivePhaseKey(session);
      await emitToolInvocationRollup({
        recorder,
        sessionId,
        turnNumber,
        status,
        phase,
        activePhaseKey,
        requestedToolCallCount,
        metrics,
      });
    };

    // Emit milestone event at turn start (Trace Observability v2)
    if (recorder && turnNumber === 1) {
      const milestoneSession = this.deps.sessionStore.get(sessionId);
      await recorder.write(sessionId, turnNumber, createMilestoneEvent({
        phase: resolveMilestonePhase(milestoneSession, 'execution'),
        status: 'started',
        summary: 'Beginning session execution',
      }));
    }

    const summarize = (status: TurnRunStatus, extra: Record<string, unknown> = {}, countOverride?: number) => {
      const durationMs = Date.now() - turnStarted;
      const count = typeof countOverride === 'number' ? countOverride : toolCallCount;
      
      // Record to Prometheus histogram for proper p50/p95/p99 calculation
      const success = status === 'completed' || status === 'max_tool_calls';
      recordTurnCommit(durationMs, success);
      
      this.log.info(
        {
          sessionId,
          turnNumber,
          status,
          toolCallCount: count,
          durationMs,
          modelName: modelName ?? this.modelName,
          ...extra,
        },
        '[TurnRunner] turn summary',
      );
    };

    const createTurnExitCheckpoint = async (
      reason: ExitCheckpointReason,
      executedToolCalls: number,
    ): Promise<string | undefined> => {
      return createExitCheckpoint({
        sessionStore: this.deps.sessionStore,
        checkpointManager: this.deps.checkpointManager,
        stream,
        log: this.log,
        sessionId,
        reason,
        executedToolCalls,
      });
    };

    const reconcilePlanForExit = async (
      reason: ReconcilePlanForExitReason,
      options: { blockPending?: boolean; checkpointId?: string } = {},
    ): Promise<void> => {
      await reconcilePlanForExitGuard({
        planRuntime,
        sessionId,
        reason,
        blockPending: options.blockPending,
        checkpointId: options.checkpointId,
      });
    };

    const markRecoverableGuard = async (
      extra: Record<string, unknown> = {},
      usage?: TurnRunResult['usage'],
    ) => {
      return markRecoverableGuardResult({
        sessionStore: this.deps.sessionStore,
        recorder,
        sessionId,
        turnNumber,
        extra,
        usage,
        metrics: metricsAccumulator.toPayload(),
        toolCallCount,
        requestedToolCallCount,
        emitTurnToolInvocationRollup,
        summarize,
      });
    };
    const checkContinuation = async (boundary: 'model_call' | 'tool_call') => {
      return checkContinuationGuard({
        workContinuationGuard: this.deps.workContinuationGuard,
        recorder,
        log: this.log,
        sessionId,
        turnNumber,
        boundary,
        abortSignal,
      });
    };

    const markDiminishingReturns = async (
      details: Record<string, unknown>,
      usage?: TurnRunResult['usage'],
    ) => {
      return markDiminishingReturnsResult({
        sessionStore: this.deps.sessionStore,
        recorder,
        sessionId,
        turnNumber,
        details,
        usage,
        metrics: metricsAccumulator.toPayload(),
        toolCallCount,
        requestedToolCallCount,
        emitTurnToolInvocationRollup,
        summarize,
      });
    };

    while (toolCallCount < effectiveMaxToolCalls) {
      // ========================================================================
      // Check for abort requests: React to abort signal OR isProcessing=false
      // isProcessing can be set to false by:
      // - /abort endpoint (immediate stop)
      // - Stop endpoint (durable Stop intent plus graceful interruption)
      // ========================================================================
      const currentSession = this.deps.sessionStore.get(sessionId);
      // Use stateMachine as source of truth when available for automated sessions.
      // Otherwise fall back to legacy isProcessing field
      const isCurrentlyProcessing = currentSession?.stateMachine?.isProcessing() 
         
        ?? false;
      const shouldAbort = abortSignal?.aborted || !isCurrentlyProcessing;
      
      if (shouldAbort) {
        const reason = abortSignal?.aborted ? 'abort_signal' : 'session_no_longer_processing';
        const currentTurnSignal = currentSession?.currentTurn?.controller?.signal;
        if (abortSignal?.aborted && currentTurnSignal && currentTurnSignal !== abortSignal) {
          this.log.info(
            { sessionId, turnNumber, toolCallCount, reason },
            '[TurnRunner] Stale abort signal ignored after newer turn ownership',
          );
          summarize('aborted', { reason: 'stale_abort_signal' });
          return {
            status: 'aborted',
            toolCallCount,
            toolCallsRequested: requestedToolCallCount,
            messagesLength: currentSession?.messages.length ?? 0,
            doneEmitted: false,
          };
        }

        this.log.info(
          { sessionId, turnNumber, toolCallCount, reason },
          '[TurnRunner] Abort detected, stopping turn',
        );

        // Stop processing (stateMachine when available, fallback to flag)
        if (currentSession) {
          stopProcessing(currentSession, {
            reason: 'abort_detected',
            turnNumber: currentSession.turn,
            caller: 'TurnRunner',
          });
          await this.deps.sessionStore.setAsync(sessionId, currentSession, 'abort_request_processed');
        }
        await reconcilePlanForExit('aborted');

        await emitTurnToolInvocationRollup('aborted');
        summarize('aborted', { reason });
        return {
          status: 'aborted',
          toolCallCount,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: currentSession?.messages.length ?? 0,
          doneEmitted: false,
        };
      }

      // Stop is enforced at every work boundary through the continuation guard.
      // Stop interrupts process-local execution, which is now checked above.

      modelCallCount += 1;
      const sameTurnSession = this.deps.sessionStore.get(sessionId);
      const providerContextCapacity = this.model
        && typeof this.model.getContextCapacity === 'function'
        ? this.model.getContextCapacity()
        : undefined;
      const sameTurnCapacity = sameTurnSession?.modelContextWindow
        ?? providerContextCapacity
        ?? 100_000;
      const sameTurnMeasurement = buildContextMeasurement({
        measurementId: `context:same-turn:${sessionId}:${turnNumber}:${modelCallCount}`,
        requestId: `same-turn:${sessionId}:${turnNumber}:${modelCallCount}`,
        sessionId,
        turn: turnNumber,
        callOrdinal: modelCallCount,
        provider: this.model?.providerName ?? 'unavailable',
        model: modelName ?? this.modelName,
        routedCapacity: sameTurnCapacity,
        capacitySource: sameTurnSession?.modelContextWindow
          ? 'model_config'
          : 'provider_capability_fallback',
        reducerProfile: args.contextMeasurementHints?.reducerProfile ?? 'same_turn_tool_result',
        reducerReason: 'same_turn_tool_result_pressure',
        transformationId: args.contextMeasurementHints?.transformationId,
        envelope: {
          messages,
          tools: toolDefinitions,
          max_tokens: sameTurnSession?.modelMaxOutputTokens ?? 0,
        },
      });
      const sameTurnCompaction = compactSameTurnMessages(
        messages,
        toolDefinitions,
        sameTurnCompactionOptions,
        sameTurnMeasurement,
        {
          // How many further requests this rewrite could be amortized over.
          //
          // This was the remaining tool-call budget, an upper bound, on the reasoning that a
          // refusal should never be blamed on an under-count. That optimizes the wrong way.
          // Over-forecasting benefit approves the rewrite; the mistake it produces is a
          // destroyed warm prefix paid at miss pricing, while under-forecasting only re-sends
          // some tokens the provider was serving cheaply anyway. The forecast is capped at
          // what the next couple of requests can actually pay back, because beyond that it is
          // a guess about a turn that has not happened.
          expectedRemainingRequests: Math.min(
            Math.max(0, this.maxToolCalls - toolCallCount),
            CONSERVATIVE_AMORTIZATION_REQUESTS,
          ),
          // And what is actually at risk, which is warm unless expiry says otherwise.
          cacheState: readPrefixCacheState(metricsAccumulator.toPayload()),
        },
      );
      if (sameTurnCompaction.stats.compactedResults > 0) {
        messages = sameTurnCompaction.messages;
        if (recorder) {
          await recorder.write(sessionId, turnNumber, {
            event: 'context.same_turn_compacted',
            severity: 'info',
            payload: {
              modelCallOrdinal: modelCallCount,
              ...sameTurnCompaction.stats,
            },
            note:
              `same-turn compacted ${sameTurnCompaction.stats.compactedResults} tool result(s), ` +
              `saved ~${sameTurnCompaction.stats.savedTokens} tokens`,
          });
        }
      }

      const modelContinuation = await checkContinuation('model_call');
      if (!modelContinuation.ok) {
        this.log.info(
          { sessionId, turnNumber, continuation: modelContinuation },
          '[TurnRunner] Work continuation blocked before model call',
        );
        summarize('aborted', { reason: modelContinuation.reason, source: modelContinuation.source });
        return {
          status: 'aborted',
          toolCallCount,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: this.deps.sessionStore.get(sessionId)?.messages.length ?? messages.length,
          doneEmitted,
          metrics: metricsAccumulator.toPayload(),
        };
      }

      await args.heartbeat?.();

      const streamResult = await this.streamController.run({
        sessionId,
        turnNumber,
        abortSignal,
        currentMessages: messages,
        toolDefinitions,
        stream,
        recorder,
        modelName,
        configuredModelName: this.modelName,
        maxTokens: this.deps.sessionStore.get(sessionId)?.modelMaxOutputTokens,
        temperature: this.deps.sessionStore.get(sessionId)?.modelTemperature,
        contextMeasurementHints,
        transformationRefs,
        metricsAccumulator,
        onHeartbeat: () => {
          void args.heartbeat?.();
        },
      });

      requestedToolCallCount += streamResult.toolCallCount;

      if (streamResult.status === 'retry_mermaid_validation') {
        mermaidValidationRetryCount += 1;
        messages = streamResult.currentMessages;

        if (recorder) {
          await recorder.write(sessionId, turnNumber, {
            event: 'assistant.mermaid_validation_correction',
            severity: 'warn',
            payload: {
              attempt: mermaidValidationRetryCount,
              retryLimit: MERMAID_VALIDATION_RETRY_LIMIT,
              validation: streamResult.mermaidValidation,
            },
            note: `Mermaid validation correction ${mermaidValidationRetryCount}/${MERMAID_VALIDATION_RETRY_LIMIT}`,
          });
        }

        if (mermaidValidationRetryCount >= MERMAID_VALIDATION_RETRY_LIMIT) {
          this.log.warn(
            { sessionId, turnNumber, mermaidValidationRetryCount },
            '[TurnRunner] Mermaid validation retry safety limit reached',
          );

          return await markRecoverableGuard(
            {
              reason: 'mermaid_validation_retry_exhausted',
              retries: mermaidValidationRetryCount,
              validation: streamResult.mermaidValidation,
            },
            streamResult.usage,
          );
        }

        continue;
      }

      // If model finished without tool calls, return.
      if (streamResult.status === 'completed') {
        const assistantText = typeof streamResult.assistantText === 'string' ? streamResult.assistantText.trim() : undefined;
        const isEmptyCompletion = assistantText !== undefined && assistantText.length === 0;

        if (isEmptyCompletion) {
          if (emptyCompletionRetryCount < EMPTY_COMPLETION_RETRY_LIMIT) {
            emptyCompletionRetryCount += 1;
            const correctiveMessage: OpenAI.Chat.ChatCompletionMessageParam = {
              role: 'user',
              content: EMPTY_COMPLETION_RETRY_MESSAGE,
            };
            messages = [...streamResult.currentMessages, correctiveMessage];

            if (recorder) {
              await recorder.write(sessionId, turnNumber, {
                event: 'assistant.empty_completion_retry',
                severity: 'warn',
                payload: {
                  attempt: emptyCompletionRetryCount,
                  retryLimit: EMPTY_COMPLETION_RETRY_LIMIT,
                },
                note: `empty completion retry ${emptyCompletionRetryCount}/${EMPTY_COMPLETION_RETRY_LIMIT}`,
              });
            }

            this.log.warn(
              {
                sessionId,
                turnNumber,
                attempt: emptyCompletionRetryCount,
                retryLimit: EMPTY_COMPLETION_RETRY_LIMIT,
              },
              '[TurnRunner] Empty completion detected, retrying turn',
            );

            continue;
          }

          return await markRecoverableGuard(
            {
              reason: 'empty_completion_retry_exhausted',
              retries: emptyCompletionRetryCount,
            },
            streamResult.usage,
          );
        }

        // Same-turn finish correction (mirrors Strix base_agent.py lines 415-445):
        // If the model stopped without having called any tools this turn, it likely
        // described its plan instead of acting. Inject a corrective message and retry.
        // Only fires for automated sessions (interactive stops are legitimate mid-conversation).
        const currentSessionForStop = this.deps.sessionStore.get(sessionId);
        const isAutomatedSession = currentSessionForStop?.mode === 'automated';
        if (
          isAutomatedSession &&
          toolCallCount === 0 &&
          !checkSessionTerminal(currentSessionForStop).isTerminal &&
          !hasSecurityOpsCloseoutArtifacts(currentSessionForStop) &&
          prematureStopRetryCount < PREMATURE_STOP_RETRY_LIMIT
        ) {
          prematureStopRetryCount += 1;
          const correctiveMessage: OpenAI.Chat.ChatCompletionMessageParam = {
            role: 'user',
            content: buildPrematureStopCorrectiveMessage(currentSessionForStop),
          };
          messages = [...streamResult.currentMessages, correctiveMessage];

          if (recorder) {
            await recorder.write(sessionId, turnNumber, {
              event: 'assistant.premature_stop_correction',
              severity: 'warn',
              payload: {
                attempt: prematureStopRetryCount,
                retryLimit: PREMATURE_STOP_RETRY_LIMIT,
                assistantTextLength: assistantText?.length ?? 0,
              },
              note: `premature stop correction ${prematureStopRetryCount}/${PREMATURE_STOP_RETRY_LIMIT} (stopped after ${toolCallCount} tool calls)`,
            });
          }

          this.log.warn(
            { sessionId, turnNumber, attempt: prematureStopRetryCount },
            '[TurnRunner] Premature stop detected, injecting corrective message',
          );
          continue;
        }

        await emitTurnToolInvocationRollup('completed');

        // Emit completion milestone (Trace Observability v2)
        if (recorder) {
          const metrics = metricsAccumulator.toPayload();
          const milestoneSession = this.deps.sessionStore.get(sessionId);
          await recorder.write(sessionId, turnNumber, createMilestoneEvent({
            phase: resolveMilestonePhase(milestoneSession, 'execution'),
            status: 'completed',
            summary: `Turn ${turnNumber} completed: ${toolCallCount} tools executed`,
            stats: {
              actionsCount: metrics.tools?.length ?? 0,
              successCount: metrics.tools?.filter((tc) => tc.success).length ?? 0,
              failureCount: metrics.tools?.filter((tc) => !tc.success).length ?? 0,
              discoveriesCount: 0, // Would need to track this across the turn
            },
          }));
        }
        summarize('completed', { messagesLength: streamResult.messagesLength });
        return {
          status: 'completed',
          toolCallCount,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: streamResult.messagesLength,
          doneEmitted,
          usage: streamResult.usage,
          metrics: metricsAccumulator.toPayload(),
        };
      }

      // Execute tool calls
      const toolContinuation = await checkContinuation('tool_call');
      if (!toolContinuation.ok) {
        this.log.info(
          { sessionId, turnNumber, continuation: toolContinuation },
          '[TurnRunner] Work continuation blocked before tool batch',
        );
        summarize('aborted', { reason: toolContinuation.reason, source: toolContinuation.source });
        return {
          status: 'aborted',
          toolCallCount,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: this.deps.sessionStore.get(sessionId)?.messages.length ?? messages.length,
          doneEmitted,
          usage: streamResult.usage,
          metrics: metricsAccumulator.toPayload(),
        };
      }

      const currentSessionForTools = this.deps.sessionStore.get(sessionId);
      if (streamResult.pendingAssistantMessage) {
        // The assembled assistant request is canonical before any requested
        // external effect is allowed to dispatch.
        await this.deps.sessionStore.recordModelResponseAcceptedAsync?.(
          sessionId,
          turnNumber,
          streamResult.modelRequestId,
          streamResult.pendingAssistantMessage,
        );
      }
      await args.heartbeat?.();
      const toolExecResult = await this.toolExecutor.run({
        sessionId,
        modelRequestId: streamResult.modelRequestId,
        abortSignal,
        toolCalls: streamResult.toolCalls,
        stream,
        turnNumber,
        maxToolCalls: effectiveMaxToolCalls,
        reservedToolCalls: reportingReserveToolCalls,
        isAutomated: currentSessionForTools?.mode === 'automated',
        sessionToolCallCount: toolCallCount,
        metricsAccumulator,
        traceRecorder: recorder,
      });
      await args.heartbeat?.();

      // ========================================================================
      // ATOMIC PERSISTENCE: Batch persist assistant + ALL tool results together
      // This is the critical fix that prevents orphaned tool_calls
      // The pendingAssistantMessage came from TurnStreamController (not persisted yet)
      // The collectedToolResults came from TurnToolExecutor (not persisted yet)
      // Now we persist them ALL atomically - zero orphan risk!
      // ========================================================================
      if (streamResult.pendingAssistantMessage) {
        const messagesToPersist: Message[] = [
          streamResult.pendingAssistantMessage,
          ...toolExecResult.collectedToolResults,
        ];

        await this.deps.sessionStore.recordToolOutcomesAcceptedAsync?.(
          sessionId,
          turnNumber,
          toolExecResult.collectedToolResults,
          { awaitingApprovalIsSucceeded: Boolean(toolExecResult.awaitingApprovalContext) },
        );

        // Persist assistant + tool results together to prevent orphaned tool calls.
        await this.deps.sessionStore.appendMessagesAsync(sessionId, messagesToPersist);

        this.log.debug(
          {
            sessionId,
            turnNumber,
            assistantMessageId: streamResult.pendingAssistantMessage.id,
            toolResultCount: toolExecResult.collectedToolResults.length,
          },
          '[TurnRunner] Atomic batch persistence',
        );
      }

      const hasToolBatchAnomaly =
        toolExecResult.skippedToolCalls.length > 0 ||
        Boolean(toolExecResult.status) ||
        streamResult.toolCalls.length !== streamResult.toolCallCount;

      if (recorder && hasToolBatchAnomaly) {
        await recorder.write(sessionId, turnNumber, {
          event: 'tool.execution.batch',
          severity: toolExecResult.skippedToolCalls.length > 0 ? 'warn' : 'debug',
          payload: {
            toolsExecuted: streamResult.toolCalls.map(tc => ({
              id: tc.id,
              name: tc.function.name,
            })),
            requestedCount: streamResult.toolCallCount,
            skippedCount: toolExecResult.skippedToolCalls.length,
            resultStatus: toolExecResult.status || 'completed',
            atomicPersistence: true, // Mark that we used atomic persistence
            messagesPersistedCount: streamResult.pendingAssistantMessage ?
              1 + toolExecResult.collectedToolResults.length : 0,
          },
          note: `executed ${streamResult.toolCalls.length} tools: ${streamResult.toolCalls.map(tc => tc.function.name).join(', ')}`,
        });
      }

      if (recorder && toolExecResult.skippedToolCalls.length > 0) {
        for (const skipped of toolExecResult.skippedToolCalls) {
          await recorder.write(sessionId, turnNumber, {
            event: 'tool.skipped',
            severity: 'info',
            payload: {
              toolCallId: skipped.toolCallId,
              toolName: skipped.toolName,
              reason: skipped.reason,
              endpoint: skipped.endpoint,
              technique: skipped.technique,
            },
            note: skipped.reason
              ? `Skipped ${skipped.toolName}: ${skipped.reason}`
              : `Skipped ${skipped.toolName}`,
          });
        }
      }

      const toolResultEvents = Array.isArray(toolExecResult.toolResultEvents)
        ? toolExecResult.toolResultEvents
        : [];
      if (recorder && toolResultEvents.length > 0) {
        for (const event of toolResultEvents) {
          await recorder.write(sessionId, turnNumber, {
            event: event.persisted ? 'tool_result.persisted' : 'tool_result.normalized',
            severity: event.persisted ? 'info' : 'debug',
            payload: event,
            note: event.persisted
              ? `${event.toolName} result persisted to ${event.artifactPath} saving ~${event.savedApproxTokens} tokens`
              : `${event.toolName} result normalized saving ~${event.savedApproxTokens} tokens`,
          });
        }
      }

      // Emit action.summary events (Trace Observability v2)
      if (recorder && toolExecResult.actionSummaries.length > 0) {
        for (const summary of toolExecResult.actionSummaries) {
          await recorder.write(sessionId, turnNumber, createActionSummaryEvent(summary));
        }
      }

      // Emit discovery events (Trace Observability v2)
      if (recorder && toolExecResult.discoveries.length > 0) {
        for (const discovery of toolExecResult.discoveries) {
          await recorder.write(sessionId, turnNumber, createDiscoveryEvent(discovery));
        }
      }

      // Emit memory.update events (Trace Observability v2)
      if (recorder && toolExecResult.memoryUpdates.length > 0) {
        for (const memoryUpdate of toolExecResult.memoryUpdates) {
          await recorder.write(sessionId, turnNumber, createMemoryUpdateEvent(memoryUpdate));
        }
      }

      const sessionAfterTools = this.deps.sessionStore.get(sessionId);
      const terminalAfterTools = checkSessionTerminal(sessionAfterTools);
      if (terminalAfterTools.isTerminal) {
        const totalToolCalls = toolCallCount + toolExecResult.toolCallCount;
        await emitTurnToolInvocationRollup('completed');
        if (recorder) {
          const metrics = metricsAccumulator.toPayload();
          await recorder.write(sessionId, turnNumber, createMilestoneEvent({
            phase: resolveMilestonePhase(sessionAfterTools, 'execution'),
            status: 'completed',
            summary: `Terminal action submitted (${terminalAfterTools.kind ?? 'unknown'}): ${totalToolCalls} tools executed`,
            stats: {
              actionsCount: metrics.tools?.length ?? 0,
              successCount: metrics.tools?.filter((tc) => tc.success).length ?? 0,
              failureCount: metrics.tools?.filter((tc) => !tc.success).length ?? 0,
              discoveriesCount: 0,
            },
          }));
        }
        summarize('completed', {
          messagesLength: sessionAfterTools?.messages.length ?? streamResult.messagesLength,
          terminalKind: terminalAfterTools.kind,
        }, totalToolCalls);
        return {
          status: 'completed',
          toolCallCount: totalToolCalls,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: sessionAfterTools?.messages.length ?? streamResult.messagesLength,
          doneEmitted,
          usage: streamResult.usage,
          metrics: metricsAccumulator.toPayload(),
        };
      }

      if (toolExecResult.status === 'deadlock') {
        const totalToolCalls = toolCallCount + toolExecResult.toolCallCount;
        toolCallCount = totalToolCalls;
        return await markRecoverableGuard(
          {
            reason: 'repeated_tool_call_loop',
            messagesLength: this.deps.sessionStore.get(sessionId)?.messages.length ?? 0,
          },
          streamResult.usage,
        );
      }

      if (toolExecResult.status === 'aborted') {
        const totalToolCalls = toolCallCount + toolExecResult.toolCallCount;
        toolCallCount = totalToolCalls;
        await emitTurnToolInvocationRollup('aborted');
        summarize('aborted', {
          messagesLength: this.deps.sessionStore.get(sessionId)?.messages.length ?? 0,
        }, totalToolCalls);
        return {
          status: 'aborted',
          toolCallCount: totalToolCalls,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: this.deps.sessionStore.get(sessionId)?.messages.length ?? 0,
          doneEmitted,
          usage: streamResult.usage,
          metrics: metricsAccumulator.toPayload(),
        };
      }

      if (toolExecResult.status === 'awaiting_approval' && toolExecResult.pendingApproval) {
        const totalToolCalls = toolCallCount + toolExecResult.toolCallCount;
        const session = this.deps.sessionStore.get(sessionId);
        const pendingApproval = toolExecResult.pendingApproval;

        if (session) {
          const previousStatus = deriveSessionStatusForEvent(session);
          session.pendingApproval = pendingApproval;
          session.blockedReason = undefined;
          awaitUser(session, {
            reason: 'approval_pending',
            turnNumber: session.turn,
            caller: 'TurnRunner',
          });
          await this.deps.sessionStore.setAsync(sessionId, session, 'approval_pending');
          const updatedSession = this.deps.sessionStore.get(sessionId);
          if (updatedSession && this.deps.events) {
            emitSessionStatusEvent(this.deps.events, updatedSession, previousStatus, 'approval_pending', recorder);
          }
        }

        await this.deps.sessionStore.clearCurrentTurnAsync(sessionId);
        await reconcilePlanForExit('awaiting_approval');

        await emitTurnToolInvocationRollup('awaiting_approval');
        summarize('awaiting_approval', {
          messagesLength: session?.messages.length ?? 0,
          actionId: pendingApproval.actionId,
          toolName: pendingApproval.tool,
        }, totalToolCalls);

        return {
          status: 'awaiting_approval',
          toolCallCount: totalToolCalls,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: session?.messages.length ?? 0,
          doneEmitted: false,
          usage: streamResult.usage,
          metrics: metricsAccumulator.toPayload(),
        };
      }

      if (
        toolExecResult.status === 'awaiting_approval' &&
        toolExecResult.awaitingApprovalContext?.kind === 'plan_submission'
      ) {
        const totalToolCalls = toolCallCount + toolExecResult.toolCallCount;
        const session = this.deps.sessionStore.get(sessionId);
        const planApprovalContext = toolExecResult.awaitingApprovalContext;

        if (session) {
          const previousStatus = deriveSessionStatusForEvent(session);
          const journalProjected = await this.deps.sessionStore.recordSessionCompletedAsync(
            sessionId,
            'plan_submitted',
            args.executionClaimToken,
          );
          const persisted = journalProjected
            ? true
            : this.deps.sessionRepository?.setCompleted
              ? args.executionClaimToken
                ? await this.deps.sessionRepository.setCompleted(sessionId, true, args.executionClaimToken)
                : await this.deps.sessionRepository.setCompleted(sessionId, true)
              : false;
          if (!persisted) {
            throw new Error('durable_planner_completion_failed');
          }

          // Materialize terminal state only after its canonical journal fact
          // and completion projection committed successfully.
          const nextFlags = { ...(session.flags ?? {}) } as Record<string, unknown>;
          const sessionFlags = {
            ...((nextFlags['session'] as Record<string, unknown> | undefined) ?? {}),
            completed: true,
          };
          delete nextFlags['blocked_reason'];
          session.pendingApproval = undefined;
          session.blockedReason = undefined;
          session.completed = true;
          session.flags = {
            ...nextFlags,
            session: sessionFlags,
          };
          stopProcessing(session, {
            reason: 'plan_approval_submitted',
            turnNumber: session.turn,
            caller: 'TurnRunner',
          });

          await this.deps.sessionStore.setAsync(sessionId, session, 'plan_approval_submitted');
          const updatedSession = this.deps.sessionStore.get(sessionId);
          if (updatedSession && this.deps.events) {
            emitSessionStatusEvent(this.deps.events, updatedSession, previousStatus, 'plan_approval_submitted', recorder);
          }
        }

        await this.deps.sessionStore.clearCurrentTurnAsync(sessionId);
        await reconcilePlanForExit('awaiting_approval');

        await emitTurnToolInvocationRollup('awaiting_approval');
        summarize('awaiting_approval', {
          messagesLength: session?.messages.length ?? 0,
          approvalType: 'plan_submission',
          runId: planApprovalContext.runId,
        }, totalToolCalls);

        return {
          status: 'awaiting_approval',
          toolCallCount: totalToolCalls,
          toolCallsRequested: requestedToolCallCount,
          messagesLength: session?.messages.length ?? 0,
          doneEmitted: false,
          usage: streamResult.usage,
          metrics: metricsAccumulator.toPayload(),
        };
      }

      const totalToolCallsAfterBatch = toolCallCount + toolExecResult.toolCallCount;
      const completionTokens = streamResult.usage?.completionTokens;
      const previousWasLowYield =
        previousCompletionTokens === undefined ||
        previousCompletionTokens < DIMINISHING_RETURNS_COMPLETION_TOKEN_THRESHOLD;
      const lowTokenDelta =
        completionTokens !== undefined &&
        completionTokens < DIMINISHING_RETURNS_COMPLETION_TOKEN_THRESHOLD &&
        previousWasLowYield;
      const producedNewSignal = toolExecutionProducedProgress(toolExecResult, resolveToolProgressKind);
      if (modelCallCount > 1 && lowTokenDelta && !producedNewSignal) {
        lowYieldContinuationCount += 1;
      } else if (producedNewSignal) {
        lowYieldContinuationCount = 0;
        const session = this.deps.sessionStore.get(sessionId);
        if (getDiminishingReturnsRepairTurn(session) === turnNumber && session?.flags) {
          delete session.flags.diminishingReturns;
          await this.deps.sessionStore.setAsync(sessionId, session, 'diminishing_returns_repair_satisfied');
          if (recorder) {
            await recorder.write(sessionId, turnNumber, {
              event: 'context.diminishing_returns_repair_satisfied',
              severity: 'info',
              payload: {
                modelCallCount,
                totalToolCalls: totalToolCallsAfterBatch,
              },
              note: 'Diminishing-returns repair turn produced progress',
            });
          }
        }
      }
      if (completionTokens !== undefined) {
        previousCompletionTokens = completionTokens;
      }

      const lifecycleGate = getRepeatedLifecycleGate(this.deps.sessionStore.get(sessionId));
      const repeatedLifecycleGate = lifecycleGate && lifecycleGate.count >= 3;
      const lowYieldStop =
        modelCallCount >= DIMINISHING_RETURNS_CONTINUATION_THRESHOLD + 1 &&
        totalToolCallsAfterBatch >= DIMINISHING_RETURNS_MIN_TOOL_CALLS &&
        lowYieldContinuationCount >= DIMINISHING_RETURNS_CONTINUATION_THRESHOLD;
      if (lowYieldStop || repeatedLifecycleGate) {
        // D11/D12 - mandatory terminal obligations outrank a productivity yield. Run r1
        // yielded reporting before summary.md and report.md existed, and ended six phases
        // without the handoff their own preflight had already approved. Both times the
        // automation opened another whole turn to do one tool call.
        const sessionForObligation = this.deps.sessionStore.get(sessionId);
        const obligation = findTerminalObligation({
          session: sessionForObligation,
          requiresReport: shouldRequireReportForSession(sessionForObligation),
          pendingPlanStepCount: countPendingPlanSteps(sessionForObligation),
          totalPlanStepCount: countPlanSteps(sessionForObligation),
        });
        const yieldDecision = decideObligationYield(
          obligation,
          modelCallCount - obligationFirstSeenAtModelCall,
        );
        if (obligation !== null && obligationFirstSeenAtModelCall === Number.MAX_SAFE_INTEGER) {
          obligationFirstSeenAtModelCall = modelCallCount;
        }

        if (!yieldDecision.mayYield && obligation !== null) {
          if (recorder) {
            await recorder.write(sessionId, turnNumber, {
              event: 'context.terminal_obligation_outranks_yield',
              severity: 'info',
              payload: {
                obligation: obligation.kind,
                dischargeTool: obligation.dischargeTool,
                graceCallsUsed: yieldDecision.graceCallsUsed,
                graceCallsAllowed: yieldDecision.graceCallsAllowed,
                stopReason: lowYieldStop ? 'low_yield_continuations' : 'repeated_lifecycle_gate',
              },
              note: `held the turn open to discharge ${obligation.kind}`,
            });
          }
          const held = this.deps.sessionStore.get(sessionId);
          if (held) {
            held.flags = {
              ...(held.flags ?? {}),
              ephemeralNudge: buildTerminalObligationNudge(obligation),
            };
            await this.deps.sessionStore.setAsync(
              sessionId,
              held,
              'terminal_obligation_outranks_yield',
            );
          }
          lowYieldContinuationCount = 0;
          messages = [...streamResult.currentMessages, ...toolExecResult.currentMessages];
          toolCallCount = totalToolCallsAfterBatch;
          if (completionTokens !== undefined) {
            previousCompletionTokens = completionTokens;
          }
          continue;
        }

        toolCallCount = totalToolCallsAfterBatch;
        return await markDiminishingReturns(
          {
            modelCallCount,
            lowYieldContinuationCount,
            completionTokens,
            previousCompletionTokens,
            totalToolCalls: totalToolCallsAfterBatch,
            producedNewSignal,
            repeatedLifecycleGate,
            lifecycleGate,
            ...(obligation ? { obligationGraceExhausted: obligation.kind } : {}),
            stopReason: lowYieldStop ? 'low_yield_continuations' : 'repeated_lifecycle_gate',
          },
          streamResult.usage,
        );
      }

      messages = [...streamResult.currentMessages, ...toolExecResult.currentMessages];
      // Count executed tool calls (including skips) once per tool execution.
      // streamResult.toolCallCount already reflects requested tool calls.
      toolCallCount = totalToolCallsAfterBatch;
    }

    // Graceful exit when hitting tool-call cap
    // In automated mode, we skip the summary message because:
    //   1. OrchestratorAdapter.automationContinuationPolicy will auto-schedule next turn
    //   2. Adding "If you want me to continue..." confuses the model
    // In interactive mode, we show the summary so the user knows to continue manually
    const currentSession = this.deps.sessionStore.get(sessionId);
    const isAutomated = currentSession?.mode === 'automated';
    
    if (!isAutomated) {
      // Interactive mode: add summary message for user to see
      const summaryMessage: OpenAI.Chat.ChatCompletionMessageParam = {
        role: 'assistant',
        content:
          'Tool call budget reached for this turn. Summarizing progress so far. ' +
          'If you want me to continue, start another turn with any additional guidance.',
      };
      messages.push(summaryMessage);
      
      // Emit to stream so clients see the summary immediately
      const summaryEvent: Message = {
        id: `summary_${Date.now()}`,
        role: 'assistant',
        content: typeof summaryMessage.content === 'string' ? summaryMessage.content : '',
        timestamp: Date.now(),
      };
      stream.message(summaryEvent);
    } else {
      this.log.debug(
        { sessionId, toolCallCount },
        '[TurnRunner] Automated mode: skipping summary message, continuation policy handles next turn'
      );
    }

    const messagesLength = this.deps.sessionStore.get(sessionId)?.messages.length ?? 0;
    const checkpointId = await createTurnExitCheckpoint('max_tool_calls', toolCallCount);
    await reconcilePlanForExit('max_tool_calls', {
      blockPending: false,
      checkpointId,
    });
    await emitTurnToolInvocationRollup('max_tool_calls');
    summarize('max_tool_calls', { messagesLength, emittedSummary: true });
    return {
      status: 'max_tool_calls' as TurnRunStatus,
      toolCallCount,
      toolCallsRequested: requestedToolCallCount,
      messagesLength,
      doneEmitted,
      metrics: metricsAccumulator.toPayload(),
      // Note: usage from last streamResult might be lost here since we run multiple iterations
      // For accurate per-iteration tracking, see model.call.finish events in the trace
    };
  }
}

