import type { ModelCategory } from '@null-ai/contracts';
import type { SubscriptionRecord } from './subscriptionService';
import { parseExperienceProfile, type ExperienceProfile } from './experienceProfile';

export const PLAN_ENTITLEMENTS_SCHEMA = 'nullsquare.plan-entitlements.v1' as const;

export type PlanEntitlementFeatureId =
  | 'automations'
  | 'privateRunners'
  | 'githubIntegrations'
  | 'compliance'
  | 'codeReview'
  | 'threatWatch'
  | 'runObservability';

export type PlanEntitlementFeature = {
  available: boolean;
  feature: string;
  label: string;
  reason: string | null;
};

export type PlanEntitlementSnapshot = {
  schema: typeof PLAN_ENTITLEMENTS_SCHEMA;
  plan: {
    slug: string;
    name: string;
  };
  experienceProfile: ExperienceProfile;
  features: Record<PlanEntitlementFeatureId, PlanEntitlementFeature>;
  limits: {
    maxConcurrentRuns: number | null;
    maxActiveScopes: number | null;
    maxAutomations: number | null;
    maxOrganizationUsers: number | null;
    allowedModelCategories: ModelCategory[] | null;
  };
};

const feature = (
  available: boolean | undefined,
  featureKey: string,
  label: string,
  planSlug: string,
): PlanEntitlementFeature => {
  const isAvailable = available === true;
  return {
    available: isAvailable,
    feature: featureKey,
    label,
    reason: isAvailable ? null : `${label} is not available on the ${planSlug} plan.`,
  };
};

export const buildPlanEntitlementSnapshot = (
  subscription: SubscriptionRecord,
): PlanEntitlementSnapshot => {
  const plan = subscription.plan;
  const features = plan.features ?? {};
  const limits = plan.limits ?? {};

  return {
    schema: PLAN_ENTITLEMENTS_SCHEMA,
    plan: {
      slug: plan.slug,
      name: plan.name,
    },
    experienceProfile: parseExperienceProfile(plan.experienceProfile),
    features: {
      automations: feature(features.accessAutomations, 'accessAutomations', 'Automations', plan.slug),
      privateRunners: feature(features.accessPrivateRunners, 'accessPrivateRunners', 'Private runners', plan.slug),
      githubIntegrations: feature(
        features.accessGitHubIntegrations,
        'accessGitHubIntegrations',
        'Connected repositories',
        plan.slug,
      ),
      compliance: feature(features.accessCompliance, 'accessCompliance', 'Compliance', plan.slug),
      codeReview: feature(features.accessCodeReview, 'accessCodeReview', 'Code review', plan.slug),
      threatWatch: feature(
        features.accessThreatWatch,
        'accessThreatWatch',
        'Continuous exposure monitoring',
        plan.slug,
      ),
      runObservability: feature(
        features.accessRunObservability,
        'accessRunObservability',
        'Run terminal and activity details',
        plan.slug,
      ),
    },
    limits: {
      maxConcurrentRuns: limits.maxConcurrentRuns ?? null,
      maxActiveScopes: limits.maxActiveScopes ?? null,
      maxAutomations: limits.maxAutomations ?? null,
      maxOrganizationUsers: limits.maxOrganizationUsers ?? null,
      allowedModelCategories: limits.allowedModelCategories ?? null,
    },
  };
};
