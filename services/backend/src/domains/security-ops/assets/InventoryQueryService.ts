import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { assets } from '@/db/schema';
import { assetTenancyClause } from '@/domains/security-ops/assets/assetScopeFilter';
import {
  assetIsActiveClause,
  assetIsLeadExpression,
  confirmedAssetClause,
} from '@/domains/security-ops/assets/assetConfirmation';
import {
  loadAssetFocusEnrichments,
  type AssetFocusEnrichment,
} from '@/domains/security-ops/assets/assetFocus';
import {
  buildAssetInventoryFingerprint,
  InventoryProjection,
  type InventoryEndpointSummary,
} from '@/domains/security-ops/assets/InventoryProjection';
import {
  createVersionAcquisitionLoader,
  type LoadVersionAcquisitionByAssetIds,
  type VersionAcquisitionObjective,
} from '@/domains/security-ops/components/componentVersionAcquisition';

type InventoryQueryContext = {
  organizationId?: string;
  scopeId?: string;
};

type InventoryQueryProjection = Pick<
  InventoryProjection,
  | 'loadInventoryServicesByAssetIds'
  | 'loadInventoryEndpointsByAssetIds'
  | 'loadInventoryTechsByAssetIds'
  | 'loadBroadScanCoverageByAssetIds'
>;

type LoadAssetFocusEnrichments = typeof loadAssetFocusEnrichments;

const QueryInventorySchema = z.object({
  mode: z.enum(['digest', 'list']).optional().default('list'),
  assetKind: z.enum(['domain', 'ip', 'all']).optional().default('all'),
  includeServices: z.boolean().optional().default(false),
  includeEndpoints: z.boolean().optional().default(false),
  includeLeads: z.boolean().optional().default(false),
  staleThresholdDays: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional().default(500),
});

const BROAD_SURFACE_SCAN_PROFILE_VERSION = 'broad-surface-scan/v1';
const BROAD_SURFACE_SCAN_STALE_DAYS = 21;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSqlClause = (clause: SQL<unknown> | undefined): clause is SQL<unknown> =>
  clause !== undefined;

