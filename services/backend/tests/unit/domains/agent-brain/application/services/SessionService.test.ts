import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';
import {
  __resetExecutionRuntimeForTests,
  registerExecutionAdapter,
  registerExecutionSelectionDefaultResolver,
} from '@/domains/agent-brain/domain/runtime/ExecutionRuntimeRegistry';

const makeSession = (overrides: Partial<any> = {}) => ({
  id: 's1',
  status: 'idle',
  flags: {},
  modelName: 'test-model',
  ...overrides,
});

const resolvedPolicy = {
  id: 'policy-1',
  profile: 'default',
  sandboxProfile: 'default',
  toolPolicy: { allow: ['file_read'] },
  source: 'default',
};

describe('SessionService.createSession', () => {
  const session = makeSession();
  const sessionStore = {
    create: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  };
  const sandboxProfileRegistry = {} as any;
  const ports = {
    context: {},
    tools: {},
    sandbox: { provision: {}, runtime: {} },
    events: {},
  } as any;
  const agentEngine = {
    initializeSession: vi.fn(),
  } as any;
  const sandboxSelection = {
    resolve: vi.fn(),
  } as any;
  const modelConfigPort = {
    getDefaultModel: vi.fn(),
    getModel: vi.fn(),
    listModelsForCategory: vi.fn(),
    getByModelName: vi.fn(),
  } as any;
  const policyResolver = {} as any;
  const policyFacade = { resolveBrainPolicy: vi.fn() } as any;

  const subscriptionPort = {
    enforceSessionCreation: vi.fn(),
    resolveOrganizationSubscription: vi.fn(),
  } as any;

  const makeService = () =>
    new SessionService(
      sessionStore as any,
      sandboxProfileRegistry,
      ports,
      agentEngine,
      subscriptionPort,
      policyResolver,
      modelConfigPort,
      undefined,
      undefined,
      policyFacade,
      sandboxSelection as any,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.create.mockResolvedValue(session);
    sandboxSelection.resolve.mockResolvedValue({ sandboxProfile: 'default', sandboxImage: 'sandbox:img' });
    const subscription = {
      plan: { slug: 'local', features: {}, limits: {}, id: 'local', name: 'Local' },
    };
    subscriptionPort.resolveOrganizationSubscription.mockResolvedValue(subscription);
    subscriptionPort.enforceSessionCreation.mockResolvedValue(subscription);
    policyFacade.resolveBrainPolicy.mockResolvedValue(resolvedPolicy);
    modelConfigPort.getDefaultModel.mockResolvedValue({
      modelName: 'test-model',
      provider: 'OPENAI',
      apiKey: 'test-key',
      contextWindow: 8000,
      maxOutputTokens: 1000,
    });
  });

  afterEach(() => __resetExecutionRuntimeForTests());

  it('creates a session with merged policy/tool settings and subscription flags', async () => {
    const service = makeService();

    const result = await service.createSession({
      userId: 'u1',
      profileKey: 'default',
      mode: 'automated',
      toolPolicy: { deny: ['shell_run'] },
      extraContext: 'ctx',
      agentType: 'planner',
    });

    expect(subscriptionPort.enforceSessionCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        mode: 'automated',
      }),
    );
    expect(sessionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        profileKey: 'default',
        mode: 'automated',
        extraContext: 'ctx',
        agentType: 'planner',
        sandboxProfile: 'default',
        sandboxImage: 'sandbox:img',
        modelName: 'test-model',
      }),
    );
    expect(result.session.flags?.subscription?.planSlug).toBe('local');
    expect(result.session.flags?.brain_policy).toEqual({ profile: 'default', source: 'default' });
    expect(result.session.flags?.policy_base?.toolPolicy).toEqual({ allow: ['file_read'] });
  });

  it('admits a fixed evaluation model while preserving organization billing identity', async () => {
    const service = makeService();
    modelConfigPort.getModel.mockResolvedValue({
      id: 'model-deployment-1',
      modelName: 'deepseek-v4-pro',
      provider: 'DEEPSEEK',
      apiKey: 'test-key',
      isActive: true,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    });

    await service.createSession({
      userId: 'evaluation-user',
      organizationId: 'evaluation-organization',
      modelId: 'model-deployment-1',
      modelTemperature: 0,
      flags: {
        securityops: {
          organizationId: 'evaluation-organization',
          evaluationKind: 'b1_offline_skill_fixture',
        },
      },
    });

    expect(subscriptionPort.enforceSessionCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'evaluation-user',
        organizationId: 'evaluation-organization',
      }),
    );
    expect(sessionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'evaluation-user',
        modelName: 'deepseek-v4-pro',
        modelTemperature: 0,
        flags: expect.objectContaining({
          securityops: {
            organizationId: 'evaluation-organization',
            evaluationKind: 'b1_offline_skill_fixture',
          },
          execution_profile: expect.objectContaining({
            pricingModelId: 'model-deployment-1',
            effectiveModel: 'deepseek-v4-pro',
          }),
        }),
      }),
    );
  });

  it('preserves worker-management tools from the effective policy', async () => {
    const service = makeService();

    await service.createSession({
      userId: 'u1',
      profileKey: 'default',
      mode: 'automated',
      agentType: 'executor',
      toolPolicy: { allow: ['spawn_worker', 'wait_for_worker'] },
    });

    expect(sessionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPolicy: expect.objectContaining({
          allow: expect.arrayContaining(['file_read', 'spawn_worker', 'wait_for_worker']),
        }),
      }),
    );
  });

  it('cleans up session when initialization fails', async () => {
    const service = makeService();
    agentEngine.initializeSession.mockRejectedValue(new Error('init failed'));

    await expect(service.createSession({ userId: 'u1' })).rejects.toThrow('init failed');
    expect(sessionStore.remove).toHaveBeenCalledWith('s1', 'explicit');
  });

  it('throws INTERNAL_CONFIGURATION when no default policy is configured', async () => {
    const service = makeService();
    policyFacade.resolveBrainPolicy.mockRejectedValue(new Error('policy.default_missing'));

    await expect(service.createSession({ userId: 'u1' })).rejects.toMatchObject({
      code: ERROR_CODES.INTERNAL_CONFIGURATION,
      httpStatus: 500,
    });
  });

  it('returns RESOURCE_NOT_FOUND when sandbox image is missing locally', async () => {
    const service = makeService();
    agentEngine.initializeSession.mockRejectedValue(new Error('not available locally'));

    await expect(service.createSession({ userId: 'u1' })).rejects.toMatchObject({
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      httpStatus: 404,
    });
    expect(sessionStore.remove).toHaveBeenCalledWith('s1', 'explicit');
  });

  it('rethrows access control AppError during session creation', async () => {
    const service = makeService();
    subscriptionPort.enforceSessionCreation.mockRejectedValue(
      new AppError(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 'Not available', { httpStatus: 403 }),
    );

    await expect(service.createSession({ userId: 'u1' })).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
    expect(sessionStore.create).not.toHaveBeenCalled();
  });

  it('returns a validation error when an explicitly selected model is missing', async () => {
    const service = makeService();
    modelConfigPort.getModel.mockResolvedValue(null);

    await expect(service.createSession({ userId: 'u1', modelId: 'model-missing' })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      httpStatus: 400,
      userMessage: 'The selected model is no longer available. Refresh models and choose another one.',
    });
    expect(sessionStore.create).not.toHaveBeenCalled();
  });

  it('resolves a selected model category to the active concrete model', async () => {
    const service = makeService();
    const selectedModel = {
      id: 'model-high',
      modelName: 'high-capability-model',
      provider: 'OPENAI',
      apiKey: 'test-key',
      contextWindow: 16000,
      maxOutputTokens: 2000,
      selectionCategory: 'high',
      isActive: true,
    };
    modelConfigPort.listModelsForCategory.mockResolvedValue([selectedModel]);

    const result = await service.createSession({ userId: 'u1', modelCategory: 'high' });

    expect(modelConfigPort.listModelsForCategory).toHaveBeenCalledWith('high');
    expect(modelConfigPort.getDefaultModel).not.toHaveBeenCalled();
    expect(sessionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'high-capability-model',
        modelContextWindow: 16000,
        modelMaxOutputTokens: 2000,
        flags: expect.objectContaining({
          model_selection: {
            requestedModelId: null,
            requestedCategory: 'high',
            resolvedModelId: 'model-high',
            resolvedModelName: 'high-capability-model',
            resolvedCategory: 'high',
          },
        }),
      }),
    );
    expect(result.model).toBe(selectedModel);
  });

  it('returns a validation error when a selected model category has no active model', async () => {
    const service = makeService();
    modelConfigPort.listModelsForCategory.mockResolvedValue([]);

    await expect(service.createSession({ userId: 'u1', modelCategory: 'extra_high' })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      httpStatus: 400,
      userMessage: 'The selected model category is not available. Refresh model categories and choose another one.',
    });
    expect(sessionStore.create).not.toHaveBeenCalled();
  });

  it('returns a validation error when an explicitly selected model is inactive', async () => {
    const service = makeService();
    modelConfigPort.getModel.mockResolvedValue({
      modelName: 'inactive-model',
      contextWindow: 8000,
      maxOutputTokens: 1000,
      isActive: false,
    });

    await expect(service.createSession({ userId: 'u1', modelId: 'model-inactive' })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      httpStatus: 400,
      userMessage: 'The selected model is no longer available. Refresh models and choose another one.',
    });
    expect(sessionStore.create).not.toHaveBeenCalled();
  });

  it('returns a validation error when the selected model has no API key configured', async () => {
    const service = makeService();
    modelConfigPort.getModel.mockResolvedValue({
      id: 'model-no-key',
      modelName: 'deepseek-v4-pro',
      provider: 'DEEPSEEK',
      apiKey: null,
      isActive: true,
    });

    await expect(service.createSession({ userId: 'u1', modelId: 'model-no-key' })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      httpStatus: 400,
      userMessage: 'The selected model is not configured with an API key. Choose another model or configure this model before starting a session.',
    });
    expect(sessionStore.create).not.toHaveBeenCalled();
  });

  it('pins a validated external execution profile without activating or adding an API key to its model', async () => {
    const externalResolver = {
      backend: 'codex-app-server',
      resolve: vi.fn(),
      unavailableReason: () => null,
      accountingPolicy: () => ({
        accountingMode: 'external-subscription',
        consumesPlatformCredits: true,
        requiresPlatformCreditAdmission: true,
      }),
    } as any;
    registerExecutionAdapter({
      routeId: 'codex-subscription',
      readCapabilities: async () => ({
        routeId: 'codex-subscription',
        displayName: 'Codex subscription',
        providerIdentity: 'OPENAI',
        executionBackend: 'codex-app-server',
        authMode: 'external-subscription',
        accountingMode: 'external-subscription',
        catalogueRevision: 'r1',
        models: [],
      }),
      bind: async (selection) => ({
        resolver: externalResolver,
        pricingModelName: 'gpt-next',
        profile: {
          version: 1,
          routeId: selection.routeId,
          catalogueRevision: selection.catalogueRevision,
          providerIdentity: 'OPENAI',
          executionBackend: 'codex-app-server',
          authMode: 'external-subscription',
          accountingMode: 'external-subscription',
          consumesPlatformCredits: true,
          requiresPlatformCreditAdmission: true,
          requestedModel: selection.modelId,
          effectiveModel: selection.modelId,
          controls: selection.controls,
          faultDomain: 'external:codex',
        },
      }),
      resolverFor: async () => externalResolver,
    });
    modelConfigPort.getByModelName.mockResolvedValue({
      id: 'pricing-gpt-next',
      modelName: 'gpt-next',
      provider: 'OPENAI',
      apiKey: null,
      isActive: false,
      selectionCategory: 'high',
    });

    const result = await makeService().createSession({
      userId: 'u1',
      executionSelection: {
        routeId: 'codex-subscription',
        catalogueRevision: 'r1',
        modelId: 'runtime-gpt-next',
        controls: { effort: 'high' },
      },
    });

    expect(result.model.id).toBe('pricing-gpt-next');
    expect(modelConfigPort.getByModelName).toHaveBeenCalledWith('gpt-next');
    expect(sessionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gpt-next',
      flags: expect.objectContaining({
        execution_profile: expect.objectContaining({
          routeId: 'codex-subscription',
          effectiveModel: 'runtime-gpt-next',
          pricingModelId: 'pricing-gpt-next',
          controls: { effort: 'high' },
        }),
      }),
    }));
  });

  it('binds a composition-owned default for a server-owned root session', async () => {
    const externalResolver = {
      backend: 'codex-app-server',
      resolve: vi.fn(),
      unavailableReason: () => null,
      accountingPolicy: () => ({
        accountingMode: 'external-subscription',
        consumesPlatformCredits: false,
        requiresPlatformCreditAdmission: false,
      }),
    } as any;
    registerExecutionAdapter({
      routeId: 'codex-subscription',
      readCapabilities: async () => {
        throw new Error('not used');
      },
      bind: async (selection) => ({
        resolver: externalResolver,
        profile: {
          version: 1,
          routeId: selection.routeId,
          catalogueRevision: selection.catalogueRevision,
          providerIdentity: 'OPENAI',
          executionBackend: 'codex-app-server',
          authMode: 'external-subscription',
          accountingMode: 'external-subscription',
          consumesPlatformCredits: false,
          requiresPlatformCreditAdmission: false,
          requestedModel: selection.modelId,
          effectiveModel: selection.modelId,
          controls: selection.controls,
          faultDomain: 'external:codex',
        },
      }),
      resolverFor: async () => externalResolver,
    });
    registerExecutionSelectionDefaultResolver((subject) => {
      expect(subject).toEqual({ userId: 'u1', organizationId: 'org-1' });
      return {
        routeId: 'codex-subscription',
        catalogueRevision: 'r1',
        modelId: 'gpt-5.6-sol',
        controls: { effort: 'high' },
      };
    });
    modelConfigPort.getByModelName.mockResolvedValue({
      id: 'pricing-gpt-sol',
      modelName: 'gpt-5.6-sol',
      provider: 'OPENAI',
      apiKey: null,
      isActive: false,
      selectionCategory: 'high',
    });

    await makeService().createSession({
      userId: 'u1',
      organizationId: 'org-1',
    });

    expect(sessionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gpt-5.6-sol',
      flags: expect.objectContaining({
        execution_profile: expect.objectContaining({
          routeId: 'codex-subscription',
          effectiveModel: 'gpt-5.6-sol',
          executionBackend: 'codex-app-server',
          pricingModelId: 'pricing-gpt-sol',
        }),
      }),
    }));
  });
});
