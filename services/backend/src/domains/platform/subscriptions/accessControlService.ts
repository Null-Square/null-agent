import subscriptionService, { type SubscriptionRecord } from './subscriptionService';
import {
  evaluateSessionCreation,
  evaluateRunCreation,
  evaluateScopeConfiguration,
  evaluateScopeCreation,
  evaluateAutomationCreation,
  evaluateAutomationFeature,
  evaluateGitHubIntegrationAccess,
  evaluatePrivateRunnerAccess,
  evaluateComplianceAccess,
  evaluateCodeReviewAccess,
  evaluateThreatWatchAccess,
  evaluateRunObservabilityAccess,
  evaluateModelCategoryAccess,
  evaluateOrganizationUserLimit,
  evaluateWorkbenchAccess,
  type GateContext,
  type GateResult,
} from './gateEngine';
import type { ModelCategory } from '@null-ai/contracts';
import type { SessionRepositoryView, SessionStoreView } from './PlanAccessPort';

type SessionMode = 'interactive' | 'automated' | undefined;

type EnforceSessionParams = {
  userId?: string;
  organizationId?: string | null;
  mode?: SessionMode;
  sessionStore?: SessionStoreView;
  sessionRepository?: SessionRepositoryView;
  requestedModelCategory?: ModelCategory | null;
};

type EnforceRunParams = {
  userId?: string;
  organizationId?: string | null;
  activeRunCount: number;
  requestedModelCategory?: ModelCategory | null;
  /** The scheduler will enforce the plan slot atomically at admission time. */
  deferConcurrencyToAdmission?: boolean;
};

type EnforceScopeCreationParams = {
  userId?: string;
  organizationId?: string | null;
  activeScopeCount: number;
};

type EnforceScopeConfigurationParams = {
  userId?: string;
  organizationId?: string | null;
};

type EnforceAutomationCreationParams = {
  userId?: string;
  organizationId?: string | null;
  existingAutomationCount: number;
};

type EnforcePrivateRunnerAccessParams = {
  userId?: string;
  organizationId?: string | null;
};

type EnforceGitHubIntegrationAccessParams = {
  userId?: string;
  organizationId?: string | null;
};

type EnforceModelCategoryAccessParams = {
  userId?: string;
  organizationId?: string | null;
  requestedModelCategory?: ModelCategory | null;
};

type EnforceOrganizationUserLimitParams = {
  userId?: string;
  organizationId?: string | null;
  currentOrganizationUserCount: number;
  pendingOrganizationInviteCount?: number;
};

const throwIfDenied = (result: GateResult): void => {
  if (!result.allowed) {
    throw result.error;
  }
};

/**
 * Central wrapper for tier/feature gates. Resolves subscriptions then applies
 * the shared gate engine. Keeps controllers thin and ensures consistent error handling.
 */
export class AccessControlService {
  constructor(
    private readonly subs: Pick<
      typeof subscriptionService,
      'resolveOrganizationSubscription' | 'resolveAnonymousSubscription'
    > = subscriptionService,
  ) {}

  async resolveOrganizationSubscription(params: {
    organizationId?: string | null;
    userId?: string;
  }): Promise<SubscriptionRecord> {
    if (!params.organizationId) {
      return this.subs.resolveAnonymousSubscription(params.userId || 'anonymous');
    }
    return this.subs.resolveOrganizationSubscription(params.organizationId, {
      billingContactUserId: params.userId ?? null,
    });
  }

  async enforceSessionCreation(params: EnforceSessionParams): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateSessionCreation({
      subscription,
      requestedModelCategory: params.requestedModelCategory,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceWorkbenchAccess(
    params: { userId?: string; organizationId?: string | null },
  ): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateWorkbenchAccess({ subscription } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceRunCreation(params: EnforceRunParams): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateRunCreation({
      subscription,
      activeRunCount: params.deferConcurrencyToAdmission ? 0 : params.activeRunCount,
      requestedModelCategory: params.requestedModelCategory,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceScopeCreation(params: EnforceScopeCreationParams): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateScopeCreation({
      subscription,
      activeScopeCount: params.activeScopeCount,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceScopeConfiguration(params: EnforceScopeConfigurationParams): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateScopeConfiguration({
      subscription,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceAutomationFeature(params: { userId?: string; organizationId?: string | null }): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateAutomationFeature({ subscription } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceAutomationCreation(params: EnforceAutomationCreationParams): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateAutomationCreation({
      subscription,
      existingAutomationCount: params.existingAutomationCount,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforcePrivateRunnerAccess(
    params: EnforcePrivateRunnerAccessParams,
  ): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluatePrivateRunnerAccess({
      subscription,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceGitHubIntegrationAccess(
    params: EnforceGitHubIntegrationAccessParams,
  ): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateGitHubIntegrationAccess({
      subscription,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceComplianceAccess(
    params: { userId?: string; organizationId?: string | null },
  ): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateComplianceAccess({ subscription } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  /**
   * Continuous exposure monitoring.
   *
   * A separate gate from run creation on purpose: callers that start a
   * verification run must apply both.
   */
  async enforceThreatWatchAccess(
    params: { userId?: string; organizationId?: string | null },
  ): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateThreatWatchAccess({ subscription } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceCodeReviewAccess(
    params: { userId?: string; organizationId?: string | null },
  ): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateCodeReviewAccess({ subscription } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceRunObservabilityAccess(
    params: { userId?: string; organizationId?: string | null },
  ): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateRunObservabilityAccess({ subscription } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceModelCategoryAccess(params: EnforceModelCategoryAccessParams): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateModelCategoryAccess({
      subscription,
      requestedModelCategory: params.requestedModelCategory,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }

  async enforceOrganizationUserLimit(params: EnforceOrganizationUserLimitParams): Promise<SubscriptionRecord> {
    const subscription = await this.resolveOrganizationSubscription(params);
    const result = evaluateOrganizationUserLimit({
      subscription,
      currentOrganizationUserCount: params.currentOrganizationUserCount,
      pendingOrganizationInviteCount: params.pendingOrganizationInviteCount ?? 0,
    } satisfies GateContext);
    throwIfDenied(result);
    return subscription;
  }
}

export default AccessControlService;
