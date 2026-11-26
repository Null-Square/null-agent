/**
 * The runtime registration seam: a session is admitted and executed under one runtime.
 *
 * These tests exist to pin the properties that make a process-level registration acceptable rather
 * than the global mutable it superficially resembles. If any of them stops holding, a session could
 * be admitted under one runtime and executed under another.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionRuntimeRegistrationError,
  __resetExecutionRuntimeForTests,
  apiUnavailableReason,
  executionAccountingPolicy,
  executionUnavailableReason,
  bindExecutionSelection,
  executionResolverForProfile,
  inspectRegisteredExecutionCapabilities,
  listRegisteredExecutionCapabilities,
  readSessionExecutionProfile,
  registerExecutionAdapter,
  registerExecutionSelectionDefaultResolver,
  registerExecutionRuntime,
  registeredExecutionRuntime,
  resolveExecutionSelectionDefault,
} from '@/domains/agent-brain/domain/runtime/ExecutionRuntimeRegistry';
import type { ModelConfig, ModelExecutionResolverPort } from '@/domains/agent-brain/ports';

const model = (over: Partial<ModelConfig> = {}): ModelConfig =>
  ({
    id: 'm1',
    modelName: 'gpt-x',
    provider: 'OPENAI',
    isActive: true,
    apiKey: 'sk-real',
    ...over,
  }) as ModelConfig;

const fakeRuntime = (backend: string): ModelExecutionResolverPort =>
  ({
    backend,
    resolve: async () => {
      throw new Error('not used');
    },
    unavailableReason: () => null,
    accountingPolicy: () => ({
      accountingMode: 'external-subscription',
      consumesPlatformCredits: false,
      requiresPlatformCreditAdmission: false,
    }),
  }) as unknown as ModelExecutionResolverPort;

afterEach(() => {
  __resetExecutionRuntimeForTests();
});

describe('an unregistered process is byte-identical to the one that shipped before this existed', () => {
  it('applies the API rule', () => {
    expect(executionUnavailableReason(model())).toBeNull();
    expect(executionUnavailableReason(model({ apiKey: '   ' }))?.code).toBe('missing_api_key');
    expect(executionUnavailableReason(model({ isActive: false }))?.code).toBe('inactive');
    expect(executionUnavailableReason(null)?.code).toBe('unknown_model');
  });

  it('reproduces the exact message SessionService used to build inline', () => {
    // A refactor that changes a user-visible error is a behaviour change wearing a refactor's
    // clothes, and this is the message customers see on a misconfigured model.
    expect(executionUnavailableReason(model({ apiKey: null }))?.detail).toBe(
      'Selected model gpt-x is missing apiKey in database',
    );
  });

  it('requires platform credit admission', () => {
    expect(executionAccountingPolicy()).toEqual({
      accountingMode: 'platform',
      consumesPlatformCredits: true,
      requiresPlatformCreditAdmission: true,
    });
  });

  it('reports no registration', () => {
    expect(registeredExecutionRuntime()).toBeNull();
  });
});

describe('a registered runtime governs availability and accounting', () => {
  it('answers availability itself — an API key is a fact about a different backend', () => {
    registerExecutionRuntime(fakeRuntime('codex-app-server'));
    // A dev database with no keys at all is the normal case this project exists to serve.
    expect(executionUnavailableReason(model({ apiKey: null }))).toBeNull();
  });

  it('turns off platform credit admission and debit', () => {
    registerExecutionRuntime(fakeRuntime('codex-app-server'));
    expect(executionAccountingPolicy()).toEqual({
      accountingMode: 'external-subscription',
      consumesPlatformCredits: false,
      requiresPlatformCreditAdmission: false,
    });
  });
});

describe('the properties that keep this from being a global mutable', () => {
  it('refuses a second, different registration', () => {
    // A runtime that can be swapped mid-process is a runtime a request could swap.
    registerExecutionRuntime(fakeRuntime('codex-app-server'));
    expect(() => registerExecutionRuntime(fakeRuntime('api'))).toThrow(ExecutionRuntimeRegistrationError);
  });

  it('accepts re-registering the identical resolver, so a double boot is not a crash', () => {
    const runtime = fakeRuntime('codex-app-server');
    registerExecutionRuntime(runtime);
    expect(() => registerExecutionRuntime(runtime)).not.toThrow();
  });

  it('refuses a registration after the runtime has already been read', () => {
    // Otherwise a session admitted under one runtime could execute under another, and the
    // accounting would describe a call that never happened.
    executionUnavailableReason(model());
    expect(() => registerExecutionRuntime(fakeRuntime('codex-app-server'))).toThrow(/already been read/);
  });

  it('names the runtime already registered, so the error says what happened', () => {
    registerExecutionRuntime(fakeRuntime('codex-app-server'));
    expect(() => registerExecutionRuntime(fakeRuntime('api'))).toThrow(/codex-app-server/);
  });
});

describe('apiUnavailableReason is the one statement of the API rule', () => {
  it('matches what the registry falls back to', () => {
    // Two copies of this rule would drift, and a drifted availability rule admits sessions that
    // cannot run or rejects ones that can.
    for (const candidate of [model(), model({ apiKey: '' }), model({ isActive: false }), null]) {
      expect(executionUnavailableReason(candidate)).toEqual(apiUnavailableReason(candidate));
    }
  });
});

describe('per-session execution adapter catalogue', () => {
  it('accepts adapter-owned backend identifiers without a core type change', () => {
    expect(fakeRuntime('claude-agent-sdk').backend).toBe('claude-agent-sdk');
  });

  it('fails closed on a malformed persisted profile instead of drifting to API', () => {
    expect(() => readSessionExecutionProfile({ execution_profile: { version: 2 } })).toThrow(
      /malformed or unsupported/,
    );
  });

  it('returns a frozen copy of valid persisted execution truth', () => {
    const profile = readSessionExecutionProfile({
      execution_profile: {
        version: 1,
        routeId: 'codex-subscription',
        catalogueRevision: 'r1',
        providerIdentity: 'OPENAI',
        executionBackend: 'codex-app-server',
        authMode: 'external-subscription',
        accountingMode: 'external-subscription',
        consumesPlatformCredits: true,
        requiresPlatformCreditAdmission: true,
        requestedModel: 'gpt-next',
        effectiveModel: 'gpt-next',
        pricingModelId: 'model-row-1',
        controls: { effort: 'high' },
        faultDomain: 'external:codex',
      },
    });

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile?.controls)).toBe(true);
  });

  it('binds an atomic selection and later resolves from the persisted profile', async () => {
    const runtime = fakeRuntime('codex-app-server');
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
        resolver: runtime,
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
      resolverFor: async () => runtime,
    });

    const bound = await bindExecutionSelection({
      routeId: 'codex-subscription',
      catalogueRevision: 'r1',
      modelId: 'gpt-next',
      controls: { effort: 'high' },
    });
    const profile = { ...bound.profile, pricingModelId: 'model-row-1' };
    expect(profile).toMatchObject({
      routeId: 'codex-subscription',
      effectiveModel: 'gpt-next',
      controls: { effort: 'high' },
    });
    expect(await executionResolverForProfile(profile, fakeRuntime('api'))).toBe(runtime);
  });

  it('becomes immutable when capabilities are observed', async () => {
    await listRegisteredExecutionCapabilities();
    expect(() =>
      registerExecutionAdapter({
        routeId: 'late-route',
        readCapabilities: async () => {
          throw new Error('not used');
        },
        bind: async () => {
          throw new Error('not used');
        },
        resolverFor: async () => {
          throw new Error('not used');
        },
      }),
    ).toThrow(/composition-time only/);
  });

  it('reports one unavailable route without hiding healthy routes', async () => {
    registerExecutionAdapter({
      routeId: 'healthy-route',
      readCapabilities: async () => ({
        routeId: 'healthy-route',
        displayName: 'Healthy',
        providerIdentity: 'TEST',
        executionBackend: 'test',
        authMode: 'external-subscription',
        accountingMode: 'external-subscription',
        catalogueRevision: 'healthy-v1',
        models: [],
      }),
      bind: async () => {
        throw new Error('not used');
      },
      resolverFor: async () => {
        throw new Error('not used');
      },
    });
    registerExecutionAdapter({
      routeId: 'unavailable-route',
      readCapabilities: async () => {
        throw new Error('login required');
      },
      bind: async () => {
        throw new Error('not used');
      },
      resolverFor: async () => {
        throw new Error('not used');
      },
    });

    expect(await inspectRegisteredExecutionCapabilities()).toEqual([
      {
        routeId: 'healthy-route',
        capabilities: expect.objectContaining({ routeId: 'healthy-route' }),
      },
      { routeId: 'unavailable-route', unavailableReason: 'login required' },
    ]);
  });
});

describe('composition-owned execution selection default', () => {
  it('is absent in the normal production-equivalent composition', async () => {
    await expect(
      resolveExecutionSelectionDefault({ organizationId: 'org-1', userId: 'user-1' }),
    ).resolves.toBeUndefined();
  });

  it('resolves by actor without changing the registered adapter catalogue', async () => {
    const selection = {
      routeId: 'codex-subscription',
      catalogueRevision: 'r1',
      modelId: 'gpt-sol',
      controls: { effort: 'high' },
    };
    registerExecutionSelectionDefaultResolver((subject) =>
      subject.organizationId === 'org-1' && subject.userId === 'user-1' ? selection : undefined,
    );

    await expect(
      resolveExecutionSelectionDefault({ organizationId: 'org-1', userId: 'user-1' }),
    ).resolves.toEqual(selection);
    await expect(
      resolveExecutionSelectionDefault({ organizationId: 'org-1', userId: 'user-2' }),
    ).resolves.toBeUndefined();
  });

  it('refuses late registration after a session has observed the production default', async () => {
    await resolveExecutionSelectionDefault({ organizationId: 'org-1', userId: 'user-1' });
    expect(() => registerExecutionSelectionDefaultResolver(() => undefined)).toThrow(/composition-time only/);
  });
});
