import { describe, expect, it, vi } from 'vitest';
import type { AgentApiServices } from '@/interfaces/http/controllers/ai-agent/types';
import type { SessionsRouterDeps } from '@/interfaces/http/controllers/ai-agent/routes/sessions.router';
import { createAgentRouter } from '@/interfaces/http/controllers/ai-agent/AgentRouter';
import { approvalsRouter } from '@/interfaces/http/controllers/ai-agent/routes/approvals.router';
import { healthRouter } from '@/interfaces/http/controllers/ai-agent/routes/health.router';
import { sessionsRouter } from '@/interfaces/http/controllers/ai-agent/routes/sessions.router';
import { streamRouter } from '@/interfaces/http/controllers/ai-agent/routes/stream.router';
import { StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';
import { PolicyResolver } from '@/domains/agent-brain/domain/policy';
import { AccessControlService } from '@/app/services/platform/subscriptions/accessControlAppService';
import type { AgentBrainPorts } from '@/domains/agent-brain/application/core/AgentBrainPorts';
import type { PolicyRepositoryPort } from '@/domains/agent-brain/ports';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { SandboxProfileRegistryPort } from '@/domains/agent-brain/ports';
import type { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';
import type { OrchestratorAdapter } from '@/domains/agent-brain/application/orchestration/OrchestratorAdapter';
import type { ArtifactServicePort } from '@/domains/agent-brain/ports';
import type { AgentEngine } from '@/domains/agent-brain/application/orchestration/AgentEngine';
import type { ToolsRegistry } from '@/domains/agent-brain/adapters/tools/ToolsRegistry';
import type { CheckpointManager } from '@/domains/agent-brain/application/core/CheckpointManager';
import type { SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';

const buildKernel = (): AgentApiServices & SessionsRouterDeps => {
  const sessionStore = {
    get: vi.fn(),
    listSessions: vi.fn(() => []),
    listByUser: vi.fn(() => []),
    set: vi.fn(),
    setAsync: vi.fn(),
    remove: vi.fn(),
    abortCurrentTurnAsync: vi.fn(),
  } as unknown as SessionStore;

  const policyRepository: PolicyRepositoryPort = {
    getBySlug: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue(null),
    getDefaultPolicy: vi.fn().mockResolvedValue(null),
  };
  const policyResolver = new PolicyResolver(policyRepository);

  const ports: AgentBrainPorts = {
    context: {
      getContext: vi.fn().mockResolvedValue({ hard: '' }),
      getShortRules: vi.fn().mockResolvedValue({ hard: '' }),
    },
    tools: {
      listManifests: vi.fn().mockResolvedValue([]),
      getManifest: vi.fn().mockResolvedValue(undefined),
      getToolSchemas: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockResolvedValue(undefined),
      executeWithReceipt: vi.fn().mockResolvedValue({
        result: undefined,
        receipt: {
          schema: 'tool-execution-receipt/v1',
          toolName: 'test_tool',
          outcome: 'succeeded',
        },
      }),
      handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true, needsResume: false }),
    },
    sandbox: {
      provision: {
        create: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        getPolicy: vi.fn().mockResolvedValue(undefined),
      },
      runtime: {
        exec: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 }),
      } as any,
    },
    events: {
      subscribe: vi.fn(() => () => undefined),
      emit: vi.fn(),
      emitPlan: vi.fn(),
      cleanup: vi.fn(),
    },
  };

  const sandboxProfileRegistry = {
    resolveImage: vi.fn(() => 'sandbox-default'),
    getProfiles: vi.fn(() => ['sandbox-default']),
  } as unknown as SandboxProfileRegistryPort;

  const tokenGuard = {
    checkLimits: vi.fn().mockReturnValue({
      exceeded: false,
      currentUsage: 0,
      limit: 0,
      usagePct: 0,
      warning: false,
    }),
  } as unknown as TokenGuard;

  const repositories = {
    sessionRepository: {} as any,
    messageRepository: {} as any,
    artifactRepository: {} as any,
    policyRepository: {} as any,
  };
  const subscriptionRecord = {
    userId: 'anon',
    plan: { slug: 'local', features: {}, limits: {} },
  };
  const accessControl = new AccessControlService({
    resolveOrganizationSubscription: vi.fn().mockResolvedValue(subscriptionRecord),
    resolveAnonymousSubscription: vi.fn().mockReturnValue(subscriptionRecord),
  });

  const services = {
    streamBroker: new StreamBroker(),
    sessionStore,
    checkpointManager: {} as CheckpointManager,
    sandbox: {} as SandboxAdapter,
    toolsRegistry: {} as ToolsRegistry,
    orchestrator: {
      processMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as OrchestratorAdapter,
    sandboxProfileRegistry,
    ports,
    agentEngine: {
      initializeSession: vi.fn().mockResolvedValue(undefined),
      cleanupSession: vi.fn().mockResolvedValue(undefined),
      stopSandbox: vi.fn().mockResolvedValue(undefined),
      getSandboxPolicy: vi.fn().mockResolvedValue(null),
    } as unknown as AgentEngine,
    artifactService: {
      getStorageRoot: vi.fn(() => ''),
    } as unknown as ArtifactServicePort,
    workerDelegation: {} as AgentApiServices['workerDelegation'],
    policyResolver,
    tokenGuard,
    repositories,
    sessionRepository: repositories.sessionRepository,
    messageRepository: repositories.messageRepository,
    artifactRepository: repositories.artifactRepository,
    policyRepository: repositories.policyRepository,
    accessControl,
    subscriptionPort: {
      resolveOrganizationSubscription: vi.fn().mockResolvedValue(subscriptionRecord),
      enforceSessionCreation: vi.fn().mockResolvedValue(subscriptionRecord),
    },
    modelConfigPort: {
      getDefaultModel: vi.fn().mockResolvedValue({
        modelName: 'test-model',
        provider: 'openai',
        isDefault: true,
        contextWindow: 8192,
        maxOutputTokens: 2048,
      }),
      getByModelName: vi.fn().mockResolvedValue(null),
      getModel: vi.fn().mockResolvedValue(null),
      listModelsForCategory: vi.fn().mockResolvedValue([]),
    },
  } satisfies AgentApiServices & SessionsRouterDeps;

  return services;
};

describe('ai-agent kernel contract', () => {
  it('constructs all ai-agent routers with a minimal kernel', () => {
    const services = buildKernel();

    expect(() => sessionsRouter(services)).not.toThrow();
    expect(() => streamRouter(services)).not.toThrow();
    expect(() => approvalsRouter(services)).not.toThrow();
    expect(() => healthRouter(services)).not.toThrow();
  });

  it('constructs the agent router with a minimal kernel', () => {
    const services = buildKernel();

    expect(() => createAgentRouter({ services })).not.toThrow();
  });
});
