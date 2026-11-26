import type OpenAI from 'openai';
import type { Message, MessageMetadata } from '../../domain/types';
import { attachProviderReasoning, getProviderReasoningFromMetadata } from '../../domain/reasoning/providerReasoning';
import type { CheckpointManager } from '../core/CheckpointManager';
import type { SessionStore } from '../core/SessionStore';
import type {
  ToolRegistryPort,
  SessionEventPublisher,
  ContextProviderPort,
  NotificationPort,
  CacheCoordinatorPort,
  PolicyResolverPort,
  PromptBuilderPort,
  ProviderFactoryPort,
  TurnExecutorPort,
  UsageTrackerPort,
  UsageStorePort,
  ScopeVerificationPort,
  ArtifactServicePort,
  HistoryTransformationPort,
} from '../../ports';
import { ApiModelExecutionResolver } from '../../adapters/execution/ApiModelExecutionResolver';
import {
  executionResolverForProfile,
  readSessionExecutionProfile,
  registeredExecutionRuntime,
} from '../../domain/runtime/ExecutionRuntimeRegistry';
import type {
  ModelExecutionPort,
  ModelExecutionResolverPort,
  ModelPromptProfilePort,
} from '../../ports/modelExecution';
import { TurnRunner } from './execution/TurnRunner';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { ResolvedConfig } from '@/config/configTypes';
import { CacheCoordinator } from './services/CacheCoordinator';
import { PromptComposer } from './services/PromptComposer';
import {
  DefaultBuildStage,
  DefaultPrepareStage,
  DefaultReconcileStage,
  type BuildStage,
  type PrepareStage,
  type ReconcileStage,
} from './stages';
import type { TurnRunnerDeps } from './types';

import { logger } from '@/shared/logger';
import type { SandboxHealthPort } from '../../ports';
import type { PolicyResolver } from '../../domain/policy';
import { AutomationModePolicy } from '../services/AutomationModePolicy';
import { PolicyEngine } from '../services/PolicyEngine';
import type { PolicyTelemetry } from '@/shared/telemetry/PolicyTelemetry';
import type { TokenGuard } from '../services/TokenGuard';

import { PreTurnChecks } from './services/PreTurnChecks';
import { WorkContinuationGuard } from './services/WorkContinuationGuard';
import { TurnErrorHandler } from './services/TurnErrorHandler';
import { AutomationGuardHandler } from './services/AutomationGuardHandler';
import { TurnFailurePolicy } from './services/TurnFailurePolicy';
import { ProcessMessageCommand } from './commands/ProcessMessageCommand';
import { HandleApprovalResumeCommand } from './commands/HandleApprovalResumeCommand';
import { SessionLifecycleService } from '../services/SessionLifecycleService';
import { SecurityOpsToolService } from '@/domains/security-ops/tools/SecurityOpsToolService';
import { db } from '@/db/client';

const DEFAULT_MAX_TOOL_CALLS = 64;

export interface OrchestratorOptions {
  maxToolCallsPerTurn?: number;
  events: SessionEventPublisher;
  sessionStore: SessionStore;
  toolsRegistry: ToolRegistryPort;
  contextProvider: ContextProviderPort;
  usageTracker?: UsageTrackerPort;
  artifactService: ArtifactServicePort;
  usageStore?: UsageStorePort;
  scopeVerificationPort?: ScopeVerificationPort;
  tracesS3?: TurnRunnerDeps['tracesS3'];
  traceRecorder?: SessionTraceRecorder;
  config?: ResolvedConfig;
  policyResolver?: PolicyResolverPort;
  promptBuilder?: PromptBuilderPort;
  cacheCoordinator?: CacheCoordinatorPort;
  turnExecutor?: TurnExecutorPort;
  providerFactory: ProviderFactoryPort;
  /**
   * Which runtime answers. Defaults to the API resolver built from `providerFactory`, so a caller
   * that does not pass one gets exactly today's behaviour. Only a composition root may pass
   * anything else (I8) — there is deliberately no way to reach this from a request field.
   */
  modelExecutionResolver?: ModelExecutionResolverPort;
  policyResolverInstance?: PolicyResolver;
  policyFacade?: PolicyEngine;
  automationPolicy?: AutomationModePolicy;
  prepareStage?: PrepareStage;
  buildStage?: BuildStage;
  reconcileStage?: ReconcileStage;
  policyTelemetry?: PolicyTelemetry;
  notificationPort?: NotificationPort;
  checkpointManager?: CheckpointManager;
  tokenGuard: TokenGuard;
  modelRequestPort?: TurnRunnerDeps['modelRequestPort'];
  runtimeHostCapabilities?: TurnRunnerDeps['runtimeHostCapabilities'];
  historyTransformationPort?: HistoryTransformationPort;

