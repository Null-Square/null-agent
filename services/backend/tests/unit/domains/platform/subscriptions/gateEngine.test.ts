import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@null-ai/contracts';
import { AppError } from '@/shared/errors';
import {
  evaluateAutomationCreation,
  evaluateCodeReviewAccess,
  evaluateComplianceAccess,
  evaluateGitHubIntegrationAccess,
  evaluateModelCategoryAccess,
  evaluateOrganizationUserLimit,
  evaluatePrivateRunnerAccess,
  evaluateRunObservabilityAccess,
  evaluateRunCreation,
  evaluateScopeConfiguration,
  evaluateScopeCreation,
  evaluateSessionCreation,
  evaluateThreatWatchAccess,
  evaluateWorkbenchAccess,
} from '@/domains/platform/subscriptions/gateEngine';
import type { SubscriptionPlan, SubscriptionRecord } from '@/domains/platform/subscriptions/subscriptionService';

const basePlan: SubscriptionPlan = {
  id: 'plan-1',
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
    maxAutomations: 1,
    maxOrganizationUsers: 1,
    allowedModelCategories: ['low'],
  },
};

const makeSub = (overrides?: Partial<SubscriptionPlan>): SubscriptionRecord => ({
  userId: 'u1',
  plan: {
    ...basePlan,
    ...overrides,
    features: { ...basePlan.features, ...overrides?.features },
    limits: { ...basePlan.limits, ...overrides?.limits },
  },
});

function expectGateError(
  result: { allowed: boolean; error?: AppError },
  code: string,
  status: number,
): asserts result is { allowed: false; error: AppError } {
  expect(result.allowed).toBe(false);
  expect(result.error).toBeInstanceOf(AppError);
  expect(result.error?.code).toBe(code);
  expect(result.error?.httpStatus).toBe(status);
}

