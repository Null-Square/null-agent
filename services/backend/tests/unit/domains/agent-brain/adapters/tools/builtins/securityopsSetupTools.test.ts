import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import {
  AddScopeTarget,
  CreateScopeAutomation,
  ReadSetupState,
  UpdateOrganizationContext,
  UpdateScopeBrief,
} from '@/domains/agent-brain/adapters/tools/builtins/securityops/setup';
import { ReadScopeDocument } from '@/domains/agent-brain/adapters/tools/builtins/securityops/setupDocuments';

const mocks = vi.hoisted(() => ({
  buildForUser: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  updateOrganization: vi.fn(),
  getOrgContext: vi.fn(),
  addTarget: vi.fn(),
  countAutomations: vi.fn(),
  createAutomation: vi.fn(),
  enforceAutomationCreation: vi.fn(),
  enforcePrivateRunnerAccess: vi.fn(),
  enforceModelCategoryAccess: vi.fn(),
  getModel: vi.fn(),
  listModelsForCategory: vi.fn(),
  detectPlatform: vi.fn(),
  listDocuments: vi.fn(),
  readDocument: vi.fn(),
}));

vi.mock('@/domains/agent-brain/adapters/tools/builtins/securityopsServiceRegistry', () => ({
  getSetupReadinessService: () => ({ buildForUser: mocks.buildForUser }),
  getScopeService: () => ({
    getById: mocks.getById,
    update: mocks.update,
    addTarget: mocks.addTarget,
  }),
  getOrganizationService: () => ({
    getOrgContext: mocks.getOrgContext,
    update: mocks.updateOrganization,
  }),
  getAutomationService: () => ({
    countAutomations: mocks.countAutomations,
    createAutomation: mocks.createAutomation,
  }),
  getAccessControlService: () => ({
    enforceAutomationCreation: mocks.enforceAutomationCreation,
    enforcePrivateRunnerAccess: mocks.enforcePrivateRunnerAccess,
    enforceModelCategoryAccess: mocks.enforceModelCategoryAccess,
  }),
  getModelConfigPort: () => ({
    getModel: mocks.getModel,
    listModelsForCategory: mocks.listModelsForCategory,
  }),
  getWebsitePlatformDetectionService: () => ({ detect: mocks.detectPlatform }),
  getScopeDocumentService: () => ({
    listForScope: mocks.listDocuments,
    readDocument: mocks.readDocument,
  }),
}));

const baseScope = {
  id: 'scope-1',
  organizationId: 'org-1',
  name: 'Prod',
  status: 'active',
  executionNetwork: 'external',
  safeMode: true,
  mission: null,
  stealthPosture: 'coordinated',
  impactTolerance: 'non_destructive',
  rateLimitRps: null,
  blastWindow: null,
  roeDocument: null,
  complianceFrameworks: [],
  createdAt: new Date('2026-07-12T00:00:00.000Z'),
  updatedAt: new Date('2026-07-12T00:00:00.000Z'),
  whiteboxEnabled: false,
  connectedRepoCount: 0,
  accessMaterialCount: 0,
  targetCount: 0,
  verifiedTargetCount: 0,
  attachedRunner: null,
};

const makeCtx = (): ToolContext => ({
  sessionId: 'session-1',
  workspaceDir: '/tmp/session-1',
  sandbox: {} as never,
  sessionStore: {
    get: vi.fn(() => ({
      id: 'session-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
        },
      },
    })),
  } as never,
  streamBroker: {} as never,
  trace: undefined,
  approvals: { require: vi.fn() },
  checkpoints: undefined,
  guards: {} as never,
  policies: {
    requireApproval: false,
    maxStdoutBytes: 10_000,
    timeoutMs: 10_000,
  },
  flags: {
    securityops: {
      organizationId: 'org-1',
      scopeId: 'scope-1',
    },
  } as never,
  planRuntime: {} as never,
  abortSignal: new AbortController().signal,
});