  /** Optional: sandbox health checker for pre-turn validation */
  sandboxHealthChecker?: SandboxHealthPort;
  /** Optional persistence for session coordination projections. */
  sessionRepository?: {
    setBlockedReason: (
      id: string,
      reason: string,
      meta?: Record<string, unknown>,
      executionClaimToken?: string,
    ) => Promise<boolean>;
    setBlockedReasonIfClear?: (id: string, reason: string, meta?: Record<string, unknown>) => Promise<boolean>;
    clearBlockedReason: (id: string, expectedReason?: string, executionClaimToken?: string) => Promise<boolean>;
    getBlockedReason: (id: string) => Promise<string | null>;
    setCompleted: (id: string, completed: boolean, executionClaimToken?: string) => Promise<boolean>;
    getCompleted: (id: string) => Promise<boolean>;
    touchLastActive?: (id: string, timestamp?: Date) => Promise<void>;
    acquireExecutionClaim: (params: { sessionId: string; claimToken: string; expiresAt: Date }) => Promise<boolean>;
    renewExecutionClaim: (params: { sessionId: string; claimToken: string; expiresAt: Date }) => Promise<boolean>;
    ownsExecutionClaim: (sessionId: string, claimToken: string) => Promise<boolean>;
    releaseExecutionClaim: (sessionId: string, claimToken: string) => Promise<boolean>;
  };
}

export class OrchestratorAdapter {
  private readonly maxToolCallsPerTurn: number;
  private readonly events: SessionEventPublisher;
  private readonly sessionStore: SessionStore;
  private readonly toolsRegistry: ToolRegistryPort;
  private readonly contextProvider: ContextProviderPort;
  private readonly toolMessageMaxChars = 6000;
  private readonly toolMessageHead = 3500;
  private readonly toolMessageTail = 2000;
  private readonly turnExecutor: TurnExecutorPort;
  private readonly cacheCoordinator: CacheCoordinatorPort;
  private readonly policyResolver: PolicyResolverPort;
  private readonly promptBuilder: PromptBuilderPort;
  private readonly providerFactory: ProviderFactoryPort;
  private readonly prepareStage: PrepareStage;
  private readonly buildStage: BuildStage;
  private readonly reconcileStage: ReconcileStage;
  private readonly automationPolicy: AutomationModePolicy;

  private readonly apiModelExecutionResolver: ModelExecutionResolverPort;

  /**
   * The prompt profile for a model. Credential-free by construction — `BuildStage` needs
   * capabilities, system-message assembly and error mapping, and nothing that holds a key.
   */
  private async getPromptProfile(
    sessionId: string,
    modelName: string,
    modelId?: string,
  ): Promise<ModelPromptProfilePort> {
    const resolver = await this.executionResolver(sessionId);
    const resolved = await resolver.resolve(modelName.trim(), modelId);
    return resolved.promptProfile;
  }

  /** The dispatch surface for a model. Caching belongs to the resolver, not to this class. */
  private async getModelExecution(sessionId: string, modelName: string, modelId?: string): Promise<ModelExecutionPort> {
    const resolver = await this.executionResolver(sessionId);
    const resolved = await resolver.resolve(modelName.trim(), modelId);
    return resolved.execution;
  }

  private executionResolver(sessionId: string): Promise<ModelExecutionResolverPort> {
    const profile = readSessionExecutionProfile(this.sessionStore.get(sessionId)?.flags);
    return executionResolverForProfile(profile, this.apiModelExecutionResolver);
  }

