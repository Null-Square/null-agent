/**
 * ProcessMessageCommand - Orchestrates a single user message through the turn pipeline.
 *
 * Extracted from OrchestratorAdapter.processMessage() to:
 * 1. Reduce OrchestratorAdapter complexity (was 1121 lines)
 * 2. Make message processing testable in isolation
 * 3. Follow Single Responsibility Principle
 *
 * This command handles:
 * - Session preparation
 * - Pre-turn checks (authorization, token limits, sandbox health)
 * - Prompt building
 * - Turn execution
 * - Artifact flushing
 * - Guard handling (automation continuation)
 * - Error handling
 */

import type { MessageMetadata, SessionState, PlanItem, WorkerResultArtifact } from '../../../domain/types';
import type { SessionStore } from '../../core/SessionStore';
import type { ContextProviderPort, SessionEventPublisher, ToolRegistryPort, SandboxHealthPort } from '../../../ports';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type {
  ArtifactServicePort,
  CacheCoordinatorPort,
  PolicyResolverPort,
  PromptBuilderPort,
  TurnExecutorPort,
} from '../../../ports';
import type {
  BuildPromptArgs,
  BuildPromptResult,
  BuildStage,
  PrepareStage,
  PrepareSessionResult,
  ReconcileStage,
  ExecuteTurnResult,
} from '../stages';
import type { PreTurnChecks } from '../services/PreTurnChecks';
import type { TurnErrorHandler } from '../services/TurnErrorHandler';
import type { AutomationGuardHandler } from '../services/AutomationGuardHandler';
import type { TurnFailurePolicy } from '../services/TurnFailurePolicy';
import type { ModelExecutionPort, ModelPromptProfilePort } from '../../../ports';