const toIsoString = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const toEpochMs = (value: string | undefined): number => {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

export type QueryInventoryResult = {
  assets: Array<Record<string, unknown>>;
  totalCount: number;
  leadCount: number;
  mode?: 'digest';
  digest?: {
    returnedAssets: number;
    confirmedAssets: number;
    leadAssets: number;
    needsBroadScan: number;
    needsVersionAcquisition: number;
    versionAcquisitionExhausted: number;
    limitReached: boolean;
  };
};

export class InventoryQueryService {
  private readonly inventoryProjection: InventoryQueryProjection;
  private readonly loadAssetFocusEnrichments: LoadAssetFocusEnrichments;
  private readonly loadVersionAcquisitionByAssetIds: LoadVersionAcquisitionByAssetIds;
  private readonly now: () => Date;

  constructor(
    private readonly db: DatabaseClient,
    options: {
      inventoryProjection?: InventoryQueryProjection;
      loadAssetFocusEnrichments?: LoadAssetFocusEnrichments;
      loadVersionAcquisitionByAssetIds?: LoadVersionAcquisitionByAssetIds;
      now?: () => Date;
    } = {},
  ) {
    this.inventoryProjection = options.inventoryProjection ?? new InventoryProjection(db);
    this.loadAssetFocusEnrichments = options.loadAssetFocusEnrichments ?? loadAssetFocusEnrichments;
    this.loadVersionAcquisitionByAssetIds =
      options.loadVersionAcquisitionByAssetIds ?? createVersionAcquisitionLoader(db);
    this.now = options.now ?? (() => new Date());
  }

  async queryInventory(params: {
    userId: string;
    context?: InventoryQueryContext;
    input: unknown;
  }): Promise<QueryInventoryResult> {
    const parsed = QueryInventorySchema.parse(params.input);
    const context = params.context ?? {};
    const now = this.now();
    const threshold =
      typeof parsed.staleThresholdDays === 'number'
        ? new Date(now.getTime() - parsed.staleThresholdDays * 24 * 60 * 60 * 1000)
        : undefined;

    const whereClauses = [
      context.organizationId
        ? assetTenancyClause({
            organizationId: context.organizationId,
            scopeId: context.scopeId,
          })
        : undefined,
      parsed.assetKind !== 'all' ? eq(assets.kind, parsed.assetKind) : undefined,
      parsed.includeLeads ? assetIsActiveClause() : confirmedAssetClause(context.scopeId),
      threshold ? lt(assets.lastSeenAt, threshold) : undefined,
    ].filter(isSqlClause);

    const rows = await this.db
      .select({
        id: assets.id,
        scopeId: assets.scopeId,
        kind: assets.kind,
        value: assets.value,
        isLead: assetIsLeadExpression(context.scopeId),
        tags: assets.tags,
        lastScannedAt: assets.lastScannedAt,
        lastSeenAt: assets.lastSeenAt,
      })
      .from(assets)
      .where(and(...whereClauses))
      .orderBy(desc(assets.lastSeenAt))
      .limit(parsed.limit);

    const focusByAsset = new Map<string, AssetFocusEnrichment>();
    if (rows.length > 0 && context.organizationId) {
      if (context.scopeId) {
        const enrichments = await this.loadAssetFocusEnrichments({
          db: this.db,
          organizationId: context.organizationId,
          userId: params.userId,
          scopeId: context.scopeId,
          assets: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            value: row.value,
            lastScannedAt: row.lastScannedAt,
          })),
          now,
        });
        for (const [assetId, enrichment] of enrichments.entries()) {
          focusByAsset.set(assetId, enrichment);
        }
      } else {
        // An asset whose originating scope was deleted still belongs to the
        // organization; it simply has no scope-specific focus to enrich with.
        const groupedRows = new Map<string, typeof rows>();
        for (const row of rows) {
          if (!row.scopeId) continue;
          const list = groupedRows.get(row.scopeId) ?? [];
          list.push(row);
          groupedRows.set(row.scopeId, list);
        }
        for (const [scopeId, scopedRows] of groupedRows.entries()) {
          const enrichments = await this.loadAssetFocusEnrichments({
            db: this.db,
            organizationId: context.organizationId,
            userId: params.userId,
            scopeId,
            assets: scopedRows.map((row) => ({
              id: row.id,
              kind: row.kind,
              value: row.value,
              lastScannedAt: row.lastScannedAt,
            })),
            now,
          });
          for (const [assetId, enrichment] of enrichments.entries()) {
            focusByAsset.set(assetId, enrichment);
          }
        }
      }
    }

    const assetIds = rows.map((row) => row.id);
    const [
      servicesByAsset,
      endpointsByAsset,
      techsByAsset,
      coverageByAsset,
      versionAcquisitionByAsset,
    ] = await Promise.all([
      this.inventoryProjection.loadInventoryServicesByAssetIds({
        userId: params.userId,
        organizationId: context.organizationId,
        assetIds,
      }),
      parsed.includeEndpoints
        ? this.inventoryProjection.loadInventoryEndpointsByAssetIds({
            userId: params.userId,
            organizationId: context.organizationId,
            assetIds,
          })
        : Promise.resolve(new Map<string, InventoryEndpointSummary[]>()),
      this.inventoryProjection.loadInventoryTechsByAssetIds({
        userId: params.userId,
        organizationId: context.organizationId,
        assetIds,
      }),
      this.inventoryProjection.loadBroadScanCoverageByAssetIds({
        userId: params.userId,
        organizationId: context.organizationId,
        assetIds,
      }),
      context.organizationId
        ? this.loadVersionAcquisitionByAssetIds({
            organizationId: context.organizationId,
            assetIds,
          })
        : Promise.resolve(new Map<string, VersionAcquisitionObjective[]>()),
    ]);

    const staleCutoffMs = now.getTime() - BROAD_SURFACE_SCAN_STALE_DAYS * 24 * 60 * 60 * 1000;
    type RankedAssetResult = Record<string, unknown> & {
      needsBroadScan: boolean;
      needsVersionAcquisition: boolean;
      focus: { score?: number } | null;
      __scanPriority: number;
      __lastSeenAtMs: number;
    };
    const rankedAssets: RankedAssetResult[] = rows.map((row): RankedAssetResult => {
      const services = servicesByAsset.get(row.id) ?? [];
      const endpoints = endpointsByAsset.get(row.id) ?? [];
      const techs = techsByAsset.get(row.id) ?? [];
      const coverage = coverageByAsset.get(row.id);
      const versionAcquisition = versionAcquisitionByAsset.get(row.id) ?? [];
      const needsVersionAcquisition = versionAcquisition.some(
        (objective) => objective.status === 'needs_version',
      );
      const currentFingerprint = buildAssetInventoryFingerprint({
        assetValue: row.value,
        services,
        techs,
      });
      const completedCoverageLastSeenAt =
        coverage?.data.status === 'completed'
          ? coverage.lastSeenAt
          : undefined;
      const lastScannedAt = toIsoString(row.lastScannedAt) ?? completedCoverageLastSeenAt ?? null;
      const coverageLastSeenAt = coverage?.lastSeenAt;
      const blockedCoverage = coverage?.data.status !== undefined && coverage.data.status !== 'completed';
      const profileMismatch =
        Boolean(coverage) && coverage?.data.profileVersion !== BROAD_SURFACE_SCAN_PROFILE_VERSION;
      const fingerprintChanged =
        coverage?.data.profileVersion === BROAD_SURFACE_SCAN_PROFILE_VERSION &&
        coverage?.data.status === 'completed' &&
        coverage?.data.inventoryFingerprint !== currentFingerprint;
      const staleCoverage =
        coverage?.data.profileVersion === BROAD_SURFACE_SCAN_PROFILE_VERSION &&
        coverage?.data.status === 'completed' &&
        toEpochMs(coverageLastSeenAt) > 0 &&
        toEpochMs(coverageLastSeenAt) < staleCutoffMs;
      const needsBroadScan =
        !coverage ||
        blockedCoverage ||
        profileMismatch ||
        fingerprintChanged ||
        staleCoverage;
      const pendingCoverage =
        Boolean(coverage) &&
        !fingerprintChanged &&
        !staleCoverage &&
        (blockedCoverage || profileMismatch);
      const scanPriority =
        !coverage ? 0
          : fingerprintChanged ? 1
          : staleCoverage ? 2
          : !coverage || pendingCoverage ? 3
          : 4;
      const focus = focusByAsset.get(row.id);
      const focusValue = focus?.focus ?? { score: 0, label: 'low', reasons: [] };
      const base: Omit<RankedAssetResult, '__scanPriority' | '__lastSeenAtMs'> = {
        id: row.id,
        kind: row.kind,
        value: row.value,
        isLead: row.isLead,
        tags: row.tags ?? [],
        lastSeenAt: toIsoString(row.lastSeenAt) ?? row.lastSeenAt,
        lastScannedAt,
        needsBroadScan,
        needsVersionAcquisition,
        ...(versionAcquisition.length > 0 ? { versionAcquisition } : {}),
        focus: focusValue,
      };
      if (parsed.mode === 'digest') {
        base.serviceSummary = {
          serviceCount: services.length,
          ports: services
            .slice(0, 10)
            .map((service) => ({
              port: service.port,
              protocol: service.protocol,
              serviceName: service.serviceName ?? null,
              product: service.product ?? null,
            })),
          technologies: techs
            .slice(0, 8)
            .map((tech) => ({
              product: tech.product,
              version: tech.version ?? null,
              category: tech.category ?? null,
            })),
        };
      }
      if (parsed.includeServices) {
        base.services = services;
      }
      if (parsed.includeEndpoints) {
        base.endpoints = endpoints;
      }
      return {
        ...base,
        __scanPriority: scanPriority,
        __lastSeenAtMs: toEpochMs(toIsoString(row.lastSeenAt)),
      } as RankedAssetResult;
    });

    const mapped = rankedAssets
      .sort((left: RankedAssetResult, right: RankedAssetResult) => {
        const leftNeedsVersion = left.needsVersionAcquisition === true ? 0 : 1;
        const rightNeedsVersion = right.needsVersionAcquisition === true ? 0 : 1;
        if (leftNeedsVersion !== rightNeedsVersion) {
          return leftNeedsVersion - rightNeedsVersion;
        }
        const leftNeedsBroadScan = left.needsBroadScan === true ? 0 : 1;
        const rightNeedsBroadScan = right.needsBroadScan === true ? 0 : 1;
        if (leftNeedsBroadScan !== rightNeedsBroadScan) {
          return leftNeedsBroadScan - rightNeedsBroadScan;
        }
        const leftFocusScore = isRecord(left.focus) && typeof left.focus.score === 'number' ? left.focus.score : 0;
        const rightFocusScore = isRecord(right.focus) && typeof right.focus.score === 'number' ? right.focus.score : 0;
        if (leftFocusScore !== rightFocusScore) {
          return rightFocusScore - leftFocusScore;
        }
        const leftPriority = typeof left.__scanPriority === 'number' ? left.__scanPriority : 99;
        const rightPriority = typeof right.__scanPriority === 'number' ? right.__scanPriority : 99;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        const leftLastSeenAt = typeof left.__lastSeenAtMs === 'number' ? left.__lastSeenAtMs : 0;
        const rightLastSeenAt = typeof right.__lastSeenAtMs === 'number' ? right.__lastSeenAtMs : 0;
        return rightLastSeenAt - leftLastSeenAt;
      })
      .map((asset: RankedAssetResult): Record<string, unknown> => {
        const { __scanPriority: _scanPriority, __lastSeenAtMs: _lastSeenAtMs, ...rest } = asset;
        return rest;
      });

    const leadCount = mapped.filter((asset) => asset.isLead === true).length;
    const confirmedCount = mapped.length - leadCount;
    const versionAcquisition = mapped.flatMap((asset) =>
      Array.isArray(asset.versionAcquisition)
        ? (asset.versionAcquisition as VersionAcquisitionObjective[])
        : [],
    );

    if (parsed.mode === 'digest') {
      return {
        mode: 'digest',
        assets: mapped,
        totalCount: mapped.length,
        leadCount,
        digest: {
          returnedAssets: mapped.length,
          confirmedAssets: confirmedCount,
          leadAssets: leadCount,
          needsBroadScan: mapped.filter((asset) => asset.needsBroadScan === true).length,
          needsVersionAcquisition: versionAcquisition.filter(
            (objective) => objective.status === 'needs_version',
          ).length,
          versionAcquisitionExhausted: versionAcquisition.filter(
            (objective) => objective.status === 'exhausted',
          ).length,
          limitReached: rows.length >= parsed.limit,
        },
      };
    }

    return {
      assets: mapped,
      totalCount: mapped.length,
      leadCount,
    };
  }
}
