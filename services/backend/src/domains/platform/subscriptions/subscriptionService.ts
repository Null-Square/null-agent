import { MODEL_CATEGORIES, type ModelCategory } from '@null-ai/contracts';
import type { ExperienceProfile } from './experienceProfile';

export interface TierFeatureFlags {
  accessAutomations?: boolean;
  accessPrivateRunners?: boolean;
  accessGitHubIntegrations?: boolean;
  accessCompliance?: boolean;
  accessCodeReview?: boolean;
  accessThreatWatch?: boolean;
  accessRunObservability?: boolean;
  accessPublicTrustBadge?: boolean;
}

export interface TierLimits {
  maxConcurrentRuns?: number | null;
  maxActiveScopes?: number | null;
  maxAutomations?: number | null;
  maxOrganizationUsers?: number | null;
  allowedModelCategories?: ModelCategory[] | null;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  slug: string;
  experienceProfile?: ExperienceProfile;
  features?: TierFeatureFlags;
  limits?: TierLimits;
}

export interface SubscriptionRecord {
  userId: string;
  organizationId?: string;
  plan: SubscriptionPlan;
}

/**
 * The only plan in Null AI. It runs for one person on their own computer and their own model key,
 * so there is nothing to buy: every feature is on and nothing is limited. This constant is the one
 * owner of the plan; no table stores it and no request can change it.
 */
export const LOCAL_PLAN: Readonly<SubscriptionPlan> = Object.freeze({
  id: 'local',
  name: 'Local',
  slug: 'local',
  experienceProfile: 'workbench',
  features: Object.freeze({
    accessAutomations: true,
    accessPrivateRunners: true,
    accessGitHubIntegrations: true,
    accessCompliance: true,
    accessCodeReview: true,
    accessThreatWatch: true,
    accessRunObservability: true,
    accessPublicTrustBadge: true,
  }),
  limits: Object.freeze({
    maxConcurrentRuns: null,
    maxActiveScopes: null,
    maxAutomations: null,
    maxOrganizationUsers: null,
    allowedModelCategories: [...MODEL_CATEGORIES] as ModelCategory[],
  }),
});

const localPlanCopy = (): SubscriptionPlan => ({
  ...LOCAL_PLAN,
  features: { ...LOCAL_PLAN.features },
  limits: {
    ...LOCAL_PLAN.limits,
    allowedModelCategories: [...(LOCAL_PLAN.limits?.allowedModelCategories ?? [])],
  },
});

type OrganizationSubscriptionOptions = {
  billingContactUserId?: string | null;
};

class SubscriptionService {
  /** Every organization is on the local plan. No database read or write. */
  async resolveOrganizationSubscription(
    organizationId: string,
    opts?: OrganizationSubscriptionOptions,
  ): Promise<SubscriptionRecord> {
    return {
      userId: opts?.billingContactUserId ?? organizationId,
      organizationId,
      plan: localPlanCopy(),
    };
  }

  resolveAnonymousSubscription(userId = 'anonymous'): SubscriptionRecord {
    return { userId, plan: localPlanCopy() };
  }
}

export type { SubscriptionService };

const subscriptionService = new SubscriptionService();
export default subscriptionService;
