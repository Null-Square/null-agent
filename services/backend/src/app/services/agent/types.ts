import type { StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { CheckpointManager } from '@/domains/agent-brain/application/core/CheckpointManager';
import type { ToolsRegistry } from '@/domains/agent-brain/adapters/tools/ToolsRegistry';
import type { OrchestratorAdapter } from '@/domains/agent-brain/application/orchestration/OrchestratorAdapter';
import type { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';
import type { UsageTracker } from '@/domains/platform/subscriptions/infrastructure/usageTracker';
import type { UsageStore } from '@/domains/platform/subscriptions/usageStore';
import type { AgentBrainPorts } from '@/domains/agent-brain/application/core/AgentBrainPorts';
import type { AgentEngine } from '@/domains/agent-brain/application/orchestration/AgentEngine';
import type { ArtifactServicePort } from '@/domains/agent-brain/ports';
import type { PolicyResolver } from '@/domains/agent-brain/domain/policy';
import type { PolicyEngine } from '@/domains/agent-brain/application/services/PolicyEngine';
import type { PolicyTelemetry } from '@/shared/telemetry/PolicyTelemetry';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import type { SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';
import type { SandboxProfileRegistryPort } from '@/domains/agent-brain/ports';
import type { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';
import type { WorkerDelegationService } from '@/domains/agent-brain/application/services/WorkerDelegationService';
export type { SandboxProfileRegistryPort } from '@/domains/agent-brain/ports';

export type SandboxService = SandboxAdapter;

export interface AgentApiServices {
  streamBroker: StreamBroker;
  sessionStore: SessionStore;
  checkpointManager: CheckpointManager;
  sandbox: SandboxService;
  toolsRegistry: ToolsRegistry;
  orchestrator: OrchestratorAdapter;
  traceRecorder?: SessionTraceRecorder;
  usageTracker?: UsageTracker;
  sandboxProfileRegistry: SandboxProfileRegistryPort;
  usageStore?: UsageStore;
  ports: AgentBrainPorts;
  agentEngine: AgentEngine;
  artifactService: ArtifactServicePort;
  workerDelegation: WorkerDelegationService;
  policyResolver: PolicyResolver;
  policyFacade?: PolicyEngine;
  policyTelemetry?: PolicyTelemetry;
  tokenGuard: TokenGuard;
  s3ArtifactsClient?: S3StorageService;
  s3WorkspacesClient?: S3StorageService;
}
