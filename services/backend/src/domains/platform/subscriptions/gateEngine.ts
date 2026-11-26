import { AppError } from '@/shared/errors';
import { ERROR_CODES, type ErrorCodeValue, type ModelCategory } from '@null-ai/contracts';
import type { SubscriptionRecord } from './subscriptionService';
import { parseExperienceProfile } from './experienceProfile';

export type GateContext = {
  subscription: SubscriptionRecord;
  activeRunCount?: number;
  activeScopeCount?: number;
  existingAutomationCount?: number;
  executionNetwork?: 'external' | 'internal';
  requestedModelCategory?: ModelCategory | null;
  currentOrganizationUserCount?: number;
  pendingOrganizationInviteCount?: number;
};

export type GateResult = { allowed: true } | { allowed: false; error: AppError };

const buildError = (
  code: ErrorCodeValue,
  status: number,
  message: string,
  context?: Record<string, unknown>,
): AppError => {
  return new AppError(code, message, { httpStatus: status, context });
};

const workbenchExperienceCheck = (subscription: SubscriptionRecord): GateResult => {
  const currentExperience = parseExperienceProfile(subscription.plan.experienceProfile);
  if (currentExperience === 'workbench') {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(
      ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      403,
      'This action is not available in your product experience',
      {
        feature: 'experienceProfile',
        requiredExperience: 'workbench',
        currentExperience,
        currentPlan: subscription.plan.slug,
      },
    ),
  };
};

const concurrentRunsCheck = (
  subscription: SubscriptionRecord,
  activeRunCount = 0,
): GateResult => {
  const maxConcurrentRuns = subscription.plan.limits?.maxConcurrentRuns;
  if (maxConcurrentRuns === null || maxConcurrentRuns === undefined) {
    return { allowed: true };
  }

  if (activeRunCount >= maxConcurrentRuns) {
    return {
      allowed: false,
      error: buildError(
        ERROR_CODES.RESOURCE_LIMIT_REACHED,
        429,
        'Concurrent run limit reached for your plan',
        {
          feature: 'maxConcurrentRuns',
          currentPlan: subscription.plan.slug,
          limit: maxConcurrentRuns,
          activeRuns: activeRunCount,
        },
      ),
    };
  }

  return { allowed: true };
};

const maxActiveScopesCheck = (
  subscription: SubscriptionRecord,
  activeScopeCount = 0,
): GateResult => {
  const maxActiveScopes = subscription.plan.limits?.maxActiveScopes;
  if (maxActiveScopes === null || maxActiveScopes === undefined) {
    return { allowed: true };
  }

  if (activeScopeCount >= maxActiveScopes) {
    return {
      allowed: false,
      error: buildError(ERROR_CODES.RESOURCE_LIMIT_REACHED, 403, 'Active scope limit reached for your plan', {
        feature: 'maxActiveScopes',
        currentPlan: subscription.plan.slug,
        limit: maxActiveScopes,
        activeScopes: activeScopeCount,
      }),
    };
  }

  return { allowed: true };
};

const privateRunnerAccessCheck = (subscription: SubscriptionRecord): GateResult => {
  if (subscription.plan.features?.accessPrivateRunners === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(
      ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      403,
      'Private runners are not available on your plan',
      {
        feature: 'accessPrivateRunners',
        currentPlan: subscription.plan.slug,
      },
    ),
  };
};

const automationFeatureCheck = (subscription: SubscriptionRecord): GateResult => {
  if (subscription.plan.features?.accessAutomations === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403, 'Automations are not available on your plan', {
      feature: 'accessAutomations',
      currentPlan: subscription.plan.slug,
    }),
  };
};

const maxAutomationsCheck = (
  subscription: SubscriptionRecord,
  existingAutomationCount = 0,
): GateResult => {
  const maxAutomations = subscription.plan.limits?.maxAutomations;
  if (maxAutomations === null || maxAutomations === undefined) {
    return { allowed: true };
  }

  if (existingAutomationCount >= maxAutomations) {
    return {
      allowed: false,
      error: buildError(ERROR_CODES.RESOURCE_LIMIT_REACHED, 403, 'Automation limit reached for your plan', {
        feature: 'maxAutomations',
        currentPlan: subscription.plan.slug,
        limit: maxAutomations,
        activeAutomations: existingAutomationCount,
      }),
    };
  }

  return { allowed: true };
};

const githubIntegrationAccessCheck = (subscription: SubscriptionRecord): GateResult => {
  if (subscription.plan.features?.accessGitHubIntegrations === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(
      ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      403,
      'Repository assignment for whitebox analysis is not available on your plan',
      {
        feature: 'accessGitHubIntegrations',
        currentPlan: subscription.plan.slug,
      },
    ),
  };
};

const complianceAccessCheck = (subscription: SubscriptionRecord): GateResult => {
  if (subscription.plan.features?.accessCompliance === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403, 'Compliance is not available on your plan', {
      feature: 'accessCompliance',
      currentPlan: subscription.plan.slug,
    }),
  };
};

const codeReviewAccessCheck = (subscription: SubscriptionRecord): GateResult => {
  if (subscription.plan.features?.accessCodeReview === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403, 'Code review is not available on your plan', {
      feature: 'accessCodeReview',
      currentPlan: subscription.plan.slug,
    }),
  };
};

