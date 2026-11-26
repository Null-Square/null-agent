import type { OrgContext, OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import type { ScopeContext, ScopeDetail, ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import type { DatabaseClient } from '@/db/client';
import { assets } from '@/db/schema';
import {
  compareAssetPriorityCandidates,
  loadAssetFocusEnrichments,
  toPriorityAssetSummary,
} from '@/domains/security-ops/assets/assetFocus';
import { and, eq } from 'drizzle-orm';
import { confirmedAssetClause } from '@/domains/security-ops/assets/assetConfirmation';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import {
  buildPlanEntitlementSnapshot,
  type PlanEntitlementSnapshot,
} from '@/domains/platform/subscriptions/entitlementSnapshot';

export const SCOPE_AWARE_CHAT_CONTEXT_START_MARKER = '=== NULLSQUARE SCOPE-AWARE CHAT CONTEXT ===';
export const SCOPE_AWARE_CHAT_CONTEXT_END_MARKER = '=== END NULLSQUARE SCOPE-AWARE CHAT CONTEXT ===';
export const SCOPE_AWARE_CHAT_CONTEXT_SCHEMA = 'nullsquare.scope-aware-chat.v5';
export const SCOPE_AWARE_CHAT_CONTEXT_SECTIONS = [
  'organization',
  'scope',
  'engagement',
  'targets',
  'operator_notes',
  'priority_assets',
  'entitlements',
] as const;

export type ScopeAwareChatContextSection = (typeof SCOPE_AWARE_CHAT_CONTEXT_SECTIONS)[number];

export type ScopeAwareChatContextEnvelope = {
  schema: typeof SCOPE_AWARE_CHAT_CONTEXT_SCHEMA;
  generatedAt: string;
  organization: {
    id: string;
    name: string;
    context: string | null;
  };
  scope: {
    id: string;
    name: string;
    status: string;
  };
  engagement: {
    testingPosture: 'black-box' | 'gray-box' | 'white-box';
    testingPostureReason: string;
    impactTolerance: 'non_destructive' | 'poc' | 'full';
    mission: string | null;
  };
  targets: Array<{ type: string; value: string; verified: boolean }>;
  priorityAssets: Array<{ assetId: string; value: string; label: string; reasons: string[] }>;
  entitlements?: PlanEntitlementSnapshot;
};

export type ScopeAwareChatContextMetadata = {
  organizationId: string;
  scopeId: string;
  schema: typeof SCOPE_AWARE_CHAT_CONTEXT_SCHEMA;
  sections: ScopeAwareChatContextSection[];
};

export type BuildScopeAwareChatContextResult = {
  organizationId: string;
  scopeId: string;
  metadata: ScopeAwareChatContextMetadata;
  envelope: ScopeAwareChatContextEnvelope;
  renderedContext: string;
};

type BuildScopeAwareChatContextParams = {
  userId: string;
  scopeId: string;
  userExtraContext?: string;
};

const mergeOperatorNotes = (baseContext: string, userExtraContext?: string): string => {
  const notes = userExtraContext?.trim();
  if (!notes) return baseContext;
  return `${baseContext}\n\n=== OPERATOR NOTES ===\n${notes}`;
};

const renderScopeAwareContext = (envelope: ScopeAwareChatContextEnvelope): string => {
  const { generatedAt: _generatedAt, ...cacheStableEnvelope } = envelope;
  return [
    SCOPE_AWARE_CHAT_CONTEXT_START_MARKER,
    JSON.stringify(cacheStableEnvelope, null, 2),
    SCOPE_AWARE_CHAT_CONTEXT_END_MARKER,
  ].join('\n');
};

const toEnvelope = async (
  db: DatabaseClient,
  organizationId: string,
  orgContext: OrgContext,
  scopeDetail: ScopeDetail,
  scopeContext: ScopeContext,
  entitlements?: PlanEntitlementSnapshot,
): Promise<ScopeAwareChatContextEnvelope> => {
  const assetRows = await db
    .select({
      id: assets.id,
      kind: assets.kind,
      value: assets.value,
      lastScannedAt: assets.lastScannedAt,
    })
    .from(assets)
    .where(
      and(
        eq(assets.organizationId, organizationId),
        confirmedAssetClause(scopeDetail.scope.id),
      ),
    );

  const focusByAsset = await loadAssetFocusEnrichments({
    db,
    organizationId,
    scopeId: scopeDetail.scope.id,
    assets: assetRows,
  });
  const priorityAssets = assetRows
    .map((asset) => ({
      id: asset.id,
      value: asset.value,
      needsBroadScan: focusByAsset.get(asset.id)?.needsBroadScan ?? false,
      focus: focusByAsset.get(asset.id)?.focus ?? { score: 0, label: 'low', reasons: [] },
    }))
    .sort(compareAssetPriorityCandidates)
    .slice(0, 5)
    .map((asset) => toPriorityAssetSummary(asset));

  return {
    schema: SCOPE_AWARE_CHAT_CONTEXT_SCHEMA,
    generatedAt: new Date().toISOString(),
    organization: {
      id: organizationId,
      name: orgContext.name,
      context: orgContext.context,
    },
    scope: {
      id: scopeDetail.scope.id,
      name: scopeDetail.scope.name,
      status: scopeDetail.scope.status,
    },
    engagement: {
      testingPosture: scopeContext.testingPosture,
      testingPostureReason: scopeContext.testingPostureReason,
      impactTolerance: scopeContext.impactTolerance,
      mission: scopeContext.mission,
    },
    targets: scopeContext.targets,
    priorityAssets,
    ...(entitlements ? { entitlements } : {}),
  };
};

const toMetadata = (organizationId: string, scopeId: string): ScopeAwareChatContextMetadata => ({
  organizationId,
  scopeId,
  schema: SCOPE_AWARE_CHAT_CONTEXT_SCHEMA,
  sections: [...SCOPE_AWARE_CHAT_CONTEXT_SECTIONS],
});

export class ScopeAwareChatContextService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly orgService: OrganizationService,
    private readonly scopeService: ScopeService,
    private readonly accessControl?: Pick<AccessControlService, 'resolveOrganizationSubscription'>,
  ) {}

  async buildForUser(params: BuildScopeAwareChatContextParams): Promise<BuildScopeAwareChatContextResult> {
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

    const [orgContext, scopeContext, subscription] = await Promise.all([
      this.orgService.getOrgContext(organization.id),
      this.scopeService.getScopeContext(scopeDetail.scope.id),
      this.accessControl?.resolveOrganizationSubscription({
        userId: params.userId,
        organizationId: organization.id,
      }),
    ]);

    const envelope = await toEnvelope(
      this.db,
      organization.id,
      orgContext,
      scopeDetail,
      scopeContext,
      subscription ? buildPlanEntitlementSnapshot(subscription) : undefined,
    );
    const metadata = toMetadata(organization.id, scopeDetail.scope.id);
    const renderedContext = mergeOperatorNotes(renderScopeAwareContext(envelope), params.userExtraContext);

    return {
      organizationId: organization.id,
      scopeId: scopeDetail.scope.id,
      metadata,
      envelope,
      renderedContext,
    };
  }
}