  /**
   * Close provider-owned state for a terminal host session. This is intentionally separate from
   * SessionStore removal: completed run sessions remain queryable, while their external lanes must
   * not remain alive.
   */
  async releaseExecutionSession(sessionId: string): Promise<void> {
    const resolver = await this.executionResolver(sessionId);
    await resolver.releaseSession?.(sessionId);
  }
  private readonly traceRecorder?: SessionTraceRecorder;
  private readonly log = logger.child({ scope: 'OrchestratorAdapter' });
  private readonly sandboxHealthChecker?: SandboxHealthPort;
  private readonly preTurnChecks: PreTurnChecks;
  private readonly turnErrorHandler: TurnErrorHandler;
  private readonly automationGuardHandler: AutomationGuardHandler;
  private readonly turnFailurePolicy: TurnFailurePolicy;
  private readonly artifactService: ArtifactServicePort;
  private readonly sessionRepository?: OrchestratorOptions['sessionRepository'];
  private readonly processMessageCommand: ProcessMessageCommand;
  private readonly handleApprovalResumeCommand: HandleApprovalResumeCommand;

  constructor(options: OrchestratorOptions) {
    const runtimeConfig = options.config?.runtime;

    this.maxToolCallsPerTurn =
      options.maxToolCallsPerTurn ?? runtimeConfig?.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS;
    this.events = options.events;
    this.sessionStore = options.sessionStore;
    this.toolsRegistry = options.toolsRegistry;
    this.contextProvider = options.contextProvider;
    this.traceRecorder = options.traceRecorder;

    this.providerFactory = options.providerFactory;
    // One truth per process: a registered runtime governs orchestration too, so a session cannot
    // be admitted under one runtime and executed under another (I8).
    this.apiModelExecutionResolver =
      options.modelExecutionResolver ??
      registeredExecutionRuntime() ??
      new ApiModelExecutionResolver(options.providerFactory);
    // Providers/model streams are lazily initialized per model name to support DB lookup.

    // Provider and ModelStream are lazily initialized via getProvider()/getModelStream()
    // to support async model lookup from DB

    // IMPORTANT: Assign sessionRepository BEFORE TurnRunner creation so it's available in deps
    this.sessionRepository = options.sessionRepository;
    this.log.info(
      {
        hasRepo: Boolean(this.sessionRepository),
        hasSetBlocked: Boolean(this.sessionRepository?.setBlockedReason),
      },
      '[Orchestrator] Constructor: sessionRepository check',
    );

    const tokenGuard = options.tokenGuard;
    const workContinuationGuard = new WorkContinuationGuard({
      sessionStore: this.sessionStore,
      sessionRepository: this.sessionRepository,
    });
    const defaultTurnRunner = new TurnRunner({
      model: null, // Lazily set via setModelStream before turn execution
      toolsRegistry: this.toolsRegistry,
      sessionStore: this.sessionStore,
      events: this.events,
      maxToolCalls: this.maxToolCallsPerTurn,
      modelName: 'unknown',
      usageTracker: options.usageTracker,
      usageStore: options.usageStore,
      tracesS3: options.tracesS3,
      sessionRepository: this.sessionRepository, // Pass through for blocked_reason persistence
      checkpointManager: options.checkpointManager,
      checkpointIntervalToolCalls: options.config?.automation?.checkpointIntervalToolCalls,
      tokenGuard,
      workContinuationGuard,
      notificationPort: options.notificationPort,
      modelRequestPort: options.modelRequestPort,
      runtimeHostCapabilities: options.runtimeHostCapabilities,
    });

    this.turnExecutor = options.turnExecutor ?? defaultTurnRunner;
    if (options.policyResolver) {
      this.policyResolver = options.policyResolver;
    } else if (options.policyFacade) {
      this.policyResolver = options.policyFacade;
    } else {
      this.policyResolver = options.policyResolverInstance
        ? new PolicyEngine(options.config, options.policyResolverInstance, options.policyTelemetry)
        : {
            resolve: async () => {
              throw new Error('policy.resolver_uninitialized');
            },
          };
    }
    if (options.promptBuilder) {
      this.promptBuilder = options.promptBuilder;
    } else {
      this.promptBuilder = new PromptComposer();
    }
    this.cacheCoordinator = options.cacheCoordinator ?? new CacheCoordinator();
    this.artifactService = options.artifactService;
    this.prepareStage = options.prepareStage ?? new DefaultPrepareStage();
    this.buildStage = options.buildStage ?? new DefaultBuildStage();
    this.reconcileStage = options.reconcileStage ?? new DefaultReconcileStage();
    this.automationPolicy =
      options.automationPolicy ??
      new AutomationModePolicy({
        maxGuardRetries: options.config?.automation?.maxGuardRetries,
        requireReport: options.config?.automation?.requireReport,
        reportMinLength: options.config?.automation?.reportMinLength,
      });
    this.sandboxHealthChecker = options.sandboxHealthChecker;
    // sessionRepository already assigned above (before TurnRunner creation)
    this.preTurnChecks = new PreTurnChecks({
      sandboxHealthChecker: this.sandboxHealthChecker,
      scopeVerificationPort: options.scopeVerificationPort,
      tokenGuard,
      workContinuationGuard,
    });
    this.turnErrorHandler = new TurnErrorHandler({
      sessionStore: this.sessionStore,
      traceRecorder: this.traceRecorder,
    });
    this.automationGuardHandler = new AutomationGuardHandler({
      sessionStore: this.sessionStore,
      automationPolicy: this.automationPolicy,
      sessionRepository: options.sessionRepository,
      notificationPort: options.notificationPort,
    });
    const sessionLifecycle = SessionLifecycleService.forOrchestration({
      sessionStore: this.sessionStore,
      sessionRepository: options.sessionRepository,
      notificationPort: options.notificationPort,
      events: this.events,
    });
    this.turnFailurePolicy = new TurnFailurePolicy({
      sessionStore: this.sessionStore,
      sessionLifecycle,
      retryScheduler: {
        scheduleRetry: (params) => this.automationGuardHandler.scheduleRetry(params),
      },
    });

    // Initialize ProcessMessageCommand with all dependencies
    this.processMessageCommand = new ProcessMessageCommand({
      sessionStore: this.sessionStore,
      events: this.events,
      traceRecorder: this.traceRecorder,
      prepareStage: this.prepareStage,
      buildStage: this.buildStage,
      reconcileStage: this.reconcileStage,
      contextProvider: this.contextProvider,
      cacheCoordinator: this.cacheCoordinator,
      toolsRegistry: this.toolsRegistry,
      policyResolver: this.policyResolver,
      promptBuilder: this.promptBuilder,
      turnExecutor: this.turnExecutor,
      preTurnChecks: this.preTurnChecks,
      turnErrorHandler: this.turnErrorHandler,
      automationGuardHandler: this.automationGuardHandler,
      turnFailurePolicy: this.turnFailurePolicy,
      artifactService: this.artifactService,
      sandboxHealthChecker: this.sandboxHealthChecker,
      getProvider: (sessionId, modelName, modelId) => this.getPromptProfile(sessionId, modelName, modelId),
      getModelStream: (sessionId, modelName, modelId) => this.getModelExecution(sessionId, modelName, modelId),
      maxToolCalls: this.maxToolCallsPerTurn,
      convertMessages: (messages) => this.convertToOpenAIMessages(messages),
      log: this.log,
      sessionRepository: options.sessionRepository,
      notificationPort: options.notificationPort,
      historyTransformationPort: options.historyTransformationPort,
      runCloseoutReconciler: new SecurityOpsToolService({ db }),
    });

    // Initialize HandleApprovalResumeCommand
    this.handleApprovalResumeCommand = new HandleApprovalResumeCommand({
      sessionStore: this.sessionStore,
      events: this.events,
      toolsRegistry: this.toolsRegistry,
      traceRecorder: this.traceRecorder,
      log: this.log,
      processMessage: (sid, inp, prof) => this.processMessage(sid, inp, prof),
      processClaimedMessage: (sid, claimToken, inp, prof) =>
        this.processClaimedMessage(sid, claimToken, inp, prof),
      ...(options.sessionRepository?.ownsExecutionClaim
        ? {
            ownsExecutionClaim: (sid: string, claimToken: string) =>
              options.sessionRepository!.ownsExecutionClaim(sid, claimToken),
          }
        : {}),
    });

    this.log.info(
      {
        maxToolCalls: this.maxToolCallsPerTurn,
      },
      '[Orchestrator] initialized',
    );
  }

