import path from 'path';
import type { ResolvedConfig } from '@/config/configTypes';
import { getDefaultSandboxImage, loadSandboxProfilesConfig } from '@/config/sandboxProfilesConfig';
import {
  ContextGatewayAdapter,
  SandboxManagerAdapter,
  StreamBrokerAdapter,
  TelemetryRecorderAdapter,
  ToolsRegistryAdapter,
} from '@/domains/agent-brain/adapters';
import type { ArtifactRepository } from '@/domains/agent-brain/adapters/persistence';
import { PolicyConfigRepositoryAdapter } from '@/domains/agent-brain/adapters/PolicyConfigRepositoryAdapter';
import { ProviderFactoryAdapter } from '@/domains/agent-brain/adapters/providers/ProviderFactoryAdapter';
import { ToolExecutionAdapter } from '@/domains/agent-brain/adapters/ToolExecutionAdapter';
import { ModelRequestAdapter } from '@/domains/agent-brain/adapters/ModelRequestAdapter';
import { HistoryTransformationAdapter } from '@/domains/agent-brain/adapters/HistoryTransformationAdapter';
import { SandboxProfileRegistry, type SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';
import { ToolsRegistry } from '@/domains/agent-brain/adapters/tools/ToolsRegistry';
import { createToolEntitlementGuard } from '@/domains/agent-brain/adapters/tools/ToolEntitlementGuard';
import type { AgentBrainPorts } from '@/domains/agent-brain/application/core/AgentBrainPorts';
import { CheckpointManager } from '@/domains/agent-brain/application/core/CheckpointManager';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';
import { AgentEngine } from '@/domains/agent-brain/application/orchestration/AgentEngine';
import { OrchestratorAdapter } from '@/domains/agent-brain/application/orchestration/OrchestratorAdapter';
import { PolicyEngine } from '@/domains/agent-brain/application/services/PolicyEngine';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools/ToolPolicyChecker';
import { ToolLifecycleHookRegistry } from '@/domains/agent-brain/application/tools/ToolLifecycleHooks';
import { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';
import { PolicyResolver } from '@/domains/agent-brain/domain/policy';
import { ArtifactService } from '@/domains/agent-brain/infrastructure/artifacts/ArtifactService';
import type { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';
import type {
  ArtifactServicePort,
  ModelConfigPort,
  NotificationPort,
  ScopeVerificationPort,
  SessionEventJournalPort,
  SessionRepositoryPort,
  UsageStorePort,
  WorkspaceManager,
} from '@/domains/agent-brain/ports';
import { db } from '@/db/client';
import { createAgentServices } from '@/app/services/agent/createAgentServices';
import {
  createModelConfigPort,
  createScopeVerificationPort,
} from '@/app/adapters/portFactories';
import { ModelService } from '@/domains/platform/models/ModelService';
import { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { notifyAppEvent } from '@/domains/platform/notifications/notificationService';
import { UsageTracker } from '@/domains/platform/subscriptions/infrastructure/usageTracker';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import { OpsPolicyTelemetry, type PolicyTelemetry } from '@/shared/telemetry/PolicyTelemetry';
import { isVerboseSessionLoggingEnabled } from '@/shared/logging/sessionLogging';
import type { DIContainer } from '../container';
import { TOKENS } from '../tokens';
import type { S3Bundle, SessionPersistenceBundle } from './storage';
import type { RuntimeHostCapabilities } from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';

export const createStreamBroker = (): StreamBroker => new StreamBroker();

export const createUsageTracker = (): UsageTracker => new UsageTracker();

export const createModelService = (): ModelService => new ModelService();

export const createSandboxProfileRegistry = async (): Promise<SandboxProfileRegistry> => {
  const profilesConfig = await loadSandboxProfilesConfig();
  const defaultImage = getDefaultSandboxImage(profilesConfig);
  const sandboxProfiles: Record<string, string> = {
    ...profilesConfig.profiles,
    default: defaultImage,
  };

  return new SandboxProfileRegistry({
    sandboxProfiles,
  });
};

export const createCheckpointManager = (
  sessionStore: SessionStore,
  streamBroker: StreamBroker,
  traceRecorder: SessionTraceRecorder,
): CheckpointManager => new CheckpointManager(sessionStore, streamBroker, traceRecorder);

export const createToolsRegistry = (
  streamBroker: StreamBroker,
  sessionStore: SessionStore,
  sandboxAdapter: SandboxAdapter,
  checkpointManager: CheckpointManager,
  traceRecorder: SessionTraceRecorder,
  config: ResolvedConfig,
  policyChecker?: ToolPolicyChecker,
  runtimeHostCapabilities?: RuntimeHostCapabilities,
): ToolsRegistry => {
  const toolLifecycleHooks = new ToolLifecycleHookRegistry();
  toolLifecycleHooks.register(createToolEntitlementGuard({
    accessControl: new AccessControlService(),
    automationService: new AutomationService({ db }),
    modelConfigPort: createModelConfigPort(),
  }));

  return new ToolsRegistry(
    streamBroker,
    sessionStore,
    sandboxAdapter,
    checkpointManager,
    traceRecorder,
    {
      toolsDir: config.manifests.toolsDir,
      devWatch: config.manifests.toolDevWatch,
      config,
      toolExecutionDb: new ToolExecutionAdapter(db),
      policyChecker,
      toolLifecycleHooks,
      runtimeHostCapabilities,
    },
  );
};

export const createArtifactService = (
  sessionStore: SessionStore,
  artifactRepository: ArtifactRepository | undefined,
  s3Bundle: S3Bundle,
  artifactStorageRoot?: string,
  config?: ResolvedConfig,
): ArtifactServicePort => {
  const resolvedStorageRoot =
    artifactStorageRoot ?? config?.workspace.artifactStorageRoot ?? path.join('storage', 'artifacts');
  return new ArtifactService(
    sessionStore,
    artifactRepository,
    resolvedStorageRoot,
    artifactRepository && s3Bundle.s3Client
      ? { bucket: s3Bundle.s3ArtifactsBucket, client: s3Bundle.s3Client }
      : undefined,
    config,
    // pass config for limits if needed
  );
};

export const createPorts = (
  toolsRegistry: ToolsRegistry,
  sandboxManager: SandboxAdapter,
  traceRecorder: SessionTraceRecorder,
  streamBroker: StreamBroker,
): AgentBrainPorts => {
  const sandboxAdapter = new SandboxManagerAdapter(sandboxManager);
  return {
    context: new ContextGatewayAdapter(traceRecorder),
    tools: new ToolsRegistryAdapter(toolsRegistry),
    sandbox: { provision: sandboxAdapter, runtime: sandboxAdapter },
    telemetry: traceRecorder ? new TelemetryRecorderAdapter(traceRecorder) : undefined,
    events: new StreamBrokerAdapter(streamBroker),
  };
};

export const createOrchestrator = (
  ports: AgentBrainPorts,
  deps: {
    sessionStore: SessionStore;
    usageTracker: UsageTracker;
    artifactService: ArtifactServicePort;
    usageStore: UsageStorePort;
    traceRecorder: SessionTraceRecorder;
    s3Bundle: S3Bundle;
    config: ResolvedConfig;
    checkpointManager?: CheckpointManager;
    /** @deprecated Use config.agent instead */
    agentConfig?: Record<string, unknown>;
    policyResolver?: PolicyResolver;
    policyFacade?: PolicyEngine;
    policyTelemetry?: PolicyTelemetry;
    notificationPort?: NotificationPort;
    scopeVerificationPort?: ScopeVerificationPort;
    modelConfigPort?: ModelConfigPort;
    tokenGuard: TokenGuard;
    maxToolCallsPerTurn?: number;
    modelRequestPort?: ModelRequestAdapter;
    historyTransformationPort?: HistoryTransformationAdapter;
    runtimeHostCapabilities?: RuntimeHostCapabilities;
    sessionRepository?: {
      setBlockedReason: (id: string, reason: string, meta?: Record<string, unknown>, executionClaimToken?: string) => Promise<boolean>;
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
  },
): OrchestratorAdapter => {
  const notificationPort: NotificationPort = deps.notificationPort ?? { notify: notifyAppEvent };

  const scopeVerificationPort = deps.scopeVerificationPort ?? createScopeVerificationPort();
  const modelConfigPort = deps.modelConfigPort ?? createModelConfigPort();
  const providerFactory = new ProviderFactoryAdapter(deps.config, modelConfigPort);
  return new OrchestratorAdapter({
    events: ports.events,
    sessionStore: deps.sessionStore,
    toolsRegistry: ports.tools,
    contextProvider: ports.context,
    usageTracker: deps.usageTracker,
    artifactService: deps.artifactService,
    usageStore: deps.usageStore,
    tracesS3: deps.s3Bundle.s3TracesClient
      ? { client: deps.s3Bundle.s3TracesClient, bucket: deps.s3Bundle.s3TracesBucket }
      : undefined,
    traceRecorder: deps.traceRecorder,
    config: deps.config,
    policyResolverInstance: deps.policyResolver,
    policyFacade: deps.policyFacade,
    policyTelemetry: deps.policyTelemetry,
    providerFactory,
    sessionRepository: deps.sessionRepository,
    checkpointManager: deps.checkpointManager,
    notificationPort,
    scopeVerificationPort,
    tokenGuard: deps.tokenGuard,
    maxToolCallsPerTurn: deps.maxToolCallsPerTurn,
    modelRequestPort: deps.modelRequestPort,
    historyTransformationPort: deps.historyTransformationPort,
    runtimeHostCapabilities: deps.runtimeHostCapabilities,
  });
};

export const createAgentEngine = (
  ports: AgentBrainPorts,
  sessionStore: SessionStore,
): AgentEngine => new AgentEngine(ports, sessionStore);

export const createAgentServicesFactory = (
  deps: {
    streamBroker: StreamBroker;
    sessionStore: SessionStore;
    sandbox: SandboxAdapter;
    traceRecorder: SessionTraceRecorder;
    usageStore: UsageStorePort;
    checkpointManager: CheckpointManager;
    toolsRegistry: ToolsRegistry;
    usageTracker: UsageTracker;
    sandboxProfileRegistry: SandboxProfileRegistry;
    artifactService: ArtifactServicePort;
    orchestrator: OrchestratorAdapter;
    ports: AgentBrainPorts;
    agentEngine: AgentEngine;
    config: ResolvedConfig;
    policyResolver: PolicyResolver;
    policyFacade?: PolicyEngine;
    policyTelemetry?: PolicyTelemetry;
    s3ArtifactsClient?: S3StorageService;
    s3WorkspacesClient?: S3StorageService;
    tokenGuard: TokenGuard;
  },
) => createAgentServices(deps);

// ======================================================================================
// DI Registration Helpers (composition -> factories)
// ======================================================================================

export const shouldPersistAgentSessions = (options: {
  productHost?: 'platform' | 'research_lab';
  persistSessions?: boolean;
  runtimeHostCapabilities?: RuntimeHostCapabilities;
} = {}): boolean =>
  (options.runtimeHostCapabilities?.hostKind
    ?? (options.productHost === 'research_lab' ? 'research_lab' : 'organization')) !== 'research_lab'
  || options.persistSessions === true;

export const registerOrchestration = (
  container: DIContainer,
  config: ResolvedConfig,
  sessionTTL: number,
  options: {
    runtimeHostCapabilities: RuntimeHostCapabilities;
    persistSessions?: boolean;
  },
): void => {
  const organizationPersistenceEnabled = options.runtimeHostCapabilities.hostKind === 'organization';
  const sessionPersistenceEnabled = shouldPersistAgentSessions(options);
  const artifactStorageRoot = config.workspace.artifactStorageRoot;
  const policyResolver = new PolicyResolver(new PolicyConfigRepositoryAdapter());
  container.register<PolicyResolver>(TOKENS.policyResolver, () => policyResolver);
  container.register<PolicyEngine>(TOKENS.policyEngine, async (c) => {
    const resolver = await c.resolve<PolicyResolver>(TOKENS.policyResolver);
    const telemetry = new OpsPolicyTelemetry();
    return new PolicyEngine(config, resolver, telemetry);
  });

  container.register<TokenGuard>(TOKENS.tokenGuard, () => new TokenGuard({
    perSessionLimit: config.tokenGuard.perSessionLimit,
    perUserDailyLimit: config.tokenGuard.perUserDailyLimit,
    warningThresholdPct: config.tokenGuard.warningThresholdPct,
  }));
  container.register('policyTelemetry', () => new OpsPolicyTelemetry());
  container.register<StreamBroker>(TOKENS.streamBroker, () => createStreamBroker());

  container.register<UsageTracker>(TOKENS.usageTracker, () => createUsageTracker());
  container.register<ModelService>(TOKENS.modelService, () => createModelService());
  container.register<SandboxProfileRegistry>(TOKENS.sandboxProfileRegistry, async () =>
    createSandboxProfileRegistry(),
  );

  container.register<SessionStore>(TOKENS.sessionStore, async (c) => {
    const sessionRepository = sessionPersistenceEnabled
      ? await c.resolve<SessionRepositoryPort>(TOKENS.sessionRepository)
      : undefined;
    const sessionEventJournal = sessionPersistenceEnabled
      ? await c.resolve<SessionEventJournalPort>(TOKENS.sessionEventJournal)
      : undefined;
    const workspaceManager = await c.resolve<WorkspaceManager>(TOKENS.workspaceManager);
    const traceRecorder = await c.resolve<SessionTraceRecorder>(TOKENS.traceRecorder);
    const verboseLogging = isVerboseSessionLoggingEnabled();
    const store = new SessionStore({
      sessionTTL,
      sessionRepository,
      sessionEventJournal,
      workspaceManager,
      traceRecorder,
      verboseLogging,
      hydrationOptions: {
        maxSessions: 200,
        maxMessages: 200,
        maxArtifacts: 50,
        maxCheckpoints: 50,
        recentMs: sessionTTL * 2,
      },
    });
    void store.whenReady();
    return store;
  });

  container.register<SandboxAdapter>(TOKENS.sandboxPort, async (c) => {
    // Build SandboxManager inline to avoid exposing it via DI
    const sessionStore = await c.resolve<SessionStore>(TOKENS.sessionStore);
    const traceRecorder = await c.resolve<SessionTraceRecorder>(TOKENS.traceRecorder);
    const policyResolverInstance = await c.resolve<PolicyResolver>(TOKENS.policyResolver);
    const policyFacade = await c.resolve<PolicyEngine>(TOKENS.policyEngine);
    const { SandboxManager } = await import('@/domains/agent-brain/adapters/sandbox');
    const manager = new SandboxManager({
      sessionStore,
      ttlMs: sessionTTL,
      traceRecorder,
      config,
      policyResolver: policyResolverInstance,
      policyFacade,
    });
    const { SandboxAdapter: SandboxAdapterImpl } = await import('@/domains/agent-brain/adapters/sandbox');
    return new SandboxAdapterImpl(manager);
  });

  container.register<CheckpointManager>(TOKENS.checkpointManager, async (c) => {
    const sessionStore = await c.resolve<SessionStore>(TOKENS.sessionStore);
    const streamBroker = await c.resolve<StreamBroker>(TOKENS.streamBroker);
    const traceRecorder = await c.resolve<SessionTraceRecorder>(TOKENS.traceRecorder);
    return createCheckpointManager(sessionStore, streamBroker, traceRecorder);
  });

  container.register<ToolsRegistry>(TOKENS.toolsRegistry, async (c) => {
    const streamBroker = await c.resolve<StreamBroker>(TOKENS.streamBroker);
    const sessionStore = await c.resolve<SessionStore>(TOKENS.sessionStore);
    const sandboxAdapter = await c.resolve<SandboxAdapter>(TOKENS.sandboxPort);
    const checkpointManager = await c.resolve<CheckpointManager>(TOKENS.checkpointManager);
    const traceRecorder = await c.resolve<SessionTraceRecorder>(TOKENS.traceRecorder);
    return createToolsRegistry(
      streamBroker,
      sessionStore,
      sandboxAdapter,
      checkpointManager,
      traceRecorder,
      config,
      new ToolPolicyChecker(),
      options.runtimeHostCapabilities,
    );
  });

  container.register<ArtifactServicePort>(TOKENS.artifactService, async (c) => {
    const sessionStore = await c.resolve<SessionStore>(TOKENS.sessionStore);
    const artifactRepository = organizationPersistenceEnabled
      ? (await c.resolve<SessionPersistenceBundle>(TOKENS.sessionPersistenceBundle)).artifactRepository
      : undefined;
    const s3Bundle = await c.resolve<S3Bundle>(TOKENS.s3Bundle);
    return createArtifactService(sessionStore, artifactRepository, s3Bundle, artifactStorageRoot, config);
  });

  container.register<AgentBrainPorts>(TOKENS.agentBrainPorts, async (c) => {
    const toolsRegistry = await c.resolve<ToolsRegistry>(TOKENS.toolsRegistry);
    const sandboxAdapter = await c.resolve<SandboxAdapter>(TOKENS.sandboxPort);
    const traceRecorder = await c.resolve<SessionTraceRecorder>(TOKENS.traceRecorder);
    const streamBroker = await c.resolve<StreamBroker>(TOKENS.streamBroker);
    return createPorts(toolsRegistry, sandboxAdapter, traceRecorder, streamBroker);
  });
  container.register<OrchestratorAdapter>(TOKENS.orchestrator, async (c) => {
    const ports = await c.resolve<AgentBrainPorts>(TOKENS.agentBrainPorts);
    const sessionStore = await c.resolve<SessionStore>(TOKENS.sessionStore);
    const usageTracker = await c.resolve<UsageTracker>(TOKENS.usageTracker);
    const artifactService = await c.resolve<ArtifactServicePort>(TOKENS.artifactService);
    const usageStore = await c.resolve<UsageStorePort>(TOKENS.usageStore);
    const traceRecorder = await c.resolve<SessionTraceRecorder>(TOKENS.traceRecorder);
    const s3Bundle = await c.resolve<S3Bundle>(TOKENS.s3Bundle);
    const tokenGuard = await c.resolve<TokenGuard>(TOKENS.tokenGuard);
    const policyResolverInstance = await c.resolve<PolicyResolver>(TOKENS.policyResolver);
    const policyFacade = await c.resolve<PolicyEngine>(TOKENS.policyEngine);
    // Create SessionRepository for blocked_reason persistence (Phase 3: credits durability)
    const sessionRepository = sessionPersistenceEnabled
      ? new (await import('@/domains/agent-brain/adapters/persistence')).SessionRepository()
      : undefined;
    return createOrchestrator(ports, {
      sessionStore,
      usageTracker,
      artifactService,
      usageStore,
      traceRecorder,
      s3Bundle,
      config,
      sessionRepository, // Phase 3: blocked_reason persistence
      policyResolver: policyResolverInstance,
      policyFacade,
      tokenGuard,
      // Hosted runs own continuation and budget enforcement. Smaller turns return
      // control to the host frequently enough for cancel and spend limits to act.
      maxToolCallsPerTurn: organizationPersistenceEnabled ? undefined : 4,
      modelRequestPort: organizationPersistenceEnabled ? new ModelRequestAdapter(db) : undefined,
      historyTransformationPort: organizationPersistenceEnabled
        ? new HistoryTransformationAdapter(db)
        : undefined,
      runtimeHostCapabilities: options.runtimeHostCapabilities,
    });
  });

  container.register<AgentEngine>(TOKENS.agentEngine, async (c) => {
    const ports = await c.resolve<AgentBrainPorts>(TOKENS.agentBrainPorts);
    const sessionStore = await c.resolve<SessionStore>(TOKENS.sessionStore);
    return createAgentEngine(ports, sessionStore);
  });

  // Health checks are now done on-demand via SandboxHealthChecker when needed

  container.register<ReturnType<typeof createAgentServicesFactory>>(TOKENS.agentServices, async (c) => {
    const streamBroker = await c.resolve<StreamBroker>(TOKENS.streamBroker);
    const sessionStore = await c.resolve<SessionStore>(TOKENS.sessionStore);
    const sandboxAdapter = await c.resolve<SandboxAdapter>(TOKENS.sandboxPort);
    const traceRecorder = await c.resolve<SessionTraceRecorder>(TOKENS.traceRecorder);
    const usageStore = await c.resolve<UsageStorePort>(TOKENS.usageStore);
    const checkpointManager = await c.resolve<CheckpointManager>(TOKENS.checkpointManager);
    const toolsRegistry = await c.resolve<ToolsRegistry>(TOKENS.toolsRegistry);
    const usageTracker = await c.resolve<UsageTracker>(TOKENS.usageTracker);
    const sandboxProfileRegistry = await c.resolve<SandboxProfileRegistry>(TOKENS.sandboxProfileRegistry);
    const artifactService = await c.resolve<ArtifactServicePort>(TOKENS.artifactService);
    const orchestrator = await c.resolve<OrchestratorAdapter>(TOKENS.orchestrator);
    const ports = await c.resolve<AgentBrainPorts>(TOKENS.agentBrainPorts);
    const agentEngine = await c.resolve<AgentEngine>(TOKENS.agentEngine);
    const policyResolverInstance = await c.resolve<PolicyResolver>(TOKENS.policyResolver);
    const policyFacade = await c.resolve<PolicyEngine>(TOKENS.policyEngine);
    const s3Bundle = await c.resolve<S3Bundle>(TOKENS.s3Bundle);
    const tokenGuard = await c.resolve<TokenGuard>(TOKENS.tokenGuard);
    return createAgentServicesFactory({
      streamBroker,
      sessionStore,
      sandbox: sandboxAdapter,
      traceRecorder,
      usageStore,
      checkpointManager,
      toolsRegistry,
      usageTracker,
      sandboxProfileRegistry,
      artifactService,
      orchestrator,
      ports,
      agentEngine,
      config,
      policyResolver: policyResolverInstance,
      policyFacade,
      s3ArtifactsClient: s3Bundle.s3Client,
      s3WorkspacesClient: s3Bundle.s3WorkspacesClient,
      tokenGuard,
    });
  });
};
