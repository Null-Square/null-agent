import type { SubscriptionRecord } from './subscriptionService';
import { AccessControlService } from './accessControlService';
import type { ModelCategory } from '@null-ai/contracts';

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

export interface PlanAccessPort {
  resolveOrganizationSubscription(params: { organizationId?: string | null; userId?: string }): Promise<SubscriptionRecord>;
  enforceSessionCreation(params: SessionGateParams): Promise<SubscriptionRecord>;
}

export class AccessControlPlanAccess implements PlanAccessPort {
  constructor(private readonly svc: AccessControlService = new AccessControlService()) {}

  resolveOrganizationSubscription(params: { organizationId?: string | null; userId?: string }): Promise<SubscriptionRecord> {
    return this.svc.resolveOrganizationSubscription(params);
  }

  async enforceSessionCreation(params: SessionGateParams): Promise<SubscriptionRecord> {
    return this.svc.enforceSessionCreation(params);
  }
}