  async processMessage(
    sessionId: string,
    userInput: string,
    profileKey?: string,
    extraContext?: string,
    messageMetadata?: MessageMetadata,
  ): Promise<void> {
    return this.processMessageCommand.execute({
      sessionId,
      userInput,
      profileKey,
      extraContext,
      messageMetadata,
    });
  }

  async processClaimedMessage(
    sessionId: string,
    claimToken: string,
    userInput = '',
    profileKey?: string,
    extraContext?: string,
    messageMetadata?: MessageMetadata,
  ): Promise<void> {
    return this.processMessageCommand.execute({
      sessionId,
      userInput,
      profileKey,
      extraContext,
      messageMetadata,
      executionClaimToken: claimToken,
      retainExecutionClaim: true,
    });
  }

  async recoverClaimedCloseout(sessionId: string, claimToken: string): Promise<'completed' | 'retry'> {
    return this.processMessageCommand.recoverClaimedCloseout(sessionId, claimToken);
  }

  /**
   * Handle approval resume after server restart.
   * Called when a stored approval is granted and there's no in-memory callback.
   *
   * This executes the approved tool, injects the result into message history,
   * and continues the turn without re-running the LLM.
   */
  async handleApprovalResume(
    sessionId: string,
    approval: {
      actionId: string;
      toolCallId?: string;
      modelRequestId?: string;
      toolName: string;
      args?: Record<string, unknown>;
    },
  ): Promise<void> {
    return this.handleApprovalResumeCommand.execute({ sessionId, approval });
  }

