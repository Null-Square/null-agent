import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';

const makeSession = (overrides: Partial<any> = {}) => ({
  id: 's1',
  status: 'idle',
  flags: {},
  ...overrides,
});

const buildService = (sandboxSelection: any, policyFacade: any = undefined) => {
  const session = makeSession();
  const sessionStore = {
    create: vi.fn(async () => session),
    set: vi.fn(),
    remove: vi.fn(),
  };
  const sandboxProfileRegistry = {
    resolveImage: vi.fn(),
  } as any;
  const ports = {
    tasks: {
      getTask: vi.fn(),
      prepareFromManifest: vi.fn(),
    },
  } as any;
  const agentEngine = {
    prepareTask: vi.fn(),
    initializeSession: vi.fn(),
  } as any;
  const subscriptionPort = {
    enforceSessionCreation: vi.fn(),
    resolveSubscription: vi.fn(),
    debitCredits: vi.fn(),
  } as any;
  const modelConfigPort = {
    getDefaultModel: vi.fn(async () => ({ modelName: 'test-model', provider: 'OPENAI', apiKey: 'test-api-key' })),
    getByModelName: vi.fn(),
    listModelsForCategory: vi.fn().mockResolvedValue([]),
  } as any;
  const policyResolver = {} as any;

  return new SessionService(
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
};

describe('SessionService policy errors (sandbox selection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces RESOURCE_NOT_FOUND when requested sandbox profile does not exist', async () => {
    const sandboxSelection = {
      resolve: vi.fn(async () => {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Sandbox policy not found');
      }),
    };
    const policyFacade = {
      resolveBrainPolicy: vi.fn(async () => ({
        profile: 'ghost',
        sandboxProfile: 'ghost',
        toolPolicy: undefined,
        source: 'explicit',
      })),
      getResolver: vi.fn(() => ({
        getBySlug: vi.fn(async () => null),
        getDefaultPolicy: vi.fn(async () => null),
      })),
    };

    const service = buildService(sandboxSelection, policyFacade);

    await expect(service.createSession({ profileKey: 'ghost' })).rejects.toThrow(AppError);
    expect(sandboxSelection.resolve).toHaveBeenCalledWith({ sandboxProfile: 'ghost', sandboxImage: undefined });
  });

  it('surfaces INTERNAL_CONFIGURATION when no default sandbox policy exists', async () => {
    const sandboxSelection = {
      resolve: vi.fn(async () => {
        throw new AppError(ERROR_CODES.INTERNAL_CONFIGURATION, 'No default sandbox policy configured.');
      }),
    };
    const policyFacade = {
      resolveBrainPolicy: vi.fn(async () => ({
        profile: 'default',
        sandboxProfile: undefined,
        toolPolicy: undefined,
        source: 'default',
      })),
      getResolver: vi.fn(() => ({
        getBySlug: vi.fn(async () => null),
        getDefaultPolicy: vi.fn(async () => null),
      })),
    };

    const service = buildService(sandboxSelection, policyFacade);

    await expect(service.createSession({})).rejects.toThrow(AppError);
    expect(sandboxSelection.resolve).toHaveBeenCalledWith({ sandboxProfile: undefined, sandboxImage: undefined });
  });
});







