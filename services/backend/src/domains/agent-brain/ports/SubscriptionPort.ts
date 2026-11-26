import type { ModelCategory } from '@null-ai/contracts';

export type SubscriptionPlanSnapshot = {
  id?: string;
  name?: string;
  slug: string;
  experienceProfile?: 'inactive' | 'results' | 'workbench';
  features?: {
    accessAutomations?: boolean;
    accessPrivateRunners?: boolean;
    accessGitHubIntegrations?: boolean;
    accessCompliance?: boolean;
    accessCodeReview?: boolean;
    accessThreatWatch?: boolean;
  };
  limits?: {
    maxConcurrentRuns?: number | null;
    maxActiveScopes?: number | null;
    maxAutomations?: number | null;
    maxOrganizationUsers?: number | null;
    allowedModelCategories?: ModelCategory[] | null;
  };
};

export type SubscriptionRecord = {
  userId: string;
  organizationId?: string;
  plan: SubscriptionPlanSnapshot;
};

export type SessionStoreView = {
  listByUser: (userId: string) => Array<{ stateMachine?: { isProcessing: () => boolean } }>;
};

export type SessionRepositoryView = {
  countByUserId: (userId: string) => Promise<number>;
};

export type SessionGateParams = {
  userId?: string;
  organizationId?: string | null;
  mode?: 'interactive' | 'automated';
  sessionStore?: SessionStoreView;
  sessionRepository?: SessionRepositoryView;
  requestedModelCategory?: ModelCategory | null;
};

export interface SubscriptionPort {
  resolveOrganizationSubscription(params: {
    organizationId?: string | null;
    userId?: string;
  }): Promise<SubscriptionRecord>;
  enforceSessionCreation(params: SessionGateParams): Promise<SubscriptionRecord>;
}

