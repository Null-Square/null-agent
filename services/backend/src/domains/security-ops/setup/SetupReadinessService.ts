import { and, eq, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { automations, scopeDocuments, setupRecommendationDismissals } from '@/db/schema';
import type { OrganizationRow } from '@/db/schema';
import type { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import type { ScopeDetail, ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import type { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import {
  buildPlanEntitlementSnapshot,
  type PlanEntitlementSnapshot,
} from '@/domains/platform/subscriptions/entitlementSnapshot';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { sha256Hex } from '@/shared/utils/hash';

export const SETUP_READINESS_SCHEMA = 'nullsquare.setup-readiness.v1' as const;

export type SetupReadinessLevel = 'blocked' | 'minimal' | 'ready' | 'optimized';
export type SetupGateStatus = 'complete' | 'pending' | 'recommended';
export type SetupActionStatus = 'required' | 'recommended' | 'complete';
export type SetupRecommendationSurface = 'home' | 'assistant' | 'onboarding';
export type SetupReadinessActionId =
  | 'add_target'
  | 'verify_target'
  | 'create_automation'
  | 'review_scope';

export type SetupReadinessCounts = {
  targetCount: number;
  verifiedTargetCount: number;
  connectedRepoCount: number;
  accessMaterialCount: number;
  automationCount: number;
  documentCount: number;
};

export type SetupReadinessGate = {
  id:
    | 'target'
    | 'target_verification'
    | 'code_context'
    | 'automation'
    | 'compliance_context';
  label: string;
  status: SetupGateStatus;
  required: boolean;
  description: string;
};

export type SetupReadinessAction = {
  id: SetupReadinessActionId;
  title: string;
  description: string;
  status: SetupActionStatus;
  prompt: string;
  href?: string;
  priority?: number;
  reason?: string;
  dismissible?: boolean;
  stateSignature?: string;
  dismissed?: boolean;
  dismissedAt?: string;
};

export type SetupReadinessState = {
  schema: typeof SETUP_READINESS_SCHEMA;
  generatedAt: string;
  organization: {
    id: string;
    name: string;
  };
  scope: {
    id: string;
    name: string;
    status: string;
  };
  level: SetupReadinessLevel;
  progress: {
    completed: number;
    total: number;
    percent: number;
    label: string;
  };
  counts: SetupReadinessCounts;
  entitlements?: PlanEntitlementSnapshot;
  gates: SetupReadinessGate[];
  recommendations: SetupReadinessAction[];
  nextBestActions: SetupReadinessAction[];
  smartStarters: SetupReadinessAction[];
  dismissedRecommendations: SetupReadinessAction[];
};

export type SetupRecommendationDismissalSnapshot = {
  actionId: SetupReadinessActionId | string;
  stateSignature: string;
  dismissedAt: Date | string;
};

export type BuildSetupReadinessParams = {
  organization: Pick<OrganizationRow, 'id' | 'name'>;
  scopeDetail: ScopeDetail;
  counts: SetupReadinessCounts;
  entitlements?: PlanEntitlementSnapshot;
  dismissals?: SetupRecommendationDismissalSnapshot[];
  includeDismissedRecommendations?: boolean;
  generatedAt?: Date;
};

type BuildForUserParams = {
  userId: string;
  scopeId: string;
};

type DismissSetupRecommendationParams = {
  userId: string;
  scopeId: string;
  actionId: SetupReadinessActionId;
  stateSignature: string;
  surface?: SetupRecommendationSurface;
};

const completionLabel = (level: SetupReadinessLevel): string => {
  switch (level) {
    case 'optimized':
      return 'Optimized';
    case 'ready':
      return 'Ready';
    case 'minimal':
      return 'Needs verification';
    case 'blocked':
    default:
      return 'Action needed';
  }
};

const action = (item: SetupReadinessAction): SetupReadinessAction => item;

const setupSignatureInput = (
  params: Pick<BuildSetupReadinessParams, 'scopeDetail' | 'counts' | 'entitlements'>,
) => {
  const scope = params.scopeDetail.scope;
  return {
    counts: params.counts,
    scope: {
      status: scope.status,
      complianceFrameworks: [...(scope.complianceFrameworks ?? [])].sort(),
    },
    entitlements: params.entitlements
      ? {
          plan: params.entitlements.plan.slug,
          features: Object.fromEntries(
            Object.entries(params.entitlements.features)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, feature]) => [key, feature.available]),
          ),
          limits: params.entitlements.limits,
        }
      : null,
  };
};

const buildRecommendationSignature = (
  item: SetupReadinessAction,
  params: Pick<BuildSetupReadinessParams, 'scopeDetail' | 'counts' | 'entitlements'>,
): string =>
  sha256Hex(JSON.stringify({
    actionId: item.id,
    status: item.status,
    title: item.title,
    setup: setupSignatureInput(params),
  })).slice(0, 32);

const dismissalKey = (actionId: string, stateSignature: string): string => `${actionId}:${stateSignature}`;

const enrichRecommendations = (
  items: SetupReadinessAction[],
  params: BuildSetupReadinessParams,
): SetupReadinessAction[] => {
  const dismissals = new Map(
    (params.dismissals ?? []).map((dismissal) => [
      dismissalKey(dismissal.actionId, dismissal.stateSignature),
      dismissal.dismissedAt,
    ]),
  );

  return items.map((item, index) => {
    const stateSignature = buildRecommendationSignature(item, params);
    const dismissedAt = dismissals.get(dismissalKey(item.id, stateSignature));
    const isCompleteReview = item.id === 'review_scope' && item.status === 'complete';
    const isRequired = item.status === 'required';
    return {
      ...item,
      priority: item.priority ?? (item.status === 'required' ? 100 - index : item.status === 'recommended' ? 60 - index : 10 - index),
      reason: item.reason ?? item.description,
      dismissible: item.dismissible ?? (!isRequired && !isCompleteReview),
      stateSignature,
      dismissed: Boolean(dismissedAt),
      ...(dismissedAt ? { dismissedAt: new Date(dismissedAt).toISOString() } : {}),
    };
  });
};

export const buildSetupReadiness = (params: BuildSetupReadinessParams): SetupReadinessState => {
  const { organization, scopeDetail, counts } = params;
  const scope = scopeDetail.scope;
  const entitlements = params.entitlements;
  const automationsAvailable = entitlements?.features.automations.available !== false;
  const repositoriesAvailable = entitlements?.features.githubIntegrations.available !== false;
  const complianceAvailable = entitlements?.features.compliance.available !== false;
  const hasTarget = counts.targetCount > 0;
  const hasVerifiedTarget = counts.verifiedTargetCount > 0;
  const hasRepoContext = counts.connectedRepoCount > 0;
  const hasAutomation = counts.automationCount > 0;
  const hasCompliance = Array.isArray(scope.complianceFrameworks) && scope.complianceFrameworks.length > 0;

  const gates: SetupReadinessGate[] = [
    {
      id: 'target',
      label: 'Target added',
      status: hasTarget ? 'complete' : 'pending',
      required: true,
      description: hasTarget
        ? 'At least one scope target is configured.'
        : 'Add a domain or CIDR target before starting operational work.',
    },
    {
      id: 'target_verification',
      label: 'Ownership verified',
      status: hasVerifiedTarget ? 'complete' : 'pending',
      required: true,
      description: hasVerifiedTarget
        ? 'At least one target is verified.'
        : 'Verify ownership through provider connection, DNS TXT, HTTP file, or review.',
    },
    {
      id: 'code_context',
      label: 'Repository context',
      status: hasRepoContext ? 'complete' : 'recommended',
      required: false,
      description: hasRepoContext
        ? 'Repository context is linked for whitebox analysis.'
        : !repositoriesAvailable
          ? entitlements?.features.githubIntegrations.reason ?? 'Repository context is not available on the current plan.'
        : 'Point the scope at a code folder or a public git URL when code-aware analysis is useful.',
    },
    {
      id: 'automation',
      label: 'Automation',
      status: hasAutomation ? 'complete' : 'recommended',
      required: false,
      description: hasAutomation
        ? 'At least one automation is active for this scope.'
        : !automationsAvailable
          ? entitlements?.features.automations.reason ?? 'Automations are not available on the current plan.'
        : 'Create a scheduled or event-based workflow after the scope is verified.',
    },
    {
      id: 'compliance_context',
      label: 'Compliance context',
      status: hasCompliance ? 'complete' : 'recommended',
      required: false,
      description: hasCompliance
        ? 'Compliance frameworks are attached to the scope.'
        : !complianceAvailable
          ? entitlements?.features.compliance.reason ?? 'Compliance is not available on the current plan.'
        : 'Attach frameworks when readiness reporting should map to controls.',
    },
  ];

  const completed = gates.filter((gate) => gate.status === 'complete').length;
  const total = gates.length;
  const ready = hasTarget && hasVerifiedTarget;
  const optimized = ready && hasRepoContext && hasAutomation;
  const level: SetupReadinessLevel = !hasTarget
    ? 'blocked'
    : !hasVerifiedTarget
      ? 'minimal'
      : optimized
        ? 'optimized'
        : 'ready';

  const rawNextBestActions: SetupReadinessAction[] = [];
  if (!hasTarget) {
    rawNextBestActions.push(action({
      id: 'add_target',
      title: 'Add first target',
      description: 'Add the first authorized domain or CIDR range to this scope.',
      status: 'required',
      href: '/setup',
      prompt: 'Help me choose the first authorized target for this scope and explain what information you need.',
    }));
  }
  if (hasTarget && !hasVerifiedTarget) {
    rawNextBestActions.push(action({
      id: 'verify_target',
      title: 'Verify target ownership',
      description: 'Finish provider, DNS, HTTP file, or manual review verification before assessment.',
      status: 'required',
      href: '/setup',
      prompt: 'Explain the fastest safe way to verify the current scope target before testing begins.',
    }));
  }
  if (!hasAutomation && automationsAvailable) {
    rawNextBestActions.push(action({
      id: 'create_automation',
      title: 'Schedule automated checks',
      description: ready
        ? 'Run a recurring review for this verified scope and notify you when something needs attention.'
        : 'Prepare recurring checks now; the assistant will account for target verification and rules first.',
      status: 'recommended',
      href: '/automations',
      priority: 80,
      prompt: ready
        ? 'Suggest a safe recurring automation schedule for this verified scope.'
        : 'Help me prepare a safe recurring automation plan and list any required gaps before it can run.',
    }));
  }
  const enrichedActions = enrichRecommendations(rawNextBestActions, params)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  const visibleActions = params.includeDismissedRecommendations
    ? enrichedActions
    : enrichedActions.filter((item) => !item.dismissed);
  const dismissedRecommendations = enrichedActions.filter((item) => item.dismissed);
  const smartStarters = [
    ...visibleActions,
    action({
      id: 'review_scope',
      title: 'Review current posture',
      description: 'Review configured targets, rules, integrations, and missing context.',
      status: ready ? 'complete' : 'recommended',
      prompt: 'Review this scope and list the highest-value next security work.',
    }),
  ].slice(0, 4);

  return {
    schema: SETUP_READINESS_SCHEMA,
    generatedAt: (params.generatedAt ?? new Date()).toISOString(),
    organization: {
      id: organization.id,
      name: organization.name,
    },
    scope: {
      id: scope.id,
      name: scope.name,
      status: scope.status,
    },
    level,
    progress: {
      completed,
      total,
      percent: Math.round((completed / total) * 100),
      label: completionLabel(level),
    },
    counts,
    ...(entitlements ? { entitlements } : {}),
    gates,
    recommendations: visibleActions.slice(0, 5),
    nextBestActions: visibleActions.slice(0, 5),
    smartStarters,
    dismissedRecommendations,
  };
};

export class SetupReadinessService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly orgService: OrganizationService,
    private readonly scopeService: ScopeService,
    private readonly accessControl?: Pick<AccessControlService, 'resolveOrganizationSubscription'>,
  ) {}

  async buildForUser(params: BuildForUserParams): Promise<SetupReadinessState> {
    const { organization, scopeDetail, counts, entitlements } = await this.loadBaseInputs(params);
    const dismissals = await this.listDismissals(params.userId, organization.id, params.scopeId);

    return buildSetupReadiness({
      organization,
      scopeDetail,
      counts,
      ...(entitlements ? { entitlements } : {}),
      dismissals,
    });
  }

  async dismissRecommendation(params: DismissSetupRecommendationParams): Promise<{
    recommendation: SetupReadinessAction;
    state: SetupReadinessState;
  }> {
    const { organization, scopeDetail, counts, entitlements } = await this.loadBaseInputs(params);
    const rawState = buildSetupReadiness({
      organization,
      scopeDetail,
      counts,
      ...(entitlements ? { entitlements } : {}),
      includeDismissedRecommendations: true,
    });
    const recommendation = rawState.recommendations.find((item) =>
      item.id === params.actionId && item.stateSignature === params.stateSignature
    );

    if (!recommendation) {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Recommendation is no longer current', {
        httpStatus: 409,
        context: {
          actionId: params.actionId,
          scopeId: params.scopeId,
        },
      });
    }

    if (recommendation.status === 'required' || recommendation.dismissible === false) {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Recommendation cannot be dismissed', {
        httpStatus: 409,
        context: {
          actionId: params.actionId,
          scopeId: params.scopeId,
        },
      });
    }

    const now = new Date();
    await this.db
      .insert(setupRecommendationDismissals)
      .values({
        userId: params.userId,
        organizationId: organization.id,
        scopeId: params.scopeId,
        actionId: params.actionId,
        stateSignature: params.stateSignature,
        surface: params.surface ?? 'home',
        dismissedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          setupRecommendationDismissals.userId,
          setupRecommendationDismissals.scopeId,
          setupRecommendationDismissals.actionId,
          setupRecommendationDismissals.stateSignature,
        ],
        set: {
          surface: params.surface ?? 'home',
          dismissedAt: now,
          updatedAt: now,
        },
      });

    const dismissals = await this.listDismissals(params.userId, organization.id, params.scopeId);
    const state = buildSetupReadiness({
      organization,
      scopeDetail,
      counts,
      ...(entitlements ? { entitlements } : {}),
      dismissals,
    });

    return {
      recommendation: {
        ...recommendation,
        dismissed: true,
        dismissedAt: now.toISOString(),
      },
      state,
    };
  }

  private async loadBaseInputs(params: BuildForUserParams): Promise<{
    organization: Pick<OrganizationRow, 'id' | 'name'>;
    scopeDetail: ScopeDetail;
    counts: SetupReadinessCounts;
    entitlements?: PlanEntitlementSnapshot;
  }> {
    const organization = await this.orgService.getForUser(params.userId);

    let scopeDetail: ScopeDetail;
    try {
      scopeDetail = await this.scopeService.getById(organization.id, params.scopeId);
    } catch (error) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Scope not found', {
        cause: error instanceof Error ? error : undefined,
        context: { scopeId: params.scopeId, organizationId: organization.id },
      });
    }

    const [counts, subscription] = await Promise.all([
      this.getCounts(organization.id, scopeDetail),
      this.accessControl?.resolveOrganizationSubscription({
        userId: params.userId,
        organizationId: organization.id,
      }),
    ]);

    return {
      organization,
      scopeDetail,
      counts,
      ...(subscription ? { entitlements: buildPlanEntitlementSnapshot(subscription) } : {}),
    };
  }

  private async listDismissals(
    userId: string,
    organizationId: string,
    scopeId: string,
  ): Promise<SetupRecommendationDismissalSnapshot[]> {
    const rows = await this.db
      .select({
        actionId: setupRecommendationDismissals.actionId,
        stateSignature: setupRecommendationDismissals.stateSignature,
        dismissedAt: setupRecommendationDismissals.dismissedAt,
      })
      .from(setupRecommendationDismissals)
      .where(and(
        eq(setupRecommendationDismissals.userId, userId),
        eq(setupRecommendationDismissals.organizationId, organizationId),
        eq(setupRecommendationDismissals.scopeId, scopeId),
      ));

    return rows;
  }

  private async getCounts(organizationId: string, scopeDetail: ScopeDetail): Promise<SetupReadinessCounts> {
    const scopeId = scopeDetail.scope.id;

    const [automationRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(automations)
      .where(and(
        eq(automations.organizationId, organizationId),
        eq(automations.scopeId, scopeId),
        eq(automations.isActive, true),
      ));

    return {
      targetCount: scopeDetail.scope.targetCount,
      verifiedTargetCount: scopeDetail.scope.verifiedTargetCount,
      connectedRepoCount: scopeDetail.scope.connectedRepoCount,
      accessMaterialCount: scopeDetail.scope.accessMaterialCount,
      automationCount: Number(automationRow?.count ?? 0),
      documentCount: await this.getDocumentCount(organizationId, scopeId),
    };
  }

  private async getDocumentCount(organizationId: string, scopeId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(scopeDocuments)
      .where(and(
        eq(scopeDocuments.organizationId, organizationId),
        eq(scopeDocuments.scopeId, scopeId),
      ));
    return Number(row?.count ?? 0);
  }
}