describe('gateEngine', () => {
  describe('experience profile boundary', () => {
    const resultsSubscription = () => makeSub({
      slug: 'watch',
      experienceProfile: 'results',
      features: {
        accessAutomations: true,
        accessPrivateRunners: true,
        accessGitHubIntegrations: true,
        accessCompliance: true,
        accessCodeReview: true,
        accessThreatWatch: true,
        accessRunObservability: true,
      },
      limits: {
        maxConcurrentRuns: 1,
        maxActiveScopes: 1,
        maxAutomations: 1,
        allowedModelCategories: ['low'],
      },
    });

    it('denies workbench execution even when redundant feature flags would allow it', () => {
      const subscription = resultsSubscription();
      for (const result of [
        evaluateWorkbenchAccess({ subscription }),
        evaluateSessionCreation({ subscription, requestedModelCategory: 'low' }),
        evaluateRunCreation({ subscription, requestedModelCategory: 'low', activeRunCount: 0 }),
        evaluateScopeCreation({ subscription, activeScopeCount: 0 }),
        evaluateAutomationCreation({ subscription, existingAutomationCount: 0 }),
      ]) {
        expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
        expect(result.error.context).toMatchObject({
          feature: 'experienceProfile',
          currentExperience: 'results',
          requiredExperience: 'workbench',
        });
      }
    });

    it('allows Threat Watch read entitlement without granting workbench access', () => {
      const subscription = resultsSubscription();
      expect(evaluateThreatWatchAccess({ subscription }).allowed).toBe(true);
      expect(evaluateWorkbenchAccess({ subscription }).allowed).toBe(false);
    });

    it('fails a missing experience profile closed', () => {
      const subscription = makeSub({ experienceProfile: undefined });
      const result = evaluateRunCreation({ subscription, activeRunCount: 0 });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
      expect(result.error.context).toMatchObject({ currentExperience: 'inactive' });
    });
  });

  describe('evaluateSessionCreation', () => {
    it('never refuses a session for credits: Null AI has none', () => {
      const result = evaluateSessionCreation({ subscription: makeSub(), requestedModelCategory: 'low' });
      expect(result.allowed).toBe(true);
    });

    it('blocks when the requested model category is not included in the plan', () => {
      const result = evaluateSessionCreation({
        subscription: makeSub(),
        requestedModelCategory: 'medium',
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
      expect(result.error?.context).toMatchObject({
        feature: 'allowedModelCategories',
        requestedModelCategory: 'medium',
        allowedModelCategories: ['low'],
      });
    });
  });

  describe('evaluateRunCreation', () => {
    it('blocks when concurrent run limit is reached', () => {
      const result = evaluateRunCreation({
        subscription: makeSub({ limits: { maxConcurrentRuns: 2 } }),
        activeRunCount: 2,
      });
      expectGateError(result, ERROR_CODES.RESOURCE_LIMIT_REACHED, 429);
    });

    it('allows Plus low and medium model categories but blocks high', () => {
      const plusSub = makeSub({
        slug: 'control',
        features: { accessAutomations: true },
        limits: { allowedModelCategories: ['low', 'medium'] },
      });

      expect(evaluateRunCreation({ subscription: plusSub, requestedModelCategory: 'medium' }).allowed).toBe(true);

      const result = evaluateRunCreation({
        subscription: plusSub,
        requestedModelCategory: 'high',
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
    });
  });

  describe('evaluateScopeCreation', () => {
    it('blocks when active scope limit is reached', () => {
      const result = evaluateScopeCreation({
        subscription: makeSub({ limits: { maxActiveScopes: 1 } }),
        activeScopeCount: 1,
      });
      expectGateError(result, ERROR_CODES.RESOURCE_LIMIT_REACHED, 403);
    });
  });

  describe('evaluateScopeConfiguration', () => {
    it('blocks private-runner scope configuration when the feature is unavailable', () => {
      const result = evaluateScopeConfiguration({
        subscription: makeSub(),
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
    });
  });

  describe('evaluatePrivateRunnerAccess', () => {
    it('blocks private runner access when the plan does not allow it', () => {
      const result = evaluatePrivateRunnerAccess({
        subscription: makeSub(),
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
    });
  });

  describe('evaluateAutomationCreation', () => {
    it('blocks when automations are disabled', () => {
      const result = evaluateAutomationCreation({
        subscription: makeSub(),
        existingAutomationCount: 0,
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
    });

    it('allows existing automations when the feature is enabled', () => {
      const result = evaluateAutomationCreation({
        subscription: makeSub({
          features: { accessAutomations: true },
          limits: { maxAutomations: 100 },
        }),
        existingAutomationCount: 99,
      });
      expect(result.allowed).toBe(true);
    });

    it('blocks when automation count reaches the plan limit', () => {
      const result = evaluateAutomationCreation({
        subscription: makeSub({
          features: { accessAutomations: true },
          limits: { maxAutomations: 1 },
        }),
        existingAutomationCount: 1,
      });
      expectGateError(result, ERROR_CODES.RESOURCE_LIMIT_REACHED, 403);
    });
  });

  describe('evaluateGitHubIntegrationAccess', () => {
    it('blocks repository assignment when the plan does not allow it', () => {
      const result = evaluateGitHubIntegrationAccess({
        subscription: makeSub(),
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
    });
  });

  describe('evaluateComplianceAccess', () => {
    it('blocks compliance when the plan does not allow it', () => {
      const result = evaluateComplianceAccess({
        subscription: makeSub(),
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
    });
  });

  describe('evaluateCodeReviewAccess', () => {
    it('blocks code review when the plan does not allow it', () => {
      const result = evaluateCodeReviewAccess({
        subscription: makeSub(),
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
    });
  });

  describe('evaluateRunObservabilityAccess', () => {
    it('blocks run terminal and activity details when the plan does not allow them', () => {
      const result = evaluateRunObservabilityAccess({
        subscription: makeSub(),
      });
      expectGateError(result, ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403);
      expect(result.error?.context).toMatchObject({
        feature: 'accessRunObservability',
      });
    });
  });

  describe('evaluateModelCategoryAccess', () => {
    it('allows all model categories when the plan has unrestricted model access', () => {
      const result = evaluateModelCategoryAccess({
        subscription: makeSub({ limits: { allowedModelCategories: null } }),
        requestedModelCategory: 'extra_high',
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('evaluateOrganizationUserLimit', () => {
    it('blocks invites once current and pending users reach the plan limit', () => {
      const result = evaluateOrganizationUserLimit({
        subscription: makeSub(),
        currentOrganizationUserCount: 1,
        pendingOrganizationInviteCount: 0,
      });
      expectGateError(result, ERROR_CODES.RESOURCE_LIMIT_REACHED, 403);
      expect(result.error?.context).toMatchObject({
        feature: 'maxOrganizationUsers',
        currentUsers: 1,
        pendingInvites: 0,
        limit: 1,
      });
    });
  });
});
