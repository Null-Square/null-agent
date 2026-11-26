/**
 * Pipeline Stage Types
 * @module agent-brain/application/orchestration/stages/types
 */

import type OpenAI from 'openai';
import type { SessionStore } from '../../core/SessionStore';
import type { SessionEventPublisher, ContextProviderPort, ToolRegistryPort, SandboxHealthPort } from '../../../ports';
import type { ContextBlocks } from '../../../domain/types';
import type { Message, MessageMetadata, SessionState, StreamEvent } from '../../../domain/types';
import type {
  CacheCoordinatorPort,
  PolicyResolverPort,
  PromptBuilderPort,
  TurnExecutorPort,
  ModelPromptProfilePort,
} from '../../../ports';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import { type StreamBroker } from '../streaming/StreamBroker';
import type { ContextMeasurementHints } from '../../../domain/context';
import type { HistoryTransformationPort } from '../../../ports/HistoryTransformationPort';

// ============================================================================
// Prepare Stage Types
// ============================================================================

export type PrepareSessionArgs = {
  sessionId: string;
  userInput: string;
  profileKey?: string;
  extraContext?: string;
  messageMetadata?: MessageMetadata;
  sessionStore: SessionStore;
  policyResolver: PolicyResolverPort;
  events: SessionEventPublisher;
  traceRecorder?: SessionTraceRecorder;
  streamFactory: (emit: (event: StreamEvent) => void) => StreamBroker;
  /** Optional health checker - if provided and session has containerId, will verify sandbox is healthy */
  sandboxHealthChecker?: SandboxHealthPort;
};

export type PrepareSessionResult = {
  sessionState: SessionState;
  turnNumber: number;
  turnController: AbortController;
  turnStream: StreamBroker;
  initialPendingPlanStepIds: Set<string>;
  userMessage?: Message;
  recorder?: SessionTraceRecorder;
};

// ============================================================================
// Build Stage Types
// ============================================================================

export type BuildPromptArgs = {
  session: SessionState;
  turnNumber: number;
  contextProvider: ContextProviderPort;
  promptBuilder: PromptBuilderPort;
  cacheCoordinator: CacheCoordinatorPort;
  toolsRegistry: ToolRegistryPort;
  /**
   * Narrowed to the five credential-free members prompt assembly actually uses. A `ChatProvider`
   * still satisfies it structurally, so the API path is unchanged; what the narrowing buys is that
   * a runtime with no API key can build a prompt, which is the whole reason the seam is split.
   */
  provider: ModelPromptProfilePort;
  traceRecorder?: SessionTraceRecorder;
  convertMessages: (messages: Message[]) => OpenAI.Chat.ChatCompletionMessageParam[];
  maxToolCalls: number;
  /** Model name for the session, used for compaction summarization */
  modelName: string;
  abortSignal?: AbortSignal;
  executeModelCall?: TurnExecutorPort['executeModelCall'];
  /** Durable reducer transaction store resolved for the active product host. */
  historyTransformationPort?: HistoryTransformationPort;
  /** Why this build is allowed to reduce history. Overflow is forced exactly once by the caller. */
  compactionReason?: 'soft_threshold' | 'provider_context_overflow';
  /** The failed E4 request that triggered provider-overflow recovery. */
  triggerRequestId?: string;
  /** Durable run identity copied into the transformation record. */
  runId?: string;
  stepId?: string;
  /** Deterministic crash seam used by the assembled restart matrix. */
  historyTransformationFault?: (
    point: 'after_prepare' | 'after_replacement_persisted_before_activation' | 'after_activation',
    transactionId: string,
  ) => void | Promise<void>;
};

export type BuildPromptResult = {
  contextEnvelope: ContextBlocks;
  systemMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  historyMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  toolDefinitions: OpenAI.Chat.ChatCompletionTool[];
  contextMeasurementHints?: ContextMeasurementHints;
  transformationRefs?: string[];
  /**
   * A newly activated durable compaction. This is kept separate from the
   * client-facing compaction metrics so the full summary is only handed to
   * the session journal boundary.
   */
  activatedCompaction?: {
    transactionId: string;
    throughMessageId: string;
    summaryMessage: Message;
  };
  /** If messages were trimmed due to context limits, this contains overflow info for SSE notification */
  contextOverflow?: {
    droppedMessages: number;
    keptMessages: number;
    usedTokens: number;
    tokenBudget: number;
    percentUsed: number;
  };
  /** Real-time context estimate for live CTX bar updates (emitted BEFORE LLM call) */
  contextEstimate: {
    estimatedTokens: number;
    contextWindow: number;
    maxHistoryTokens: number;
    percentUsed: number;
    budget?: {
      effectiveWindow: number;
      maxOutputReserve: number;
      systemTokens: number;
      staticPromptTokens: number;
      softContextTokens: number;
      dynamicPromptTokens: number;
      toolSchemaTokens: number;
      historyTokens: number;
      toolResultTokens: number;
      toolResultTokensByTool?: Record<string, number>;
      toolResultsPersistedToDisk?: number;
      toolResultPersistedSavedTokens?: number;
      aggregateBudgetEnforcements?: number;
      aggregateBudgetOverageTokensBefore?: number;
      aggregateBudgetOverageTokensAfter?: number;
      toolResultPolicyVersion?: string;
      currentUserTokens: number;
      totalPromptEstimate: number;
      promptOverheadTokens: number;
      autoCompactThreshold: number;
      microcompactedToolResults: number;
      microcompactionSavedTokens: number;
    };
  };
  /** If auto-compaction occurred, this contains info for SSE notification */
  compactionResult?: {
    beforeTokens: number;
    afterTokens: number;
    messagesSummarized: number;
    findingsPreserved: number;
    techniquesPreserved: number;
    approachesPreserved: number;
    credentialsPreserved: number;
    openStepsPreserved: number;
    discoveriesPreserved: number;
    constraintsPreserved: number;
    compactionVersion: number;
  };
};

export type ExecuteTurnResult = Awaited<ReturnType<TurnExecutorPort['runTurn']>>;

// ============================================================================
// Reconcile Stage Types
// ============================================================================

export type ReconcilePlanArgs = {
  sessionId: string;
  turnNumber: number;
  initialPendingPlanStepIds: Set<string>;
  turnStatus: ExecuteTurnResult['status'];
  stream: StreamBroker;
  recorder?: SessionTraceRecorder;
  sessionStore: SessionStore;
};

export type ReconcilePlanResult = {
  pendingSteps: { id: string; title?: string; status?: string }[];
};

// ============================================================================
// Stage Interfaces
// ============================================================================

export interface PrepareStage {
  run(args: PrepareSessionArgs): Promise<PrepareSessionResult>;
}

export interface BuildStage {
  run(args: BuildPromptArgs): Promise<BuildPromptResult>;
}

export interface ReconcileStage {
  run(args: ReconcilePlanArgs): Promise<ReconcilePlanResult>;
}