  async handleClaimedApprovalResume(
    sessionId: string,
    claimToken: string,
    approval: {
      actionId: string;
      toolCallId: string;
      modelRequestId?: string;
      toolName: string;
      args?: Record<string, unknown>;
    },
  ): Promise<void> {
    return this.handleApprovalResumeCommand.execute({
      sessionId,
      approval,
      executionClaimToken: claimToken,
      durablyGranted: true,
    });
  }

  /**
   * Convert internal Message format to OpenAI API format.
   *
   * NOTE: Message sanitization (orphan handling, ordering) is done by
   * TurnStreamController.sanitizeToolOrdering() BEFORE messages reach here.
   * This function only handles format conversion.
   */
  private convertToOpenAIMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    // Deduplicate consecutive identical messages
    const deduped: Message[] = [];
    for (const msg of messages) {
      const prev = deduped[deduped.length - 1];
      const prevToolCallId = prev?.toolCallId ?? prev?.tool_call_id;
      const msgToolCallId = msg.toolCallId ?? msg.tool_call_id;
      if (prev && prev.role === msg.role && prev.content === msg.content && prevToolCallId === msgToolCallId) {
        continue;
      }
      deduped.push(msg);
    }

    return deduped.map((msg) => {
      if (msg.role === 'user') {
        return {
          role: msg.role,
          content: msg.content,
        };
      }
      if (msg.role === 'assistant') {
        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: msg.content,
        };
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          assistantMsg.tool_calls = msg.tool_calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: {
              name: call.function.name,
              arguments: call.function.arguments ?? '{}',
            },
          }));
        }
        return attachProviderReasoning(assistantMsg, getProviderReasoningFromMetadata(msg.metadata));
      }
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: this.trimToolContent(msg.content),
          tool_call_id: msg.toolCallId ?? msg.tool_call_id ?? 'unknown',
        } as OpenAI.Chat.ChatCompletionToolMessageParam;
      }
      return {
        role: msg.role as 'system',
        content: msg.content,
      };
    });
  }

  private trimToolContent(content: string): string {
    if (!content || content.length <= this.toolMessageMaxChars) {
      return content;
    }
    const overflow = content.length - this.toolMessageMaxChars;
    const head = content.slice(0, this.toolMessageHead);
    const tail = this.toolMessageTail > 0 ? content.slice(-this.toolMessageTail) : '';
    return `${head}\n\n[trimmed ${overflow.toLocaleString()} chars of tool output]\n\n${tail}`;
  }
}
