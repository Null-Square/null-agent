import { CheckpointManager } from '@/domains/agent-brain/application/core/CheckpointManager';
import { OrchestratorAdapter } from '@/domains/agent-brain/application/orchestration/OrchestratorAdapter';
import { AgentEngine } from '@/domains/agent-brain/application/orchestration/AgentEngine';
import { ToolsRegistry } from '@/domains/agent-brain/adapters/tools/ToolsRegistry';
import { createToolEntitlementGuard } from '@/domains/agent-brain/adapters/tools/ToolEntitlementGuard';
import {
  ContextGatewayAdapter,
  ToolsRegistryAdapter,
  SandboxManagerAdapter,
  TelemetryRecorderAdapter,
  StreamBrokerAdapter,
} from '@/domains/agent-brain/adapters';
import type { StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { type SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';
import type { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';
import type { AgentApiServices } from './types';
import type { ResolvedConfig } from '@/config/configTypes';
import { UsageTracker } from '@/domains/platform/subscriptions/infrastructure/usageTracker';
import { ArtifactService } from '@/domains/agent-brain/infrastructure/artifacts/ArtifactService';
import { ArtifactRepository, SessionRepository } from '@/domains/agent-brain/adapters/persistence';
import type { SandboxProfileRegistryPort, ArtifactServicePort } from '@/domains/agent-brain/ports';
import type { UsageStore } from '@/domains/platform/subscriptions/usageStore';
import type { AgentBrainPorts } from '@/domains/agent-brain/application/core/AgentBrainPorts';
import { type PolicyResolver } from '@/domains/agent-brain/domain/policy';
import { type PolicyEngine } from '@/domains/agent-brain/application/services/PolicyEngine';
import type { PolicyTelemetry } from '@/shared/telemetry/PolicyTelemetry';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import type { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools/ToolPolicyChecker';
import { ToolLifecycleHookRegistry } from '@/domains/agent-brain/application/tools/ToolLifecycleHooks';
import { WorkerDelegationService } from '@/domains/agent-brain/application/services/WorkerDelegationService';
// SIMPLIFIED Dec 2025: Removed ApprovalRequestsAdapter - using session.pendingApproval
import { ProviderFactoryAdapter } from '@/domains/agent-brain/adapters/providers/ProviderFactoryAdapter';
import { createModelConfigPort } from '@/app/adapters/portFactories';
import { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { db } from '@/db/client';
import { CapacityLeaseService } from '@/domains/security-ops/runs/scheduling/CapacityLeaseService';
import { loadCloudRunSchedulingConfig } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';

type Dependencies = {
  streamBroker: StreamBroker;
  sessionStore: SessionStore;
  sandbox: SandboxAdapter;
  traceRecorder?: SessionTraceRecorder;
  usageStore: UsageStore;
  checkpointManager?: CheckpointManager;
  toolsRegistry?: ToolsRegistry;
  usageTracker?: UsageTracker;
  artifactService?: ArtifactServicePort;
  sandboxProfileRegistry: SandboxProfileRegistryPort;
  orchestrator?: OrchestratorAdapter;
  ports?: AgentBrainPorts;
  agentEngine?: AgentEngine;
  config: ResolvedConfig;
  policyResolver: PolicyResolver;
  policyFacade?: PolicyEngine;
  policyTelemetry?: PolicyTelemetry;
  s3ArtifactsClient?: S3StorageService;
  s3WorkspacesClient?: S3StorageService;
  tokenGuard: TokenGuard;
};

export const createAgentServices = ({
  streamBroker,
  sessionStore,
  sandbox,
  traceRecorder,
  usageStore: providedUsageStore,
  checkpointManager: providedCheckpointManager,
  toolsRegistry: providedToolsRegistry,
  usageTracker: providedUsageTracker,
  artifactService: providedArtifactService,
  sandboxProfileRegistry: providedSandboxProfileRegistry,
  orchestrator: providedOrchestrator,
  ports: providedPorts,
  agentEngine: providedAgentEngine,
  config,
  policyResolver,
  policyFacade,
  policyTelemetry,
  s3ArtifactsClient,
  s3WorkspacesClient,
  tokenGuard,
}: Dependencies): AgentApiServices => {
  const effectiveConfig = config;

  const checkpointManager =
    providedCheckpointManager ?? new CheckpointManager(sessionStore, streamBroker, traceRecorder);

  // Create FSM for status transitions - shared between ToolsRegistry (approvals) and OrchestratorAdapter
  // Wire SessionRepository for direct DB status updates with optimistic versioning
  const sessionRepository = new SessionRepository();

  // Session state is now managed by simple isProcessing flag

  const toolsRegistry =
    providedToolsRegistry ??
    (() => {
      const toolLifecycleHooks = new ToolLifecycleHookRegistry();
      toolLifecycleHooks.register(createToolEntitlementGuard({
        accessControl: new AccessControlService(),
        automationService: new AutomationService({ db }),
        modelConfigPort: createModelConfigPort(),
      }));

      return new ToolsRegistry(
        streamBroker,
        sessionStore,
        sandbox,
        checkpointManager,
        traceRecorder,
        {
          toolsDir: effectiveConfig.manifests.toolsDir,
          devWatch: effectiveConfig.manifests.toolDevWatch,
          config: effectiveConfig,
          policyChecker: new ToolPolicyChecker(),
          toolLifecycleHooks,
        },
      );
    })();
  if (sessionStore.setToolSchemaProvider) {
    sessionStore.setToolSchemaProvider(() => toolsRegistry.getToolSchemas());
  }

  const usageTracker = providedUsageTracker ?? new UsageTracker();
  const usageStore = providedUsageStore;

  const sandboxAdapter = new SandboxManagerAdapter(sandbox);
  const ports =
    providedPorts ??
    ({
      context: new ContextGatewayAdapter(traceRecorder),
      tools: new ToolsRegistryAdapter(toolsRegistry),
      sandbox: { provision: sandboxAdapter, runtime: sandboxAdapter },
      telemetry: traceRecorder ? new TelemetryRecorderAdapter(traceRecorder) : undefined,
      events: new StreamBrokerAdapter(streamBroker),
    } as AgentBrainPorts);

  const artifactService =
    providedArtifactService ?? new ArtifactService(sessionStore, new ArtifactRepository());

  const agentEngine = providedAgentEngine ?? new AgentEngine(ports, sessionStore);
  const modelConfigPort = createModelConfigPort();
  const providerFactory = new ProviderFactoryAdapter(effectiveConfig, modelConfigPort);

  const orchestrator =
    providedOrchestrator ??
    new OrchestratorAdapter({
      events: ports.events,
      sessionStore,
      toolsRegistry: ports.tools,
      contextProvider: ports.context,
      usageTracker,
      artifactService,
      usageStore,
      traceRecorder,
      config: effectiveConfig,
      policyResolverInstance: policyResolver,
      policyFacade,
      policyTelemetry,
      providerFactory,
      sessionRepository,
      checkpointManager,
      tokenGuard,
      });

  const workerCapacityCoordinator = new CapacityLeaseService(
    db,
    loadCloudRunSchedulingConfig(process.env, effectiveConfig.sandbox),
  );
  const workerDelegation = new WorkerDelegationService(
    sessionStore,
    new ToolPolicyChecker(),
    traceRecorder,
    workerCapacityCoordinator,
  );
  workerDelegation.bindRuntime({
    agentEngine,
    orchestrator,
  });
  toolsRegistry.setWorkerDelegationService(workerDelegation);

  const sandboxProfileRegistry = providedSandboxProfileRegistry;

  return {
    streamBroker,
    sessionStore,
    checkpointManager,
    sandbox,
    toolsRegistry,
    orchestrator,
    traceRecorder,
    usageTracker,
    sandboxProfileRegistry,
    usageStore,
    ports,
    agentEngine,
    artifactService,
    workerDelegation,
    policyResolver,
    policyFacade,
    tokenGuard,
    s3ArtifactsClient,
    s3WorkspacesClient,
  };
};