import { StreamBroker as TurnStreamBroker } from '../streaming/StreamBroker';
import type { StreamBroker } from '../streaming/StreamBroker';
import { isAbortError } from '../services/TurnErrorHandler';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import type { AppLogger } from '@/shared/logger';
import { CompletionBlockedError } from '../../../domain/errors';
import type { NotificationPort } from '../../../ports';
import { NotificationKinds } from '../../../ports';
import { stopProcessing } from '../utils/sessionProcessing';
import { deriveSessionStatusForEvent, emitSessionStatusEvent } from '../utils/sessionStatusEvents';
import { buildUserNotificationTarget, extractRunIdFromSession } from '@/shared/notifications/userNotificationTarget';
import { resolveWorkerMaxToolCalls, shouldRequireReportForSession } from '../../../domain/workers/workerContracts';
import type { AutomatedRunCloseoutReconciliation } from '@/domains/security-ops/tools/SecurityOpsToolService';
import { checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import { getHostedRunHistoryTransformationLifecycle } from '@/domains/security-ops/runs/HostedRunPersistencePort';
import type { HistoryTransformationPort } from '../../../ports';
import { v4 as uuidv4 } from 'uuid';
import { ERROR_CODES } from '@null-ai/contracts';

const EXECUTION_CLAIM_TTL_MS = 60_000;
const EXECUTION_CLAIM_HEARTBEAT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readPinnedModelId = (session: SessionState | undefined): string | undefined => {
  const selection = isRecord(session?.flags?.model_selection) ? session.flags.model_selection : undefined;
  const value = selection?.resolvedModelId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/** Website Watch owns its rich completion event and PDF delivery. */
export const shouldEmitGenericCompletionNotification = (session: SessionState): boolean => {
  const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  return securityops?.runTrigger !== 'watch_scheduled';
};

const uniqueStrings = (values: unknown[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const compactText = (value: string, maxLength = 280): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
};

const describeTurnCompletion = (
  status: ExecuteTurnResult['status'],
): {
  status: 'completed' | 'approval_pending' | 'blocked' | 'aborted' | 'failed' | 'max_tool_calls' | 'retry_scheduled';
  stopReason: string;
  nextAction?: string;
} => {
  switch (status) {
    case 'completed':
      return { status: 'completed', stopReason: 'completed' };
    case 'awaiting_approval':
      return {
        status: 'approval_pending',
        stopReason: 'awaiting_approval',
        nextAction: 'operator approval is required before execution can continue',
      };
    case 'credits_exhausted':
      return {
        status: 'blocked',
        stopReason: 'credits_exhausted',
        nextAction: 'add credits or resume after credit state changes',
      };
    case 'aborted':
    case 'paused':
      return {
        status: 'aborted',
        stopReason: status,
        nextAction: 'resume the session if more work should continue',
      };
    case 'max_tool_calls':
      return {
        status: 'max_tool_calls',
        stopReason: 'max_tool_calls',
        nextAction: 'start a follow-up turn if the task remains active',
      };
    case 'deadlock':
      return {
        status: 'blocked',
        stopReason: 'deadlock',
        nextAction: 'change tool strategy or checkpoint the blocker',
      };
    case 'timeout':
      return {
        status: 'retry_scheduled',
        stopReason: 'timeout',
        nextAction: 'retry according to the session retry policy',
      };
    default:
      return { status: 'failed', stopReason: String(status) };
  }
};

const latestWorkerBreadcrumb = (session: SessionState): string => {
  const latest = [...(session.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        (message.role === 'assistant' || message.role === 'tool') &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0,
    );
  return typeof latest?.content === 'string'
    ? compactText(latest.content)
    : 'No final worker summary was available before the token safety limit fired.';
};

const buildTokenLimitWorkerArtifact = (
  session: SessionState,
  haltEventData?: Record<string, unknown>,
): WorkerResultArtifact | null => {
  const coordination = session.coordination;
  if (coordination?.role !== 'worker' || !coordination.parentTaskId || !coordination.workerType) {
    return null;
  }

  const currentUsage = typeof haltEventData?.currentUsage === 'number' ? haltEventData.currentUsage : undefined;
  const limit = typeof haltEventData?.limit === 'number' ? haltEventData.limit : undefined;
  const usageSuffix =
    currentUsage && limit ? ` (${currentUsage.toLocaleString()}/${limit.toLocaleString()} tokens)` : '';
  return {
    taskId: coordination.parentTaskId,
    workerType: coordination.workerType,
    summary:
      `Worker reached the universal session token safety limit${usageSuffix} before explicit handoff. ` +
      `Partial result: ${latestWorkerBreadcrumb(session)}`,
    findings: [],
    evidenceRefs: [],
    touchedTargets: [],
    recommendedNextAction:
      'Review this partial worker result, synthesize what is already known, and only spawn a narrower follow-up if the remaining gap is material.',
    confidence: 0.2,
  };
};

const getSecurityOpsFlags = (session: SessionState | undefined): Record<string, unknown> | undefined =>
  isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;

const isAcceptedNonReportingPhaseHandoff = (session: SessionState | undefined): boolean => {
  const securityops = getSecurityOpsFlags(session);
  const activePhaseKey =
    typeof securityops?.activePhaseKey === 'string' ? securityops.activePhaseKey.trim().toLowerCase() : '';
  if (!activePhaseKey || activePhaseKey === 'reporting') {
    return false;
  }
  return (
    securityops?.phaseHandoffSubmitted === true &&
    ['completed', 'blocked', 'failed'].includes(String(securityops.phaseHandoffStatus ?? ''))
  );
};

const getSecurityOpsContext = (
  session: SessionState,
): {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
} => {
  const securityops = getSecurityOpsFlags(session);
  return {
    organizationId: typeof securityops?.organizationId === 'string' ? securityops.organizationId : undefined,
    scopeId: typeof session.scopeId === 'string' ? session.scopeId : undefined,
    runId: typeof securityops?.runId === 'string' ? securityops.runId : undefined,
  };
};

const applySecurityOpsRunCompletion = (
  session: SessionState,
  result: { mode?: string; runCompletion?: unknown },
): void => {
  const existingSecurityOps = getSecurityOpsFlags(session);
  const runCompletion = isRecord(result.runCompletion) ? result.runCompletion : undefined;
  session.flags = {
    ...(session.flags ?? {}),
    securityops: {
      ...(existingSecurityOps ?? {}),
      runCompletion,
      finalizedMode: result.mode,
      artifactsFinalizedAt: new Date().toISOString(),
      finalizedAt: runCompletion?.state === 'completed' ? new Date().toISOString() : existingSecurityOps?.finalizedAt,
    },
  };
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }
  if (isRecord(error) && typeof error['message'] === 'string') {
    return error['message'];
  }
  return String(error);
};

const isSessionAlreadyProcessingError = (error: unknown): boolean => {
  return getErrorMessage(error) === 'session_already_processing';
};

const LIVE_WORKER_TASK_STATUSES = new Set(['pending', 'running', 'blocked', 'awaiting_input', 'awaiting_approval']);

const hasLiveSidecarWorkers = (session: SessionState | undefined): boolean =>
  Boolean(
    session &&
    session.mode === 'automated' &&
    session.agentType === 'executor' &&
    session.coordination?.role !== 'worker' &&
    Array.isArray(session.workerTasks) &&
    session.workerTasks.some(
      (task) =>
        LIVE_WORKER_TASK_STATUSES.has(task.status) &&
        task.executionMode === 'background' &&
        (task.dependencyMode ?? 'sidecar') === 'sidecar',
    ),
  );

/**
 * Dependencies required by ProcessMessageCommand.
 * Injected from OrchestratorAdapter.
 */
export interface ProcessMessageDeps {
  // Core
  sessionStore: SessionStore;
  events: SessionEventPublisher;
  traceRecorder?: SessionTraceRecorder;

  // Direct hot-path stages
  prepareStage: PrepareStage;
  buildStage: BuildStage;
  reconcileStage: ReconcileStage;
  contextProvider: ContextProviderPort;
  cacheCoordinator: CacheCoordinatorPort;
  toolsRegistry: ToolRegistryPort;
  policyResolver: PolicyResolverPort;
  promptBuilder: PromptBuilderPort;
  turnExecutor: TurnExecutorPort;

  // Services
  preTurnChecks: PreTurnChecks;
  turnErrorHandler: TurnErrorHandler;
  automationGuardHandler: AutomationGuardHandler;
  turnFailurePolicy: TurnFailurePolicy;
  artifactService: ArtifactServicePort;
  sandboxHealthChecker?: SandboxHealthPort;
  notificationPort?: NotificationPort;
  /** Organization history store. Hosted research runs resolve their registered file store by run ID. */
  historyTransformationPort?: HistoryTransformationPort;

  // Model
  getProvider: (sessionId: string, modelName: string, modelId?: string) => Promise<ModelPromptProfilePort>;
  getModelStream: (sessionId: string, modelName: string, modelId?: string) => Promise<ModelExecutionPort>;
  maxToolCalls: number;
  convertMessages: BuildPromptArgs['convertMessages'];

  // Logging
  log: AppLogger;

  // Repository for durable storage
  sessionRepository?: {
    setBlockedReason: (
      id: string,
      reason: string,
      meta?: Record<string, unknown>,
      executionClaimToken?: string,
    ) => Promise<boolean>;
    setBlockedReasonIfClear?: (
      id: string,
      reason: string,
      meta?: Record<string, unknown>,
    ) => Promise<boolean>;
    clearBlockedReason: (id: string, expectedReason?: string, executionClaimToken?: string) => Promise<boolean>;
    getBlockedReason: (id: string) => Promise<string | null>;
    setCompleted: (id: string, completed: boolean, executionClaimToken?: string) => Promise<boolean>;
    acquireExecutionClaim?: (params: { sessionId: string; claimToken: string; expiresAt: Date }) => Promise<boolean>;
    renewExecutionClaim?: (params: { sessionId: string; claimToken: string; expiresAt: Date }) => Promise<boolean>;
    ownsExecutionClaim?: (sessionId: string, claimToken: string) => Promise<boolean>;
    releaseExecutionClaim?: (sessionId: string, claimToken: string) => Promise<boolean>;
  };
  runCloseoutReconciler?: {
    reconcileAutomatedRunCloseout: (params: {
      userId: string;
      workspaceDir: string;
      sessionId?: string;
      context?: {
        organizationId?: string;
        scopeId?: string;
        runId?: string;
      };
      plan?: PlanItem[];
      reportedFindingIds?: string[];
      shellJobs?: Record<string, unknown>;
      alreadyFinalized?: boolean;
      finalizedMode?: 'final' | 'interim';
    }) => Promise<AutomatedRunCloseoutReconciliation>;
  };
}

/**
 * Input for processing a message.
 */
export interface ProcessMessageInput {
  sessionId: string;
  userInput: string;
  profileKey?: string;
  extraContext?: string;
  messageMetadata?: MessageMetadata;
  executionClaimToken?: string;
  retainExecutionClaim?: boolean;
  executionClaimLost?: () => boolean;
}

/**
 * Command for processing a user message through the orchestration pipeline.
 */
export class ProcessMessageCommand {
  constructor(private readonly deps: ProcessMessageDeps) {}

  /**
   * Execute the message processing pipeline.
   */
  async execute(input: ProcessMessageInput): Promise<void> {
    const claims = this.deps.sessionRepository;
    if (
      !claims?.acquireExecutionClaim ||
      !claims.renewExecutionClaim ||
      !claims.ownsExecutionClaim ||
      !claims.releaseExecutionClaim
    ) {
      return this.executePipeline(input);
    }

    const claimToken = input.executionClaimToken ?? uuidv4();
    let claimLost = false;
    const preclaimed = Boolean(input.executionClaimToken);
    const acquired = preclaimed
      ? await claims.ownsExecutionClaim(input.sessionId, claimToken)
      : await claims.acquireExecutionClaim({
          sessionId: input.sessionId,
          claimToken,
          expiresAt: new Date(Date.now() + EXECUTION_CLAIM_TTL_MS),
        });
    if (!acquired) {
      if (preclaimed) {
        throw new Error('execution_claim_lost');
      }
      if (input.userInput.trim().length > 0) {
        this.deps.events.emit(input.sessionId, {
          type: 'warning',
          data: {
            code: 'session_already_processing',
            message: 'Session is already processing. Please wait for the current turn to finish.',
          },
        });
      }
      this.deps.log.info({ sessionId: input.sessionId }, '[ProcessMessage] Durable execution claim is busy');
      return;
    }

    const renew = async (): Promise<void> => {
      if (claimLost) throw new Error('execution_claim_lost');
      try {
        const renewed = await claims.renewExecutionClaim!({
          sessionId: input.sessionId,
          claimToken,
          expiresAt: new Date(Date.now() + EXECUTION_CLAIM_TTL_MS),
        });
        if (renewed) return;
      } catch (error) {
        claimLost = true;
        await this.deps.sessionStore
          .abortCurrentTurnAsync(input.sessionId, 'execution_claim_lost')
          .catch(() => undefined);
        throw error;
      }
      claimLost = true;
      await this.deps.sessionStore
        .abortCurrentTurnAsync(input.sessionId, 'execution_claim_lost')
        .catch(() => undefined);
      throw new Error('execution_claim_lost');
    };
    const timer = setInterval(() => {
      void renew().catch((error) => {
        this.deps.log.warn(
          { err: error, sessionId: input.sessionId },
          '[ProcessMessage] Execution claim heartbeat failed',
        );
      });
    }, EXECUTION_CLAIM_HEARTBEAT_MS);
    timer.unref?.();

    try {
      await this.executePipeline(
        {
          ...input,
          executionClaimToken: claimToken,
          executionClaimLost: () => claimLost,
        },
        renew,
      );
    } finally {
      clearInterval(timer);
      if (!input.retainExecutionClaim) {
        await claims.releaseExecutionClaim(input.sessionId, claimToken).catch((error) => {
          this.deps.log.warn(
            { err: error, sessionId: input.sessionId },
            '[ProcessMessage] Failed to release execution claim',
          );
        });
      }
    }
  }

  private async executePipeline(input: ProcessMessageInput, executionHeartbeat?: () => Promise<void>): Promise<void> {
    const { sessionId, userInput, profileKey, extraContext, messageMetadata } = input;
    const turnStartedAt = Date.now();
    let turnStatus: 'ok' | 'abort' | 'error' = 'ok';
    let prepared: PrepareSessionResult | undefined;
    let turnResult: ExecuteTurnResult | undefined;
    let doneEmitted = false;
    let skipCleanup = false;

    try {
      const terminalBeforePrepare = checkSessionTerminal(this.deps.sessionStore.get(sessionId));
      const journalBeforePrepare = terminalBeforePrepare.isTerminal
        ? await this.deps.sessionStore.getJournalProjection?.(sessionId)
        : undefined;
      const hasDurableContinuation = journalBeforePrepare?.desiredExecution === 'running'
        && journalBeforePrepare.hasUnfinishedWork;
      if (terminalBeforePrepare.isTerminal && !hasDurableContinuation) {
        this.deps.events.emit(sessionId, {
          type: 'warning',
          data: {
            code: 'terminal_session',
            message:
              `This session already submitted its terminal result` +
              `${terminalBeforePrepare.kind ? ` (${terminalBeforePrepare.kind})` : ''} and will not be scheduled again.`,
          },
        });
        return;
      }

      // PHASE 1: Clear only the explicit response wait. Stop/Start and
      // operational waits are owned by the journal reconciler.
      const protectedBlockedReason = await this.clearBlockedReasonIfNeeded(
        sessionId,
        userInput,
        input.executionClaimToken,
      );
      if (protectedBlockedReason && userInput.trim().length > 0) {
        this.deps.events.emit(sessionId, {
          type: 'warning',
          data: {
            code: 'session_blocked',
            message: 'Session is waiting for your input. Use the response form to continue.',
          },
        });
        return;
      }

      // PHASE 2: Prepare session
      prepared = await this.deps.prepareStage.run({
        sessionId,
        userInput,
        profileKey,
        extraContext,
        messageMetadata,
        sessionStore: this.deps.sessionStore,
        policyResolver: this.deps.policyResolver,
        events: this.deps.events,
        traceRecorder: this.deps.traceRecorder,
        streamFactory: (emit) => new TurnStreamBroker(emit),
        sandboxHealthChecker: this.deps.sandboxHealthChecker,
      });

      // PHASE 3: Pre-turn checks
      const session = this.deps.sessionStore.get(sessionId);
      if (session) {
        const shouldProceed = await this.runPreTurnChecks(sessionId, session, prepared, input.executionClaimToken);
        if (!shouldProceed) {
          return;
        }
      }

      const sessionForModel = this.deps.sessionStore.get(sessionId) ?? prepared.sessionState;
      const modelName = sessionForModel?.modelName?.trim();
      if (!modelName) {
        throw new Error('[ProcessMessage] modelName is required. Configure a default model in the database.');
      }
      const modelId = readPinnedModelId(sessionForModel);
      const effectiveMaxToolCalls = resolveWorkerMaxToolCalls(sessionForModel, this.deps.maxToolCalls);

      // PHASE 4: Build prompt
      const provider = await this.deps.getProvider(sessionId, modelName, modelId);
      const sessionForPrompt = this.deps.sessionStore.get(sessionId) ?? prepared.sessionState;
      const securityops = isRecord(sessionForPrompt.flags?.securityops)
        ? sessionForPrompt.flags.securityops
        : undefined;
      const runHost = typeof securityops?.runHost === 'string' ? securityops.runHost : undefined;
      const runId = typeof securityops?.runId === 'string' ? securityops.runId : undefined;
      const historyTransformationPort =
        getHostedRunHistoryTransformationLifecycle({ runHost, runId }) ?? this.deps.historyTransformationPort;
      let prompt = await this.deps.buildStage.run({
        session: sessionForPrompt,
        turnNumber: prepared.turnNumber,
        contextProvider: this.deps.contextProvider,
        promptBuilder: this.deps.promptBuilder,
        cacheCoordinator: this.deps.cacheCoordinator,
        toolsRegistry: this.deps.toolsRegistry,
        provider,
        traceRecorder: prepared.recorder,
        convertMessages: this.deps.convertMessages,
        maxToolCalls: effectiveMaxToolCalls,
        modelName,
        abortSignal: prepared.turnController.signal,
        executeModelCall: this.deps.turnExecutor.executeModelCall?.bind(this.deps.turnExecutor),
        historyTransformationPort,
        runId,
        stepId: sessionForPrompt.currentPlanStepId,
      });

      await this.recordActivatedCompaction(sessionId, prompt);

      // Emit context events
      this.emitContextEvents(sessionId, prompt);

      // PHASE 5: Execute turn
      const modelStream = await this.deps.getModelStream(sessionId, modelName, modelId);
      this.deps.turnExecutor.setModelName(modelName);
      this.deps.turnExecutor.setModel?.(modelStream);

      const executePrompt = (built: BuildPromptResult): Promise<ExecuteTurnResult> =>
        this.deps.turnExecutor.runTurn({
          sessionId,
          turnNumber: prepared!.turnNumber,
          abortSignal: prepared!.turnController.signal,
          systemMessages: built.systemMessages,
          historyMessages: built.historyMessages,
          toolDefinitions: built.toolDefinitions,
          contextMeasurementHints: built.contextMeasurementHints,
          transformationRefs: built.transformationRefs,
          stream: prepared!.turnStream,
          recorder: prepared!.recorder,
          modelName,
          maxToolCalls: effectiveMaxToolCalls,
          ...(executionHeartbeat ? { heartbeat: executionHeartbeat } : {}),
          ...(input.executionClaimToken ? { executionClaimToken: input.executionClaimToken } : {}),
        });

      try {
        turnResult = await executePrompt(prompt);
      } catch (error) {
        const errorCode = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
        if (errorCode !== ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED) throw error;

        const triggerRequestId =
          isRecord(error) && typeof error.modelRequestId === 'string' ? error.modelRequestId : undefined;
        const previousTransformationRefs = new Set(prompt.transformationRefs ?? []);
        const overflowSession = this.deps.sessionStore.get(sessionId) ?? prepared.sessionState;
        prompt = await this.deps.buildStage.run({
          session: overflowSession,
          turnNumber: prepared.turnNumber,
          contextProvider: this.deps.contextProvider,
          promptBuilder: this.deps.promptBuilder,
          cacheCoordinator: this.deps.cacheCoordinator,
          toolsRegistry: this.deps.toolsRegistry,
          provider,
          traceRecorder: prepared.recorder,
          convertMessages: this.deps.convertMessages,
          maxToolCalls: effectiveMaxToolCalls,
          modelName,
          abortSignal: prepared.turnController.signal,
          executeModelCall: this.deps.turnExecutor.executeModelCall?.bind(this.deps.turnExecutor),
          historyTransformationPort,
          compactionReason: 'provider_context_overflow',
          triggerRequestId,
          runId,
          stepId: overflowSession.currentPlanStepId,
        });
        const committedOverflowTransformation = (prompt.transformationRefs ?? []).find(
          (ref) => !previousTransformationRefs.has(ref),
        );
        if (!prompt.compactionResult || !committedOverflowTransformation) {
          throw error;
        }
        await this.recordActivatedCompaction(sessionId, prompt);
        this.emitContextEvents(sessionId, prompt);
        // This is the only overflow retry. A second typed overflow escapes to the
        // normal failure policy, so no request/compaction loop can form.
        turnResult = await executePrompt(prompt);
      }

      if (!this.isPreparedTurnCurrent(sessionId, prepared)) {
        skipCleanup = true;
        this.deps.log.info(
          { sessionId, turnNumber: prepared.turnNumber },
          '[ProcessMessage] Stale turn exited after a newer turn took ownership',
        );
        return;
      }

      // PHASE 6: Reconcile plan
      const planResult = await this.deps.reconcileStage.run({
        sessionId,
        turnNumber: prepared.turnNumber,
        initialPendingPlanStepIds: prepared.initialPendingPlanStepIds,
        turnStatus: turnResult.status,
        stream: prepared.turnStream,
        recorder: prepared.recorder,
        sessionStore: this.deps.sessionStore,
      });

      doneEmitted = doneEmitted || turnResult.doneEmitted;
      const pendingPlanSteps = planResult?.pendingSteps ?? [];
      const latestSessionBeforeSwitch = this.deps.sessionStore.get(sessionId) ?? prepared.sessionState;

      // Log turn completion
      await this.logTurnComplete(sessionId, prepared, turnResult, latestSessionBeforeSwitch, pendingPlanSteps);

      // Update turn number
      const latestAfterTurn = this.deps.sessionStore.get(sessionId);
      if (latestAfterTurn) {
        latestAfterTurn.turn = prepared.turnNumber;
      }

      // PHASE 7: Flush artifacts
      const artifactResult = await this.deps.artifactService.flush(
        sessionId,
        prepared.turnNumber,
        prepared.turnStream,
        prepared.recorder,
      );

      // Validate S3 completion
      let hasReport = artifactResult.hasReport;
      hasReport = await this.validateS3Completion(sessionId, hasReport, pendingPlanSteps, prepared);

      // PHASE 8: Guard handling
      // Get blockedReason from session to check for terminal states
      const blockedReason = latestSessionBeforeSwitch?.blockedReason ?? session?.blockedReason;
      const guardResult = await this.deps.automationGuardHandler.handle({
        sessionId,
        turnNumber: prepared.turnNumber,
        session: latestSessionBeforeSwitch ?? prepared.sessionState,
        pendingPlanSteps,
        hasReport,
        toolCallCount: turnResult.toolCallCount,
        turnStatus: turnResult.status,
        turnStream: prepared.turnStream,
        recorder: prepared.recorder,
        blockedReason,
      });

      // Reconcile running plan steps on natural session completion.
      // The model may have finished its work without calling plan_set_step_status('completed')
      // for the active step. Transition any remaining 'running' steps to 'completed' so the
      // final plan state is truthful before the run is marked done.
      if (guardResult.modeSwitchReason === 'automated.completed') {
        await this.reconcileRunningPlanSteps(sessionId, prepared.turnStream, prepared.recorder, prepared.turnNumber);
      }

      // Apply mode switch if needed
      if (guardResult.modeSwitchReason) {
        await this.deps.automationGuardHandler.applyModeSwitch({
          sessionId,
          turnNumber: prepared.turnNumber,
          reason: guardResult.modeSwitchReason,
          payload: guardResult.modeSwitchPayload,
          recorder: prepared.recorder,
        });
      }

      // Handle done event emission
      let shouldEmitDone = !doneEmitted;
      if (guardResult.suppressDone) {
        shouldEmitDone = false;
      }

      if (shouldEmitDone) {
        prepared.turnStream.done();
        doneEmitted = true;
      }

      // Handle completion notification
      await this.handleCompletionNotification(sessionId, turnResult, hasReport, input.executionClaimToken);
      await this.cleanupFinalizedRunWorkspaceAfterArtifacts(sessionId, artifactResult.hasSummary, hasReport);

      // Schedule auto-retry if needed
      if (guardResult.scheduleAutoRetry && guardResult.autoRetryMessage) {
        await this.deps.automationGuardHandler.scheduleRetry({
          sessionId,
          message: guardResult.autoRetryMessage,
          profile: guardResult.autoRetryProfile,
          processMessage: (sid, inp, prof) => this.execute({ sessionId: sid, userInput: inp, profileKey: prof }),
          ...(guardResult.autoRetryReason ? { reason: guardResult.autoRetryReason } : {}),
          ...(guardResult.autoRetryDelayMs ? { delayMs: guardResult.autoRetryDelayMs } : {}),
          ...(input.executionClaimToken ? { executionClaimToken: input.executionClaimToken } : {}),
        });
      }

      // Evaluate continuation
      await this.deps.automationGuardHandler.evaluateContinuation({
        sessionId,
        turnNumber: prepared.turnNumber,
        turnStatus: turnResult.status,
        pendingPlanSteps,
        hasReport,
        guardResult,
        processMessage: (sid, inp, prof) => this.execute({ sessionId: sid, userInput: inp, profileKey: prof }),
        recorder: prepared.recorder,
        ...(input.executionClaimToken ? { executionClaimToken: input.executionClaimToken } : {}),
      });

      await this.markAcceptedPhaseSessionCompleted(sessionId, input.executionClaimToken);
    } catch (error) {
      if (input.executionClaimLost?.() || (error instanceof Error && error.message === 'execution_claim_lost')) {
        skipCleanup = true;
        this.deps.log.warn(
          { sessionId, turnNumber: prepared?.turnNumber },
          '[ProcessMessage] Stale worker stopped after losing the durable execution claim',
        );
        return;
      }
      // Benign concurrency: another in-flight turn owns processing for this session.
      // Treat as a no-op and, critically, avoid cleanup that would stop the in-flight turn.
      if (isSessionAlreadyProcessingError(error)) {
        skipCleanup = true;

        // A user duplicate is a harmless no-op. A recovery worker, however,
        // already owns a durable due item and must not report success when the
        // in-memory turn gate rejected it; the worker will durably retry.
        if (input.executionClaimToken) {
          this.deps.log.warn(
            { sessionId },
            '[ProcessMessage] Claimed continuation collided with an active local turn',
          );
          throw error;
        }

        // If this was a real user message (not an automation continuation), surface a lightweight warning.
        if (typeof userInput === 'string' && userInput.trim().length > 0) {
          this.deps.events.emit(sessionId, {
            type: 'warning',
            data: {
              code: 'session_already_processing',
              message: 'Session is already processing. Please wait for the current turn to finish.',
            },
          });
        }

        this.deps.log.info(
          { sessionId },
          '[ProcessMessage] Ignored duplicate processMessage: session already processing',
        );
        return;
      }

      if (
        prepared &&
        isAbortError(error, prepared.turnController.signal) &&
        !this.isPreparedTurnCurrent(sessionId, prepared)
      ) {
        skipCleanup = true;
        this.deps.log.info(
          { sessionId, turnNumber: prepared.turnNumber },
          '[ProcessMessage] Ignored stale aborted turn after newer turn ownership',
        );
        return;
      }

      const result = await this.handleError(error, sessionId, prepared, doneEmitted, input.executionClaimToken);
      turnStatus = result.status;
      doneEmitted = result.doneEmitted;
    } finally {
      if (!skipCleanup) {
        await this.cleanup(sessionId, turnStartedAt, turnStatus, prepared, turnResult?.status);
      }
    }
  }

  // ========================================================================
  // Private helper methods
  // ========================================================================

  private async recordActivatedCompaction(
    sessionId: string,
    prompt: BuildPromptResult,
  ): Promise<void> {
    const activated = prompt.activatedCompaction;
    if (!activated) return;
    await this.deps.sessionStore.recordCompactionAppliedAsync?.(
      sessionId,
      activated.transactionId,
      activated.throughMessageId,
      activated.summaryMessage,
    );
  }

  /**
   * Transition any plan steps still in 'running' state to 'completed' at the moment
   * the session ends naturally (guard says automated.completed).
   *
   * This covers the case where the model finished its work but forgot to call
   * plan_set_step_status before writing run.digest. Without this, the step stays
   * in 'running' permanently, making the final plan state untruthful.
   */
  private async reconcileRunningPlanSteps(
    sessionId: string,
    stream: StreamBroker,
    recorder: SessionTraceRecorder | undefined,
    turnNumber: number,
  ): Promise<void> {
    const session = this.deps.sessionStore.get(sessionId);
    if (!session?.plan?.length) return;

    const runningSteps = session.plan.filter((s): s is PlanItem => s.status === 'running');
    if (runningSteps.length === 0) return;
    const runningStepIds = new Set(runningSteps.map((step) => step.id));
    const shouldClearCurrentPlanStep =
      typeof session.currentPlanStepId === 'string' && runningStepIds.has(session.currentPlanStepId);

    const completedAt = Date.now();
    for (const step of runningSteps) {
      const updated: PlanItem = { ...step, status: 'completed', completedAt };
      await this.deps.sessionStore.updatePlanStepAsync(sessionId, step.id, updated);
      stream.raw('plan_step_updated', {
        stepId: step.id,
        status: 'completed',
        completedAt,
      });
      this.deps.log.info(
        { sessionId, stepId: step.id, title: step.title },
        '[ProcessMessage] Auto-completed running plan step at natural session end',
      );
    }

    if (shouldClearCurrentPlanStep) {
      await this.deps.sessionStore.updateCurrentPlanStepIdAsync(sessionId, undefined);
    }

    if (recorder) {
      await recorder.write(sessionId, turnNumber, {
        event: 'plan.running_steps_auto_completed',
        severity: 'info',
        payload: {
          stepIds: runningSteps.map((s) => s.id),
          count: runningSteps.length,
        },
        note: `Auto-completed ${runningSteps.length} running step(s) at natural session completion`,
      });
    }
  }

  private async clearBlockedReasonIfNeeded(
    sessionId: string,
    userInput: string,
    executionClaimToken?: string,
  ): Promise<string | null> {
    if (this.deps.sessionRepository?.clearBlockedReason && this.deps.sessionRepository?.getBlockedReason) {
      const currentBlockedReason = await this.deps.sessionRepository.getBlockedReason(sessionId);
      const mayClearFromUserInput = new Set(['awaiting_user']);
      if (currentBlockedReason && (userInput.trim().length === 0 || !mayClearFromUserInput.has(currentBlockedReason))) {
        return currentBlockedReason;
      }
      if (currentBlockedReason) {
        this.deps.log.info(
          { sessionId, currentBlockedReason },
          '[ProcessMessage] Applying user response: clearing blocked_reason',
        );
        try {
          if (executionClaimToken) {
            await this.deps.sessionRepository.clearBlockedReason(sessionId, currentBlockedReason, executionClaimToken);
          } else {
            await this.deps.sessionRepository.clearBlockedReason(sessionId, currentBlockedReason);
          }
          const liveSession = this.deps.sessionStore.get(sessionId);
          if (liveSession && liveSession.blockedReason === currentBlockedReason) {
            const previousStatus = deriveSessionStatusForEvent(liveSession);
            const nextFlags = { ...(liveSession.flags ?? {}) } as Record<string, unknown>;
            delete nextFlags[currentBlockedReason];
            liveSession.blockedReason = undefined;
            liveSession.flags = nextFlags;
            await this.deps.sessionStore.setAsync(sessionId, liveSession, 'blocked_reason_cleared_on_message');
            const updatedSession = this.deps.sessionStore.get(sessionId);
            if (updatedSession) {
              emitSessionStatusEvent(
                this.deps.events,
                updatedSession,
                previousStatus,
                'blocked_reason_cleared_on_message',
                this.deps.traceRecorder,
              );
            }
          }
        } catch (err) {
          this.deps.log.warn({ err, sessionId }, 'Failed to clear blocked_reason');
        }
      }
    }
    return null;
  }

  private isPreparedTurnCurrent(sessionId: string, prepared: PrepareSessionResult): boolean {
    const getCurrentTurn = this.deps.sessionStore.getCurrentTurn;
    if (typeof getCurrentTurn !== 'function') {
      return true;
    }

    const currentTurn = getCurrentTurn.call(this.deps.sessionStore, sessionId);
    if (!currentTurn?.controller?.signal) {
      return true;
    }

    return Boolean(currentTurn?.controller?.signal === prepared.turnController.signal);
  }

  private async runPreTurnChecks(
    sessionId: string,
    session: SessionState,
    prepared: PrepareSessionResult,
    executionClaimToken?: string,
  ): Promise<boolean> {
    const preTurnResult = await this.deps.preTurnChecks.execute({
      sessionId,
      session,
      turnNumber: prepared.turnNumber,
      recorder: prepared.recorder,
    });

    // Emit warnings
    for (const warning of preTurnResult.warnings) {
      prepared.turnStream.raw('warning', {
        code: warning.code,
        message: warning.message,
      });
    }
    const tokenWarning = preTurnResult.warnings.find((warning) => warning.code === 'tokens_high');
    if (tokenWarning) {
      const liveSession = this.deps.sessionStore.get(sessionId) ?? session;
      const existingNudge =
        typeof liveSession.flags?.ephemeralNudge === 'string' && liveSession.flags.ephemeralNudge.trim().length > 0
          ? liveSession.flags.ephemeralNudge.trim()
          : undefined;
      const tokenNudge = [
        'TOKEN SAFETY WARNING',
        tokenWarning.message,
        'Complete or hand off now. Avoid starting new broad work unless it is required to produce the terminal handoff.',
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n');
      liveSession.flags = {
        ...(liveSession.flags ?? {}),
        ephemeralNudge: existingNudge ? `${existingNudge}\n\n${tokenNudge}` : tokenNudge,
      };
      await this.deps.sessionStore.setAsync(sessionId, liveSession, 'token_guard.warning_nudge');
    }

    // Handle halt conditions
    if (!preTurnResult.proceed) {
      if (preTurnResult.haltReason === 'token_limit_exceeded') {
        await this.handleTokenLimitExceeded(sessionId, preTurnResult, prepared, executionClaimToken);
        return false;
      }
      if (preTurnResult.haltReason === 'scope_unverified') {
        const data = preTurnResult.haltEventData ?? {};
        const message =
          typeof data.message === 'string' && data.message.trim().length > 0
            ? data.message
            : 'Verify target ownership for this scope before continuing.';
        await this.deferPreTurnPrerequisite(
          sessionId,
          'scope_unverified',
          { ...data, message },
          prepared,
          executionClaimToken,
        );
        // Surfaced as an error so the chat client renders it instead of a
        // silently empty turn. No model call happened, so nothing was billed.
        prepared.turnStream.raw('error', {
          code: 'scope.target_unverified',
          message,
          data,
        });
        prepared.turnStream.done();
        return false;
      }
      if (preTurnResult.haltReason === 'source_review_unauthorized') {
        const data = preTurnResult.haltEventData ?? {};
        const message =
          typeof data.message === 'string' && data.message.trim().length > 0
            ? data.message
            : 'Source-review authorization could not be established for this run.';
        await this.deferPreTurnPrerequisite(
          sessionId,
          'source_review_unauthorized',
          { ...data, message },
          prepared,
          executionClaimToken,
        );
        // Same shape as the ownership halt: surfaced as an error so the client
        // renders it rather than an empty turn. No model call happened.
        prepared.turnStream.raw('error', {
          code: 'run.source_review_unauthorized',
          message,
          data,
        });
        prepared.turnStream.done();
        return false;
      }
      if (preTurnResult.haltReason === 'work_blocked') {
        prepared.turnStream.raw('warning', {
          code: 'session_blocked',
          message:
            preTurnResult.haltEventData?.reason === 'aborted_by_user'
              ? 'This run was cancelled and cannot continue.'
              : 'This session is blocked and cannot continue until it is resumed.',
          data: preTurnResult.haltEventData,
        });
        prepared.turnStream.done();
        return false;
      }
      return false;
    }

    return true;
  }

  private async deferPreTurnPrerequisite(
    sessionId: string,
    reason: string,
    meta: Record<string, unknown>,
    prepared: PrepareSessionResult,
    executionClaimToken?: string,
  ): Promise<void> {
    const session = this.deps.sessionStore.get(sessionId);
    const scheduled = await this.deps.sessionStore.recordExecutionDeferredAsync(
      sessionId,
      reason,
      new Date(Date.now() + 30_000),
      `prerequisite:${executionClaimToken ?? `turn:${session?.turn ?? 0}`}:${reason}`,
      executionClaimToken,
      { reason, meta },
    );

    if (!scheduled && this.deps.sessionRepository) {
      throw new Error(`durable_prerequisite_continuation_unavailable:${reason}`);
    }

    if (!session) return;
    const previousStatus = deriveSessionStatusForEvent(session);
    session.blockedReason = reason;
    session.blockedMeta = meta;
    stopProcessing(session, {
      reason,
      turnNumber: session.turn,
      caller: 'ProcessMessageCommand',
    });
    await this.deps.sessionStore.setAsync(sessionId, session, `prerequisite.${reason}`);
    const updatedSession = this.deps.sessionStore.get(sessionId);
    if (updatedSession) {
      emitSessionStatusEvent(
        this.deps.events,
        updatedSession,
        previousStatus,
        reason,
        prepared.recorder,
      );
    }
  }

  private async handleTokenLimitExceeded(
    sessionId: string,
    preTurnResult: { haltEventData?: Record<string, unknown> },
    prepared: PrepareSessionResult,
    executionClaimToken?: string,
  ): Promise<void> {
    const session = this.deps.sessionStore.get(sessionId);
    if (session) {
      const workerArtifact = buildTokenLimitWorkerArtifact(session, preTurnResult.haltEventData);
      if (workerArtifact) {
        const journalProjected = await this.deps.sessionStore.recordSessionCompletedAsync(
          session.id,
          'worker_token_limit_partial_result',
          executionClaimToken,
        );
        const persisted = journalProjected
          ? true
          : this.deps.sessionRepository?.setCompleted
            ? executionClaimToken
              ? await this.deps.sessionRepository.setCompleted(session.id, true, executionClaimToken)
              : await this.deps.sessionRepository.setCompleted(session.id, true)
            : false;
        if (!persisted) {
          throw new Error('durable_worker_token_limit_completion_failed');
        }
        session.workerResult = workerArtifact;
        session.summary = workerArtifact.summary;
        session.completed = true;
        session.blockedReason = undefined;
        session.pendingApproval = undefined;
        session.flags = {
          ...(session.flags ?? {}),
          session: {
            ...((session.flags?.session as Record<string, unknown> | undefined) ?? {}),
            completed: true,
            workerTokenLimitPartialResult: true,
            tokenLimit: preTurnResult.haltEventData,
          },
        };
        stopProcessing(session, {
          reason: 'worker_token_limit_partial_result',
          turnNumber: session.turn,
          caller: 'ProcessMessageCommand',
        });
        await this.deps.sessionStore.setAsync(session.id, session, 'worker_token_limit_partial_result');
        if (prepared.recorder) {
          await prepared.recorder.write(session.id, prepared.turnNumber, {
            event: 'worker.token_limit_partial_result',
            severity: 'warn',
            payload: {
              artifact: workerArtifact,
              tokenLimit: preTurnResult.haltEventData,
            },
            note: 'Worker reached the universal token safety limit; partial artifact synthesized for parent handoff.',
          });
        }
        prepared.turnStream.raw('warning', {
          code: 'worker_token_limit_partial_result',
          message: 'Worker reached the universal token safety limit; partial result was recorded for the parent.',
          data: preTurnResult.haltEventData,
        });
        prepared.turnStream.done();
        return;
      }

      const previousStatus = deriveSessionStatusForEvent(session);
      const meta = { ...preTurnResult.haltEventData };
      const journalDeferred = await this.deps.sessionStore.recordExecutionDeferredAsync(
        sessionId,
        'token_limit_exceeded',
        new Date(Date.now() + 5 * 60_000),
        `token-limit:${executionClaimToken ?? `turn:${session.turn ?? 0}`}`,
        executionClaimToken,
        { reason: 'token_limit_exceeded', meta },
      );
      session.blockedReason = 'token_limit_exceeded';
      session.blockedMeta = meta;
      stopProcessing(session, {
        reason: 'token_limit_exceeded',
        turnNumber: session.turn,
        caller: 'ProcessMessageCommand',
      });
      if (!journalDeferred && this.deps.sessionRepository) {
        throw new Error('durable_token_limit_continuation_unavailable');
      }
      await this.deps.sessionStore.setAsync(session.id, session, 'token_limit_exceeded');
      const updatedSession = this.deps.sessionStore.get(session.id);
      if (updatedSession) {
        emitSessionStatusEvent(
          this.deps.events,
          updatedSession,
          previousStatus,
          'token_limit_exceeded',
          prepared.recorder,
        );
      }
    }
    prepared.turnStream.raw('warning', {
      code: 'token_limit_exceeded',
      message: 'Session token safety limit exceeded.',
      data: preTurnResult.haltEventData,
    });
    prepared.turnStream.done();
  }

  private emitContextEvents(sessionId: string, prompt: BuildPromptResult): void {
    if (prompt.contextOverflow) {
      this.deps.events.emit(sessionId, {
        type: 'context_trimmed',
        data: prompt.contextOverflow,
      });
    }

    this.deps.events.emit(sessionId, {
      type: 'context_estimate',
      data: prompt.contextEstimate,
    });

    if (prompt.contextEstimate.percentUsed >= 80) {
      this.deps.events.emit(sessionId, {
        type: 'context_warning',
        data: {
          percentUsed: prompt.contextEstimate.percentUsed,
          estimatedTokens: prompt.contextEstimate.estimatedTokens,
          contextWindow: prompt.contextEstimate.contextWindow,
        },
      });
    }

    if (prompt.compactionResult) {
      this.deps.events.emit(sessionId, {
        type: 'context_compacted',
        data: prompt.compactionResult,
      });
    }
  }

  private async logTurnComplete(
    sessionId: string,
    prepared: PrepareSessionResult,
    turnResult: ExecuteTurnResult,
    session: SessionState,
    pendingSteps: unknown[],
  ): Promise<void> {
    if (!prepared.recorder) return;

    const completedSteps = session?.plan?.filter((s) => s.status === 'completed').length ?? 0;
    const totalSteps = session?.plan?.length ?? 0;
    const completion = describeTurnCompletion(turnResult.status);

    // Extract wide metrics if available
    const metrics = turnResult.metrics;
    const aggregatedTokens = metrics
      ? {
          input: metrics.llmInputTokens,
          output: metrics.llmOutputTokens,
          cached: metrics.llmCachedTokens,
          total: metrics.llmInputTokens + metrics.llmOutputTokens,
        }
      : turnResult.usage
        ? {
            input: turnResult.usage.promptTokens,
            output: turnResult.usage.completionTokens,
            cached: turnResult.usage.promptTokensDetails?.cachedTokens ?? 0,
            total: turnResult.usage.totalTokens,
          }
        : undefined;

    await prepared.recorder.write(sessionId, prepared.turnNumber, {
      event: 'turn.complete',
      severity: 'info',
      payload: {
        status: completion.status,
        stopReason: completion.stopReason,
        nextAction: completion.nextAction,
        messages: turnResult.messagesLength,
        toolsUsed: turnResult.toolCallCount,
        toolsRequested: turnResult.toolCallsRequested,
        toolsExecuted: turnResult.toolCallCount,
        ...(metrics ? { toolsSkipped: metrics.skippedToolCalls } : {}),
        plan:
          totalSteps > 0
            ? {
                completed: completedSteps,
                pending: pendingSteps.length,
                total: totalSteps,
              }
            : undefined,
        tokens: aggregatedTokens,
        // Wide turn metrics for analytics (consolidated view)
        ...(metrics
          ? {
              llmInputTokens: metrics.llmInputTokens,
              llmOutputTokens: metrics.llmOutputTokens,
              llmCachedTokens: metrics.llmCachedTokens,
              llmLatencyMs: metrics.llmLatencyMs,
              llmCallCount: metrics.llmCallCount,
              tools: metrics.tools,
              totalToolLatencyMs: metrics.totalToolLatencyMs,
              costUsd: metrics.costUsd,
              nativeCostUsd: metrics.nativeCostUsd,
              overheadUsd: metrics.overheadUsd,
              platformCostUsd: metrics.platformCostUsd,
              platformPriceUsd: metrics.platformPriceUsd,
              creditsUsed: metrics.creditsUsed,
              currency: metrics.currency,
            }
          : {}),
      },
      note:
        `messages = ${turnResult.messagesLength}, tools = ${turnResult.toolCallCount}/${turnResult.toolCallsRequested}` +
        `${metrics ? `, skipped=${metrics.skippedToolCalls}` : ''}` +
        `${totalSteps > 0 ? `, plan ${completedSteps}/${totalSteps}` : ''}` +
        `${metrics ? `, llmTokens=${metrics.llmInputTokens}+${metrics.llmOutputTokens}` : ''}` +
        `${metrics?.platformPriceUsd !== undefined ? `, platformPrice=${metrics.platformPriceUsd.toFixed(6)}` : ''}` +
        `${metrics?.creditsUsed !== undefined ? `, credits=${metrics.creditsUsed.toFixed(4)}` : ''}`,
    });
  }

  private async validateS3Completion(
    sessionId: string,
    hasReport: boolean,
    pendingPlanSteps: unknown[],
    prepared: PrepareSessionResult,
  ): Promise<boolean> {
    const session = this.deps.sessionStore.get(sessionId) ?? prepared.sessionState;

    if (!shouldRequireReportForSession(session)) {
      return hasReport;
    }

    if (session.mode !== 'automated' || pendingPlanSteps.length > 0 || !hasReport) {
      return hasReport;
    }

    try {
      await this.deps.artifactService.ensureReportForCompletion(sessionId);
      this.deps.log.info({ sessionId }, '[ProcessMessage] S3 report validation passed');
      return true;
    } catch (error) {
      if (error instanceof CompletionBlockedError) {
        opsMetrics.recordCompletionBlocked(error.reason);
        this.deps.log.warn(
          { sessionId, reason: error.reason, retryable: error.retryable },
          '[ProcessMessage] S3 completion validation failed',
        );

        prepared.turnStream.raw('warning', {
          code: error.retryable ? 's3_unavailable' : 'report_missing_s3',
          message: error.retryable ? 'S3 temporarily unavailable, will retry' : 'report.md not found in S3',
          retryable: error.retryable,
        });
        return false;
      }
      this.deps.log.error({ sessionId, err: error }, '[ProcessMessage] Unexpected S3 validation error');
      return hasReport;
    }
  }

  private async reconcileRunCloseout(session: SessionState): Promise<AutomatedRunCloseoutReconciliation | null> {
    if (!this.deps.runCloseoutReconciler || !session.userId || !session.workspaceDir) {
      return null;
    }

    const securityops = getSecurityOpsFlags(session);
    const runId = typeof securityops?.runId === 'string' ? securityops.runId : undefined;
    if (!runId || !session.scopeId) {
      return null;
    }

    const reportedFindingIds = Array.isArray(securityops?.reportedFindingIds)
      ? uniqueStrings(securityops.reportedFindingIds as unknown[])
      : [];
    const shellJobs = isRecord(session.flags?.shellJobs) ? session.flags.shellJobs : undefined;
    const alreadyFinalized =
      isRecord(securityops?.runCompletion) && securityops.runCompletion.state === 'completed'
        ? true
        : typeof securityops?.finalizedAt === 'string';
    const finalizedMode =
      securityops?.finalizedMode === 'interim' || securityops?.finalizedMode === 'final'
        ? securityops.finalizedMode
        : undefined;

    try {
      return await this.deps.runCloseoutReconciler.reconcileAutomatedRunCloseout({
        userId: session.userId,
        workspaceDir: session.workspaceDir,
        sessionId: session.id,
        context: getSecurityOpsContext(session),
        plan: session.plan,
        reportedFindingIds,
        shellJobs,
        alreadyFinalized,
        finalizedMode,
      });
    } catch (err) {
      this.deps.log.warn({ err, sessionId: session.id }, 'Closeout reconciliation failed');
      return null;
    }
  }

  private async persistSystemPauseForCloseout(
    session: SessionState,
    reason: string,
    runCompletion: unknown,
    executionClaimToken?: string,
  ): Promise<void> {
    const previousStatus = deriveSessionStatusForEvent(session);
    const blockedMeta = {
      reason: 'system_paused',
      code: 'closeout_pending',
      errorCode: 'closeout_pending',
      message: reason,
      retryable: true,
      recoverable: true,
      turn: session.turn,
      mode: session.mode,
    };

    try {
      const retryAt = new Date(Date.now() + 5_000);
      // One closeout request per semantic turn. Worker claim tokens are
      // disposable lease identities and must not create duplicate history.
      const attemptId = `turn-${session.turn}`;
      // Closeout intent and its wake-up are one journal transaction. The
      // blocked reason below is only a user-facing projection and may lag.
      if (executionClaimToken) {
        await this.deps.sessionStore.recordCloseoutRequestedAsync(
          session.id,
          reason,
          retryAt,
          attemptId,
          executionClaimToken,
        );
      } else {
        await this.deps.sessionStore.recordCloseoutRequestedAsync(
          session.id,
          reason,
          retryAt,
          attemptId,
        );
      }
      const blockPersisted = this.deps.sessionRepository?.setBlockedReasonIfClear
        ? await this.deps.sessionRepository.setBlockedReasonIfClear(
          session.id,
          'system_paused',
          blockedMeta,
        )
        : await this.deps.sessionRepository?.setBlockedReason(
          session.id,
          'system_paused',
          blockedMeta,
          executionClaimToken,
        );
      if (blockPersisted === false) {
        const currentReason = await this.deps.sessionRepository?.getBlockedReason(session.id);
        if (currentReason && currentReason !== 'system_paused') {
          // A concurrent operator Stop or prerequisite owns presentation. The
          // journal still remembers pending closeout and will honor Stop intent.
          return;
        }
      }
      // Materialize the cache projection only after the closeout fact and its
      // wake-up committed. A failed durable write must leave live state alone.
      const nextSession: SessionState = {
        ...session,
        flags: { ...(session.flags ?? {}) },
      };
      const nextFlags = nextSession.flags as Record<string, unknown>;
      applySecurityOpsRunCompletion(nextSession, { mode: 'interim', runCompletion });
      nextSession.completed = false;
      nextSession.blockedReason = 'system_paused';
      nextSession.blockedMeta = blockedMeta;
      const sessionFlags = isRecord(nextFlags.session) ? { ...nextFlags.session } : {};
      delete sessionFlags.completed;
      delete nextFlags.session;
      nextSession.flags = {
        ...nextFlags,
        securityops: (nextSession.flags as Record<string, unknown>).securityops,
        ...(Object.keys(sessionFlags).length > 0 ? { session: sessionFlags } : {}),
      };
      await this.deps.sessionStore.setAsync(session.id, nextSession, 'closeout.recovery_scheduled');
      const updatedSession = this.deps.sessionStore.get(session.id);
      if (updatedSession) {
        emitSessionStatusEvent(
          this.deps.events,
          updatedSession,
          previousStatus,
          'closeout_recovery_scheduled',
          this.deps.traceRecorder,
        );
      }
    } catch (err) {
      this.deps.log.error({ err, sessionId: session.id }, 'Failed to schedule closeout recovery');
      throw err;
    }
  }

  private async handleCompletionNotification(
    sessionId: string,
    turnResult: ExecuteTurnResult,
    hasReport: boolean,
    executionClaimToken?: string,
  ): Promise<void> {
    if (turnResult.status !== 'completed') return;

    const latestSession = this.deps.sessionStore.get(sessionId);
    if (!latestSession) return;

    if (!shouldRequireReportForSession(latestSession)) {
      return;
    }

    if (!hasReport) {
      return;
    }

    if (hasLiveSidecarWorkers(latestSession)) {
      this.deps.log.info({ sessionId }, 'Completion deferred because live sidecar workers are still active');
      return;
    }

    const closeout = await this.reconcileRunCloseout(latestSession);
    if (closeout?.outcome === 'paused') {
      await this.persistSystemPauseForCloseout(
        latestSession,
        closeout.reason ?? 'Run closeout is not ready yet.',
        closeout.runCompletion,
        executionClaimToken,
      );
      return;
    }
    const completed = await this.completeSessionAfterCloseout(latestSession, closeout, executionClaimToken);
    if (!completed) {
      // Let the ordinary turn-failure path append an interrupted boundary and
      // schedule recovery. Silently returning here would strand a successful
      // semantic closeout with no durable completion fact.
      throw new Error('durable_closeout_completion_failed');
    }
  }

  async recoverClaimedCloseout(sessionId: string, claimToken: string): Promise<'completed' | 'retry'> {
    const claims = this.deps.sessionRepository;
    if (!claims?.ownsExecutionClaim || !(await claims.ownsExecutionClaim(sessionId, claimToken))) {
      throw new Error('execution_claim_lost');
    }
    const latestSession =
      (await this.deps.sessionStore.getOrHydrate?.(sessionId)) ?? this.deps.sessionStore.get(sessionId);
    if (!latestSession) throw new Error('session_not_found');

    const closeout = await this.reconcileRunCloseout(latestSession);
    if (!(await claims.ownsExecutionClaim(sessionId, claimToken))) {
      throw new Error('execution_claim_lost');
    }
    if (!closeout || closeout.outcome === 'paused') {
      await this.persistSystemPauseForCloseout(
        latestSession,
        closeout?.reason ?? 'Run closeout is not ready yet.',
        closeout?.runCompletion ?? null,
        claimToken,
      );
      return 'retry';
    }

    const completed = await this.completeSessionAfterCloseout(latestSession, closeout, claimToken);
    return completed ? 'completed' : 'retry';
  }

  private async completeSessionAfterCloseout(
    latestSession: SessionState,
    closeout: AutomatedRunCloseoutReconciliation | null,
    executionClaimToken?: string,
  ): Promise<boolean> {
    const sessionId = latestSession.id;
    if (closeout) {
      applySecurityOpsRunCompletion(latestSession, {
        mode: closeout.mode,
        runCompletion: closeout.runCompletion,
      });
    }

    try {
      // The canonical fact and its rebuildable completion projection commit in
      // one transaction. The optional claim token fences stale workers.
      const journalProjectedCompletion = await this.deps.sessionStore.recordCloseoutCompletedAsync(
        sessionId,
        'reconciled',
        executionClaimToken,
      );

      // SessionStore is also constructed without persistence in focused unit
      // tests. Production always has the journal; this is only a compatibility
      // fallback for an intentionally journal-less store.
      if (!journalProjectedCompletion) {
        if (!this.deps.sessionRepository?.setCompleted) {
          throw new Error('durable_closeout_completion_writer_unavailable');
        }
        const persisted = executionClaimToken
          ? await this.deps.sessionRepository.setCompleted(sessionId, true, executionClaimToken)
          : await this.deps.sessionRepository.setCompleted(sessionId, true);
        if (!persisted) {
          throw new Error('durable_closeout_completion_failed');
        }
      }
    } catch (err) {
      this.deps.log.warn({ err, sessionId }, 'Completion blocked: failed to record durable closeout completion');
      throw err;
    }

    const nextFlags = { ...(latestSession.flags ?? {}) } as Record<string, unknown>;
    const sessionFlags = {
      ...((nextFlags['session'] as Record<string, unknown> | undefined) ?? {}),
      completed: true,
    };
    delete nextFlags['blocked_reason'];
    latestSession.flags = {
      ...nextFlags,
      session: sessionFlags,
    };
    latestSession.completed = true;
    latestSession.blockedReason = undefined;
    latestSession.pendingApproval = undefined;

    try {
      await this.deps.sessionStore.setAsync(sessionId, latestSession, 'completion_marked');
    } catch (err) {
      // The journal and DB completion projection already committed. A stale
      // process-local cache must not turn semantic success back into a retry.
      this.deps.log.warn({ err, sessionId }, 'Durable completion succeeded but live cache projection failed');
    }

    // Send notification
    if (
      latestSession.userId &&
      latestSession.mode === 'automated' &&
      shouldEmitGenericCompletionNotification(latestSession)
    ) {
      try {
        const target = buildUserNotificationTarget({
          destination: 'run_detail',
          runId: extractRunIdFromSession(latestSession),
          sessionId,
          ctaLabel: 'View report',
          data: { taskId: latestSession.task?.id },
        });
        await this.deps.notificationPort?.notify({
          userId: latestSession.userId,
          type: NotificationKinds.TASK_COMPLETED,
          title: latestSession.title || 'Task Completed',
          message: 'Your session has completed and the report is ready to view.',
          ...(target.link ? { link: target.link } : {}),
          data: target.data,
        });
        this.deps.log.info(
          { sessionId, userId: latestSession.userId },
          '[ProcessMessage] Completion notification sent',
        );
      } catch (notifyError) {
        this.deps.log.error({ err: notifyError, sessionId }, '[ProcessMessage] Failed to send notification');
      }
    }
    return true;
  }

  private async cleanupFinalizedRunWorkspaceAfterArtifacts(
    sessionId: string,
    hasSummary: boolean,
    hasReport: boolean,
  ): Promise<void> {
    const latestSession = this.deps.sessionStore.get(sessionId);
    const terminal = checkSessionTerminal(latestSession);
    if (!latestSession || terminal.kind !== 'run_finalized') {
      return;
    }

    if (shouldRequireReportForSession(latestSession) && (!hasSummary || !hasReport)) {
      this.deps.log.warn(
        { sessionId, hasSummary, hasReport },
        'Skipping finalized run workspace cleanup until closeout artifacts are durably persisted',
      );
      return;
    }

    const runId = extractRunIdFromSession(latestSession);
    if (!runId) {
      return;
    }

    try {
      await this.deps.sessionStore.cleanupRunWorkspaceAsync(runId, {
        reason: 'run_finalized_artifacts_persisted',
      });
    } catch (err) {
      this.deps.log.warn({ err, sessionId, runId }, 'Failed to clean up finalized run workspace after artifact flush');
    }
  }

  private async markAcceptedPhaseSessionCompleted(sessionId: string, executionClaimToken?: string): Promise<void> {
    const session = this.deps.sessionStore.get(sessionId);
    if (!session || !isAcceptedNonReportingPhaseHandoff(session)) {
      return;
    }

    try {
      const journalProjected = await this.deps.sessionStore.recordSessionCompletedAsync(
        sessionId,
        'phase_handoff_submitted',
        executionClaimToken,
      );
      const persisted = journalProjected
        ? true
        : this.deps.sessionRepository?.setCompleted
          ? executionClaimToken
            ? await this.deps.sessionRepository.setCompleted(sessionId, true, executionClaimToken)
            : await this.deps.sessionRepository.setCompleted(sessionId, true)
          : false;
      if (!persisted) {
        throw new Error('durable_phase_session_completion_failed');
      }
    } catch (err) {
      this.deps.log.warn({ err, sessionId }, 'Failed to set phase session completed');
      throw err;
    }

    const nextFlags = { ...(session.flags ?? {}) } as Record<string, unknown>;
    const sessionFlags = {
      ...((nextFlags.session as Record<string, unknown> | undefined) ?? {}),
      completed: true,
    };
    delete nextFlags.blocked_reason;
    session.flags = {
      ...nextFlags,
      session: sessionFlags,
    };
    session.completed = true;
    session.blockedReason = undefined;
    session.pendingApproval = undefined;

    try {
      await this.deps.sessionStore.setAsync(sessionId, session, 'phase_handoff_session_completed');
    } catch (err) {
      this.deps.log.warn({ err, sessionId }, 'Failed to persist live phase session completion state');
    }
  }

  private async handleError(
    error: unknown,
    sessionId: string,
    prepared: PrepareSessionResult | undefined,
    doneEmitted: boolean,
    executionClaimToken?: string,
  ): Promise<{ status: 'ok' | 'abort' | 'error'; doneEmitted: boolean }> {
    const sessionState = prepared?.sessionState ?? this.deps.sessionStore.get(sessionId);
    const turnNumber = prepared?.turnNumber ?? (sessionState?.turn ?? 0) + 1;
    const turnStream = prepared?.turnStream ?? new TurnStreamBroker((event) => this.deps.events.emit(sessionId, event));
    const recorder = prepared?.recorder ?? this.deps.traceRecorder;

    if (isAbortError(error, prepared?.turnController.signal)) {
      const result = await this.deps.turnErrorHandler.handleAbort({
        sessionId,
        error,
        sessionState,
        turnNumber,
        turnStream,
        recorder,
        doneEmitted,
      });
      return { status: result.status, doneEmitted: result.doneEmitted };
    } else {
      const result = await this.deps.turnErrorHandler.handleError({
        sessionId,
        error,
        sessionState,
        turnNumber,
        turnStream,
        recorder,
      });
      await this.deps.turnFailurePolicy.handleError({
        sessionId,
        error,
        sessionState,
        turnNumber,
        turnStream,
        recorder,
        modelName: sessionState?.modelName ?? this.deps.sessionStore.get(sessionId)?.modelName,
        provider: this.deps.sessionStore.get(sessionId)?.provider,
        processMessage: (sid, inp, prof) => this.execute({ sessionId: sid, userInput: inp, profileKey: prof }),
        ...(executionClaimToken ? { executionClaimToken } : {}),
      });
      return { status: result.status, doneEmitted };
    }
  }

  private async cleanup(
    sessionId: string,
    turnStartedAt: number,
    turnStatus: 'ok' | 'abort' | 'error',
    prepared?: PrepareSessionResult,
    turnOutcome?: ExecuteTurnResult['status'],
  ): Promise<void> {
    if (prepared && !this.isPreparedTurnCurrent(sessionId, prepared)) {
      this.deps.log.info(
        { sessionId, turnNumber: prepared.turnNumber, turnStatus },
        '[ProcessMessage] Skipped stale turn cleanup after current turn changed',
      );
      const durationMs = Date.now() - turnStartedAt;
      opsMetrics.recordTurn(turnStatus, durationMs);
      return;
    }

    if (prepared) {
      const latest = this.deps.sessionStore.get(sessionId);
      await this.deps.sessionStore.finishJournalTurnAsync?.(
        sessionId,
        prepared.turnNumber,
        turnStatus === 'ok' && (turnOutcome === 'completed' || latest?.completed === true)
          ? 'completed'
          : 'interrupted',
        turnOutcome ?? turnStatus,
      );
    }

    await this.deps.sessionStore.clearCurrentTurnAsync(sessionId);

    const latestSession = this.deps.sessionStore.get(sessionId);
    if (latestSession) {
      const previousStatus = deriveSessionStatusForEvent(latestSession);
      const currentState = latestSession.stateMachine?.getState?.();
      let shouldPersist = false;

      if (turnStatus === 'ok') {
        this.deps.turnFailurePolicy.clearRetryState(latestSession);
        shouldPersist = true;
      }

      // Stop may already have moved the session back to idle before the
      // in-flight turn unwinds. Avoid issuing a second idle -> idle transition here.
      if (currentState !== 'idle') {
        stopProcessing(latestSession, {
          reason: 'finally_block',
          turnNumber: latestSession.turn,
          caller: 'ProcessMessageCommand',
        });
        shouldPersist = true;
      }

      if (shouldPersist) {
        await this.deps.sessionStore.setAsync(latestSession.id, latestSession);
        const updatedSession = this.deps.sessionStore.get(latestSession.id);
        if (updatedSession) {
          const nextStatus = deriveSessionStatusForEvent(updatedSession);
          if (nextStatus !== previousStatus) {
            emitSessionStatusEvent(
              this.deps.events,
              updatedSession,
              previousStatus,
              `turn_cleanup:${turnStatus}`,
              this.deps.traceRecorder,
            );
          }
        }
      }
    }

    const durationMs = Date.now() - turnStartedAt;
    opsMetrics.recordTurn(turnStatus, durationMs);
  }
}
