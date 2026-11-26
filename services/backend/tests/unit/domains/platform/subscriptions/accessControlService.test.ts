import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@null-ai/contracts';
import { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import type { SubscriptionRecord } from '@/domains/platform/subscriptions/subscriptionService';

const makeSub = (overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  userId: 'u1',
  plan: {
    id: 'p1',
    name: 'Starter',
    slug: 'inactive',
    experienceProfile: 'workbench',
    features: {
      accessAutomations: false,
      accessPrivateRunners: false,
      accessGitHubIntegrations: false,
      accessCompliance: false,
      accessCodeReview: false,
      accessRunObservability: false,
    },
    limits: {
      maxConcurrentRuns: 1,
      maxActiveScopes: 1,
      maxAutomations: 0,
      maxOrganizationUsers: 1,
      allowedModelCategories: ['low'],
    },
  },
  ...overrides,
});

const makeService = (sub: SubscriptionRecord) =>
  new AccessControlService({
    resolveOrganizationSubscription: vi.fn().mockResolvedValue(sub),
    resolveAnonymousSubscription: vi.fn().mockReturnValue(sub),
  } as any);

describe('AccessControlService', () => {
  it('admits a session without any credit balance: Null AI charges nothing', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceSessionCreation({ userId: 'u1', organizationId: 'org-1', requestedModelCategory: 'low' }),
    ).resolves.toMatchObject({ userId: 'u1' });
  });

  it('uses the results profile as the single workbench boundary', async () => {
    const svc = makeService(makeSub({
      plan: {
        ...makeSub().plan,
        slug: 'watch',
        experienceProfile: 'results',
        features: {
          ...makeSub().plan.features,
          accessAutomations: true,
        },
      },
    }));

    await expect(
      svc.enforceWorkbenchAccess({ userId: 'u1', organizationId: 'org-1' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
      context: expect.objectContaining({ currentExperience: 'results' }),
    });
  });

  it('enforces concurrent run limits at run creation', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceRunCreation({ userId: 'u1', organizationId: 'org-1', activeRunCount: 1 }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.RESOURCE_LIMIT_REACHED,
      httpStatus: 429,
    });
  });

  it('enforces active scope limits at scope creation', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceScopeCreation({ userId: 'u1', organizationId: 'org-1', activeScopeCount: 1 }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.RESOURCE_LIMIT_REACHED,
      httpStatus: 403,
    });
  });

  it('rejects private-runner scope configuration when the plan does not allow it', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceScopeConfiguration({ userId: 'u1', organizationId: 'org-1' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('rejects private runner access when the plan does not allow it', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforcePrivateRunnerAccess({ userId: 'u1', organizationId: 'org-1' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('rejects repository assignment when the plan does not allow it', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceGitHubIntegrationAccess({ userId: 'u1', organizationId: 'org-1' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('rejects compliance when the plan does not allow it', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceComplianceAccess({ userId: 'u1', organizationId: 'org-1' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('rejects code review when the plan does not allow it', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceCodeReviewAccess({ userId: 'u1', organizationId: 'org-1' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('rejects run terminal and activity details when the plan does not allow them', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceRunObservabilityAccess({ userId: 'u1', organizationId: 'org-1' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('rejects blocked model categories when creating sessions', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceSessionCreation({
        userId: 'u1',
        organizationId: 'org-1',
        requestedModelCategory: 'medium',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('rejects new organization users when the seat limit is reached', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceOrganizationUserLimit({
        userId: 'u1',
        organizationId: 'org-1',
        currentOrganizationUserCount: 1,
        pendingOrganizationInviteCount: 0,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.RESOURCE_LIMIT_REACHED,
      httpStatus: 403,
    });
  });

  it('rejects automations when the plan does not allow them', async () => {
    const svc = makeService(makeSub());

    await expect(
      svc.enforceAutomationCreation({ userId: 'u1', organizationId: 'org-1', existingAutomationCount: 0 }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      httpStatus: 403,
    });
  });

  it('allows enterprise-level features when the plan supports them', async () => {
    const svc = makeService(
      makeSub({
        plan: {
          ...makeSub().plan,
          slug: 'customize',
          features: {
            accessAutomations: true,
            accessPrivateRunners: true,
            accessGitHubIntegrations: true,
            accessCompliance: true,
            accessCodeReview: true,
            accessRunObservability: true,
          },
          limits: {
            maxConcurrentRuns: null,
            maxActiveScopes: null,
            maxAutomations: null,
            maxOrganizationUsers: null,
            allowedModelCategories: null,
          },
        },
      }),
    );

    await expect(svc.enforceSessionCreation({ userId: 'u1', organizationId: 'org-1' })).resolves.not.toThrow();
    await expect(
      svc.enforceRunCreation({ userId: 'u1', organizationId: 'org-1', activeRunCount: 10 }),
    ).resolves.not.toThrow();
    await expect(
      svc.enforceScopeCreation({ userId: 'u1', organizationId: 'org-1', activeScopeCount: 10 }),
    ).resolves.not.toThrow();
    await expect(
      svc.enforceAutomationCreation({ userId: 'u1', organizationId: 'org-1', existingAutomationCount: 25 }),
    ).resolves.not.toThrow();
    await expect(svc.enforceComplianceAccess({ userId: 'u1', organizationId: 'org-1' })).resolves.not.toThrow();
    await expect(svc.enforceCodeReviewAccess({ userId: 'u1', organizationId: 'org-1' })).resolves.not.toThrow();
    await expect(svc.enforceRunObservabilityAccess({ userId: 'u1', organizationId: 'org-1' })).resolves.not.toThrow();
    await expect(
      svc.enforceModelCategoryAccess({
        userId: 'u1',
        organizationId: 'org-1',
        requestedModelCategory: 'extra_high',
      }),
    ).resolves.not.toThrow();
  });
});