const threatWatchAccessCheck = (subscription: SubscriptionRecord): GateResult => {
  if (subscription.plan.features?.accessThreatWatch === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(
      ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      403,
      'Continuous exposure monitoring is not available on your plan',
      { feature: 'accessThreatWatch', currentPlan: subscription.plan.slug },
    ),
  };
};

const runObservabilityAccessCheck = (subscription: SubscriptionRecord): GateResult => {
  if (subscription.plan.features?.accessRunObservability === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(
      ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      403,
      'Run terminal and activity details are not available on your plan',
      {
        feature: 'accessRunObservability',
        currentPlan: subscription.plan.slug,
      },
    ),
  };
};

const modelCategoryAccessCheck = (
  subscription: SubscriptionRecord,
  requestedModelCategory?: ModelCategory | null,
): GateResult => {
  if (!requestedModelCategory) {
    return { allowed: true };
  }

  const allowedModelCategories = subscription.plan.limits?.allowedModelCategories;
  if (allowedModelCategories === null || allowedModelCategories === undefined) {
    return { allowed: true };
  }

  if (allowedModelCategories.includes(requestedModelCategory)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: buildError(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 403, 'Model access is not available on your plan', {
      feature: 'allowedModelCategories',
      currentPlan: subscription.plan.slug,
      requestedModelCategory,
      allowedModelCategories,
    }),
  };
};

const maxOrganizationUsersCheck = (
  subscription: SubscriptionRecord,
  currentOrganizationUserCount = 0,
  pendingOrganizationInviteCount = 0,
): GateResult => {
  const maxOrganizationUsers = subscription.plan.limits?.maxOrganizationUsers;
  if (maxOrganizationUsers === null || maxOrganizationUsers === undefined) {
    return { allowed: true };
  }

  const reservedSeats = currentOrganizationUserCount + pendingOrganizationInviteCount;
  if (reservedSeats >= maxOrganizationUsers) {
    return {
      allowed: false,
      error: buildError(ERROR_CODES.RESOURCE_LIMIT_REACHED, 403, 'Organization user limit reached for your plan', {
        feature: 'maxOrganizationUsers',
        currentPlan: subscription.plan.slug,
        limit: maxOrganizationUsers,
        currentUsers: currentOrganizationUserCount,
        pendingInvites: pendingOrganizationInviteCount,
      }),
    };
  }

  return { allowed: true };
};

export const evaluateSessionCreation = (context: GateContext): GateResult => {
  const { subscription, requestedModelCategory } = context;
  for (const check of [
    () => workbenchExperienceCheck(subscription),
    () => modelCategoryAccessCheck(subscription, requestedModelCategory),
  ]) {
    const result = check();
    if (!result.allowed) return result;
  }
  return { allowed: true };
};

export const evaluateRunCreation = (context: GateContext): GateResult => {
  const { subscription, activeRunCount = 0, requestedModelCategory } = context;
  for (const check of [
    () => workbenchExperienceCheck(subscription),
    () => concurrentRunsCheck(subscription, activeRunCount),
    () => modelCategoryAccessCheck(subscription, requestedModelCategory),
  ]) {
    const result = check();
    if (!result.allowed) return result;
  }
  return { allowed: true };
};

export const evaluateScopeCreation = (context: GateContext): GateResult => {
  const { subscription, activeScopeCount = 0 } = context;
  for (const check of [
    () => workbenchExperienceCheck(subscription),
    () => maxActiveScopesCheck(subscription, activeScopeCount),
  ]) {
    const result = check();
    if (!result.allowed) return result;
  }
  return { allowed: true };
};

export const evaluateScopeConfiguration = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return privateRunnerAccessCheck(context.subscription);
};

export const evaluatePrivateRunnerAccess = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return privateRunnerAccessCheck(context.subscription);
};

export const evaluateAutomationFeature = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return automationFeatureCheck(context.subscription);
};

export const evaluateAutomationCreation = (context: GateContext): GateResult => {
  const { subscription, existingAutomationCount = 0 } = context;
  for (const check of [
    () => workbenchExperienceCheck(subscription),
    () => automationFeatureCheck(subscription),
    () => maxAutomationsCheck(subscription, existingAutomationCount),
  ]) {
    const result = check();
    if (!result.allowed) return result;
  }
  return { allowed: true };
};

export const evaluateGitHubIntegrationAccess = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return githubIntegrationAccessCheck(context.subscription);
};

export const evaluateComplianceAccess = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return complianceAccessCheck(context.subscription);
};

export const evaluateCodeReviewAccess = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return codeReviewAccessCheck(context.subscription);
};

export const evaluateThreatWatchAccess = (context: GateContext): GateResult => {
  return threatWatchAccessCheck(context.subscription);
};

export const evaluateRunObservabilityAccess = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return runObservabilityAccessCheck(context.subscription);
};

export const evaluateModelCategoryAccess = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return modelCategoryAccessCheck(context.subscription, context.requestedModelCategory);
};

export const evaluateOrganizationUserLimit = (context: GateContext): GateResult => {
  const experience = workbenchExperienceCheck(context.subscription);
  if (!experience.allowed) return experience;
  return maxOrganizationUsersCheck(
    context.subscription,
    context.currentOrganizationUserCount,
    context.pendingOrganizationInviteCount,
  );
};

export const evaluateWorkbenchAccess = (context: GateContext): GateResult => {
  return workbenchExperienceCheck(context.subscription);
};

