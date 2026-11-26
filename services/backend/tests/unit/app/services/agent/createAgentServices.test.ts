import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  setToolSchemaProvider: vi.fn(),
  getToolSchemas: vi.fn(),
  orchestratorCtor: vi.fn(),
}));

vi.mock('@/domains/agent-brain/application/orchestration/OrchestratorAdapter', () => ({
  OrchestratorAdapter: vi.fn().mockImplementation((opts) => {
    mocks.orchestratorCtor(opts);
    return {};
  }),
}));

vi.mock('@/domains/agent-brain/adapters/persistence', () => ({
  ArtifactRepository: vi.fn().mockImplementation(() => ({})),
  SessionRepository: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/db/client', () => ({ db: {} }));

let createAgentServices: typeof import('@/app/services/agent/createAgentServices').createAgentServices;

describe('createAgentServices', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getToolSchemas.mockReturnValue([{ id: 'tool-1' }]);
    vi.resetModules();
    ({ createAgentServices } = await import('@/app/services/agent/createAgentServices'));
  });

  const buildDeps = (overrides: Record<string, unknown> = {}) => ({
    streamBroker: {},
    sessionStore: { setToolSchemaProvider: mocks.setToolSchemaProvider },
    sandbox: {},
    policyResolver: {},
    config: { manifests: { toolsDir: '/tmp/tools', toolDevWatch: false } },
    checkpointManager: {},
    toolsRegistry: {
      getToolSchemas: mocks.getToolSchemas,
      setWorkerDelegationService: vi.fn(),
    },
    usageTracker: {},
    artifactService: {},
    sandboxProfileRegistry: {},
    ports: { events: {}, tools: {}, context: {}, sandbox: {}, telemetry: {}, tasks: {} },
    agentEngine: {},
    usageStore: {},
    ...overrides,
  });

  it('wires tool schemas and constructs orchestrator', () => {
    createAgentServices(buildDeps() as any);

    const provider = mocks.setToolSchemaProvider.mock.calls[0]?.[0];
    expect(provider?.()).toEqual([{ id: 'tool-1' }]);
    expect(mocks.orchestratorCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionStore: expect.anything(),
        toolsRegistry: expect.anything(),
        contextProvider: expect.anything(),
      }),
    );
  });

  it('skips model lookup when orchestrator is provided', () => {
    const orchestrator = { setModelName: vi.fn() };

    const services = createAgentServices(buildDeps({ orchestrator }) as any);

    expect(services.orchestrator).toBe(orchestrator);
    expect(mocks.orchestratorCtor).not.toHaveBeenCalled();
  });

  it('does not require model name when orchestrator is not provided', () => {
    expect(() => createAgentServices(buildDeps() as any)).not.toThrow();
  });
});