describe('securityops setup tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockResolvedValue({
      scope: baseScope,
      targets: [],
    });
    mocks.buildForUser.mockResolvedValue({
      level: 'blocked',
      organization: { id: 'org-1', name: 'Acme' },
      scope: { id: 'scope-1', name: 'Prod' },
    });
    mocks.getOrgContext.mockResolvedValue({
      name: 'Acme',
      context: 'SaaS company with production app.',
    });
    mocks.countAutomations.mockResolvedValue(0);
    mocks.enforceAutomationCreation.mockResolvedValue(undefined);
    mocks.enforcePrivateRunnerAccess.mockResolvedValue(undefined);
    mocks.enforceModelCategoryAccess.mockResolvedValue(undefined);
    mocks.getModel.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      modelName: 'test-model',
      provider: 'openai',
      isActive: true,
      selectionCategory: 'medium',
    });
    mocks.listModelsForCategory.mockResolvedValue([{
      id: '22222222-2222-4222-8222-222222222222',
      modelName: 'category-model',
      provider: 'openai',
      isActive: true,
      selectionCategory: 'medium',
    }]);
    mocks.detectPlatform.mockResolvedValue({
      domain: 'example.com',
      siteUrl: 'https://example.com',
      detectedProvider: null,
      recommendation: {
        method: 'manual',
        provider: null,
        confidence: 'low',
        label: 'Manual verification',
        description: 'Use DNS TXT or HTTP file verification for this domain.',
        evidence: [],
        fallbackMethods: ['dns_txt', 'http_well_known'],
      },
      signals: {
        statusCode: null,
        finalUrl: null,
        cnameRecords: [],
        matchedMarkers: [],
      },
    });
    mocks.listDocuments.mockResolvedValue([]);
    mocks.readDocument.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      scopeId: 'scope-1',
      kind: 'roe',
      fileName: 'roe.md',
      parseStatus: 'parsed',
      content: 'Only non-destructive testing is allowed.',
      nextOffset: null,
    });
  });

  it('reads setup state for the selected scope', async () => {
    const result = await ReadSetupState.run({}, makeCtx());

    expect(result.ok).toBe(true);
    expect(mocks.buildForUser).toHaveBeenCalledWith({
      userId: 'user-1',
      scopeId: 'scope-1',
    });
    expect(mocks.getById).toHaveBeenCalledWith('org-1', 'scope-1');
    expect(mocks.getOrgContext).toHaveBeenCalledWith('org-1');
    expect(mocks.listDocuments).toHaveBeenCalledWith('org-1', 'scope-1');
    expect(result.data).toMatchObject({
      organization: {
        id: 'org-1',
        name: 'Acme',
        operationalContext: 'SaaS company with production app.',
      },
      documents: [],
    });
  });

  it('reads a bounded setup document chunk for the selected scope', async () => {
    const result = await ReadScopeDocument.run(
      {
        documentId: '11111111-1111-4111-8111-111111111111',
        maxChars: 500,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(mocks.readDocument).toHaveBeenCalledWith({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      documentId: '11111111-1111-4111-8111-111111111111',
      offset: undefined,
      maxChars: 500,
    });
    expect(result.data).toMatchObject({
      document: {
        content: 'Only non-destructive testing is allowed.',
      },
    });
  });

  it('names the detected platform and recommends DNS TXT verification in setup state targets', async () => {
    mocks.getById.mockResolvedValue({
      scope: { ...baseScope, targetCount: 1 },
      targets: [
        {
          id: 'target-1',
          type: 'domain',
          value: 'example.com',
          verified: false,
          verificationMethod: 'dns_txt',
          verifiedAt: null,
        },
      ],
    });
    mocks.detectPlatform.mockResolvedValue({
      domain: 'example.com',
      siteUrl: 'https://example.com',
      detectedProvider: 'wix',
      recommendation: {
        method: 'manual',
        provider: 'wix',
        confidence: 'high',
        label: 'Manual verification',
        description: 'This domain looks like Wix. Use DNS TXT or HTTP file verification for this domain.',
        evidence: ['Wix page marker'],
        fallbackMethods: ['dns_txt', 'http_well_known'],
      },
      signals: {
        statusCode: 200,
        finalUrl: 'https://example.com',
        cnameRecords: [],
        matchedMarkers: ['Wix page marker'],
      },
    });

    const result = await ReadSetupState.run({}, makeCtx());

    expect(result.ok).toBe(true);
    expect(mocks.detectPlatform).toHaveBeenCalledWith('example.com');
    expect(result.data).toMatchObject({
      targets: [
        {
          id: 'target-1',
          verificationRecommendation: {
            provider: 'wix',
            providerLabel: 'Wix',
            fastestMethod: 'dns_txt',
            guidance: expect.stringContaining('DNS TXT verification'),
          },
        },
      ],
    });
  });

  it('updates organization context for the current organization', async () => {
    mocks.updateOrganization.mockResolvedValue({
      id: 'org-1',
      name: 'Acme Security',
      operationalContext: 'B2B SaaS with strict production change windows.',
    });

    const result = await UpdateOrganizationContext.run(
      {
        name: 'Acme Security',
        operationalContext: 'B2B SaaS with strict production change windows.',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(mocks.updateOrganization).toHaveBeenCalledWith('org-1', {
      name: 'Acme Security',
      operationalContext: 'B2B SaaS with strict production change windows.',
    });
  });

  it('updates only the selected scope brief', async () => {
    mocks.update.mockResolvedValue({
      ...baseScope,
      mission: 'Assess the production app.',
      rateLimitRps: 5,
    });

    const result = await UpdateScopeBrief.run(
      {
        mission: 'Assess the production app.',
        impactTolerance: 'non_destructive',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith('org-1', 'scope-1', {
      mission: 'Assess the production app.',
      impactTolerance: 'non_destructive',
    });
  });

  it('verifies selected scope ownership before adding a target', async () => {
    mocks.addTarget.mockResolvedValue({
      id: 'target-1',
      type: 'domain',
      value: 'example.com',
      verified: false,
      verificationMethod: 'dns_txt',
      verificationToken: 'token-1',
      verifiedAt: null,
    });

    const result = await AddScopeTarget.run(
      { type: 'domain', value: 'https://www.example.com' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(mocks.getById).toHaveBeenCalledWith('org-1', 'scope-1');
    expect(mocks.addTarget).toHaveBeenCalledWith('scope-1', {
      type: 'domain',
      value: 'https://www.example.com',
      verificationMethod: undefined,
    });
  });

  it('creates automations inactive by default', async () => {
    mocks.createAutomation.mockResolvedValue({
      id: 'automation-1',
      isActive: false,
      triggerType: 'scheduled',
    });

    const result = await CreateScopeAutomation.run(
      {
        name: 'Weekly readiness review',
        goal: 'Review scope readiness.',
        triggerType: 'scheduled',
        triggerConfig: { cron: '0 9 * * 1', timezone: 'UTC' },
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(mocks.countAutomations).toHaveBeenCalledWith('org-1');
    expect(mocks.enforceAutomationCreation).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      existingAutomationCount: 0,
    });
    expect(mocks.enforceModelCategoryAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      requestedModelCategory: null,
    });
    expect(mocks.createAutomation).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      expect.objectContaining({
        scopeId: 'scope-1',
        isActive: false,
      }),
    );
  });

  it('blocks chat-created automations when the subscription gate denies access', async () => {
    mocks.enforceAutomationCreation.mockRejectedValue(new Error('Automations are not available on your plan'));

    const result = await CreateScopeAutomation.run(
      {
        name: 'Weekly readiness review',
        goal: 'Review scope readiness.',
        triggerType: 'scheduled',
        triggerConfig: { cron: '0 9 * * 1', timezone: 'UTC' },
      },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      error: expect.stringContaining('Automations are not available on your plan'),
    });
    expect(mocks.createAutomation).not.toHaveBeenCalled();
  });
});
