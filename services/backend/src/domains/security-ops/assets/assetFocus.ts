import { createHash } from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  findings,
  inventoryNotes,
  inventoryServices,
  scopeTargets,
} from '@/db/schema';
import { OPEN_RISK_STATES } from '@/domains/security-ops/risks/riskLifecycle';

export type AssetFocusLabel = 'low' | 'medium' | 'high' | 'critical';

export type AssetFocus = {
  score: number;
  label: AssetFocusLabel;
  reasons: string[];
};

export type AssetPriorityCandidate = {
  value: string;
  focus: AssetFocus;
  needsBroadScan?: boolean;
};

type InventoryServiceFingerprint = {
  assetId: string;
  protocol: string;
  port: number;
  serviceName?: string | null;
  product?: string | null;
  version?: string | null;
  lastSeenAt: string;
};

type InventoryTechFingerprint = {
  assetId: string;
  product: string;
  version?: string;
  category?: string;
  lastSeenAt: string;
};

type ScanCoverageStatus = 'completed' | 'blocked';

type ScanCoverageData = {
  family?: string;
  status?: ScanCoverageStatus;
  profileVersion?: string;
  inventoryFingerprint?: string;
  reason?: string;
  toolset?: string[];
  stats?: {
    endpointsDiscovered?: number;
    findingsCreated?: number;
    techsDetected?: number;
  };
};

type ScanCoverageSummary = {
  assetId: string;
  lastSeenAt: string;
  data: ScanCoverageData;
};

type AssetFindingSummary = {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type AssetFocusInput = {
  assetId: string;
  assetKind: string;
  assetValue: string;
  lastScannedAt?: string | null;
  serviceCount: number;
  needsBroadScan: boolean;
  exactVerifiedTargetMatch: boolean;
  openFindings: AssetFindingSummary;
};

export type AssetFocusEnrichment = {
  focus: AssetFocus;
  needsBroadScan: boolean;
  serviceCount: number;
  openFindings: AssetFindingSummary;
  exactVerifiedTargetMatch: boolean;
};

export type AssetFocusAssetRow = {
  id: string;
  kind: string;
  value: string;
  lastScannedAt?: Date | string | null;
};

export type LoadAssetFocusEnrichmentParams = {
  db: DatabaseClient;
  userId?: string;
  organizationId: string;
  scopeId: string;
  assets: AssetFocusAssetRow[];
  now?: Date;
};

const BROAD_SURFACE_SCAN_FAMILY = 'broad-surface';
const BROAD_SURFACE_SCAN_PROFILE_VERSION = 'broad-surface-scan/v1';
const BROAD_SURFACE_SCAN_STALE_DAYS = 21;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.$/, '');

const normalizeAssetValueForComparison = (kind: string, value: string): string => {
  if (kind === 'domain') {
    return normalizeDomain(value);
  }
  return value.trim().toLowerCase();
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

const stableSort = (values: unknown[]): unknown[] =>
  [...values].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

const toNonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
};

const normalizeOptionalText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeScanCoverageData = (value: unknown): ScanCoverageData => {
  if (!isRecord(value)) {
    return {};
  }
  const family = typeof value.family === 'string' ? normalizeOptionalText(value.family) : undefined;
  const statusRaw = typeof value.status === 'string' ? normalizeOptionalText(value.status) : undefined;
  const status =
    statusRaw === 'completed' || statusRaw === 'blocked'
      ? (statusRaw as ScanCoverageStatus)
      : undefined;
  const profileVersion =
    typeof value.profileVersion === 'string' ? normalizeOptionalText(value.profileVersion) : undefined;
  const inventoryFingerprint =
    typeof value.inventoryFingerprint === 'string'
      ? normalizeOptionalText(value.inventoryFingerprint)
      : undefined;
  const reason = typeof value.reason === 'string' ? normalizeOptionalText(value.reason) : undefined;
  const toolset = Array.isArray(value.toolset)
    ? value.toolset
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;
  const statsRaw = isRecord(value.stats) ? value.stats : undefined;
  const stats = statsRaw
    ? {
        ...(toNonNegativeInt(statsRaw.endpointsDiscovered) !== undefined
          ? { endpointsDiscovered: toNonNegativeInt(statsRaw.endpointsDiscovered) }
          : {}),
        ...(toNonNegativeInt(statsRaw.findingsCreated) !== undefined
          ? { findingsCreated: toNonNegativeInt(statsRaw.findingsCreated) }
          : {}),
        ...(toNonNegativeInt(statsRaw.techsDetected) !== undefined
          ? { techsDetected: toNonNegativeInt(statsRaw.techsDetected) }
          : {}),
      }
    : undefined;

  return {
    ...(family ? { family } : {}),
    ...(status ? { status } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(inventoryFingerprint ? { inventoryFingerprint } : {}),
    ...(reason ? { reason } : {}),
    ...(toolset && toolset.length > 0 ? { toolset } : {}),
    ...(stats && Object.keys(stats).length > 0 ? { stats } : {}),
  };
};

export const buildAssetInventoryFingerprint = (params: {
  assetValue: string;
  services: InventoryServiceFingerprint[];
  techs: InventoryTechFingerprint[];
}): string => {
  const payload = {
    assetValue: params.assetValue,
    services: stableSort(
      params.services.map((service) => ({
        protocol: service.protocol,
        port: service.port,
        serviceName: service.serviceName ?? undefined,
        product: service.product ?? undefined,
        version: service.version ?? undefined,
      })),
    ),
    techs: stableSort(
      params.techs.map((tech) => ({
        product: tech.product,
        version: tech.version,
        category: tech.category,
      })),
    ),
  };

  return createHash('sha256').update(stableStringify(payload)).digest('hex');
};

export const computeNeedsBroadScan = (params: {
  assetValue: string;
  lastScannedAt?: string | null;
  services: InventoryServiceFingerprint[];
  techs: InventoryTechFingerprint[];
  coverage?: ScanCoverageSummary;
  now?: Date;
}): boolean => {
  const now = params.now ?? new Date();
  const coverage = params.coverage;
  const currentFingerprint = buildAssetInventoryFingerprint({
    assetValue: params.assetValue,
    services: params.services,
    techs: params.techs,
  });
  const coverageLastSeenAt = coverage?.lastSeenAt;
  const staleCutoffMs = now.getTime() - BROAD_SURFACE_SCAN_STALE_DAYS * 24 * 60 * 60 * 1000;
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

  return Boolean(
    !coverage ||
      blockedCoverage ||
      profileMismatch ||
      fingerprintChanged ||
      staleCoverage,
  );
};

const labelFromScore = (score: number): AssetFocusLabel => {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
};

export const deriveAssetFocus = (input: AssetFocusInput): AssetFocus => {
  const reasons: Array<{ points: number; reason: string }> = [];
  let score = 0;

  const addReason = (points: number, reason: string) => {
    score += points;
    reasons.push({ points, reason });
  };

  if (input.openFindings.critical > 0) {
    addReason(
      Math.min(90, 75 + Math.max(0, input.openFindings.critical - 1) * 5),
      input.openFindings.critical === 1
        ? 'Open critical finding on this asset'
        : `${input.openFindings.critical} open critical findings on this asset`,
    );
  } else if (input.openFindings.high > 0) {
    addReason(
      Math.min(75, 55 + Math.max(0, input.openFindings.high - 1) * 4),
      input.openFindings.high === 1
        ? 'Open high-severity finding on this asset'
        : `${input.openFindings.high} open high-severity findings on this asset`,
    );
  } else if (input.openFindings.medium > 0) {
    addReason(
      input.openFindings.medium === 1
        ? 20
        : Math.min(50, 30 + Math.max(0, input.openFindings.medium - 2) * 3),
      input.openFindings.medium === 1
        ? 'Open medium-severity finding on this asset'
        : `${input.openFindings.medium} open medium-severity findings on this asset`,
    );
  } else if (input.openFindings.low > 0) {
    addReason(
      Math.min(20, 8 + Math.max(0, input.openFindings.low - 1) * 2),
      input.openFindings.low === 1
        ? 'Open low-severity finding on this asset'
        : `${input.openFindings.low} open low-severity findings on this asset`,
    );
  } else if (input.openFindings.info > 0) {
    addReason(3, 'Open informational finding on this asset');
  }

  if (!input.lastScannedAt && input.serviceCount > 0) {
    addReason(18, 'Mapped services exist but the asset is still untested');
  }

  if (input.needsBroadScan) {
    addReason(8, 'Broad-surface coverage is missing or stale');
  }

  if (input.exactVerifiedTargetMatch) {
    addReason(12, 'Exact verified scope target');
  }

  const clampedScore = Math.min(100, score);
  const topReasons = reasons
    .sort((left, right) => {
      if (left.points !== right.points) {
        return right.points - left.points;
      }
      return left.reason.localeCompare(right.reason);
    })
    .slice(0, 4)
    .map((entry) => entry.reason);

  return {
    score: clampedScore,
    label: labelFromScore(clampedScore),
    reasons: topReasons,
  };
};

export const compareAssetPriorityCandidates = (
  left: AssetPriorityCandidate,
  right: AssetPriorityCandidate,
): number => {
  const leftNeedsBroadScan = left.needsBroadScan === true ? 0 : 1;
  const rightNeedsBroadScan = right.needsBroadScan === true ? 0 : 1;
  if (leftNeedsBroadScan !== rightNeedsBroadScan) {
    return leftNeedsBroadScan - rightNeedsBroadScan;
  }
  if (left.focus.score !== right.focus.score) {
    return right.focus.score - left.focus.score;
  }
  return left.value.localeCompare(right.value);
};

const emptyFindingSummary = (): AssetFindingSummary => ({
  total: 0,
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

const severityKey = (severity: string): keyof AssetFindingSummary | null => {
  switch (severity.trim().toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    case 'info':
      return 'info';
    default:
      return null;
  }
};

const loadServicesByAssetIds = async (params: {
  db: DatabaseClient;
  userId?: string;
  organizationId: string;
  assetIds: string[];
}): Promise<Map<string, InventoryServiceFingerprint[]>> => {
  const servicesByAsset = new Map<string, InventoryServiceFingerprint[]>();
  if (params.assetIds.length === 0) return servicesByAsset;

  const rows = await params.db
    .select({
      id: inventoryServices.id,
      assetId: inventoryServices.assetId,
      protocol: inventoryServices.protocol,
      port: inventoryServices.port,
      serviceName: inventoryServices.serviceName,
      product: inventoryServices.product,
      version: inventoryServices.version,
      lastSeenAt: inventoryServices.lastSeenAt,
    })
    .from(inventoryServices)
    .where(
      and(
        params.userId ? eq(inventoryServices.userId, params.userId) : undefined,
        eq(inventoryServices.organizationId, params.organizationId),
        inArray(inventoryServices.assetId, params.assetIds),
      ),
    )
    .orderBy(desc(inventoryServices.lastSeenAt));

  for (const row of rows) {
    const list = servicesByAsset.get(row.assetId) ?? [];
    list.push({
      assetId: row.assetId,
      protocol: row.protocol,
      port: row.port,
      serviceName: row.serviceName ?? undefined,
      product: row.product ?? undefined,
      version: row.version ?? undefined,
      lastSeenAt: toIsoString(row.lastSeenAt) ?? String(row.lastSeenAt),
    });
    servicesByAsset.set(row.assetId, list);
  }

  return servicesByAsset;
};

const loadTechsByAssetIds = async (params: {
  db: DatabaseClient;
  userId?: string;
  organizationId: string;
  assetIds: string[];
}): Promise<Map<string, InventoryTechFingerprint[]>> => {
  const techsByAsset = new Map<string, InventoryTechFingerprint[]>();
  if (params.assetIds.length === 0) return techsByAsset;

  const rows = await params.db
    .select({
      assetId: inventoryNotes.assetId,
      data: inventoryNotes.data,
      lastSeenAt: inventoryNotes.lastSeenAt,
    })
    .from(inventoryNotes)
    .where(
      and(
        params.userId ? eq(inventoryNotes.userId, params.userId) : undefined,
        eq(inventoryNotes.organizationId, params.organizationId),
        inArray(inventoryNotes.assetId, params.assetIds),
        eq(inventoryNotes.ntype, 'tech.fingerprint'),
      ),
    )
    .orderBy(desc(inventoryNotes.lastSeenAt));

  for (const row of rows) {
    if (!row.assetId || !isRecord(row.data) || typeof row.data.product !== 'string') {
      continue;
    }
    const product = normalizeOptionalText(row.data.product);
    if (!product) {
      continue;
    }
    const list = techsByAsset.get(row.assetId) ?? [];
    list.push({
      assetId: row.assetId,
      product,
      version: typeof row.data.version === 'string' ? normalizeOptionalText(row.data.version) : undefined,
      category: typeof row.data.category === 'string' ? normalizeOptionalText(row.data.category) : undefined,
      lastSeenAt: toIsoString(row.lastSeenAt) ?? String(row.lastSeenAt),
    });
    techsByAsset.set(row.assetId, list);
  }

  return techsByAsset;
};

const loadCoverageByAssetIds = async (params: {
  db: DatabaseClient;
  userId?: string;
  organizationId: string;
  assetIds: string[];
}): Promise<Map<string, ScanCoverageSummary>> => {
  const coverageByAsset = new Map<string, ScanCoverageSummary>();
  if (params.assetIds.length === 0) return coverageByAsset;

  const rows = await params.db
    .select({
      assetId: inventoryNotes.assetId,
      data: inventoryNotes.data,
      lastSeenAt: inventoryNotes.lastSeenAt,
    })
    .from(inventoryNotes)
    .where(
      and(
        params.userId ? eq(inventoryNotes.userId, params.userId) : undefined,
        eq(inventoryNotes.organizationId, params.organizationId),
        inArray(inventoryNotes.assetId, params.assetIds),
        eq(inventoryNotes.ntype, 'scan.coverage'),
      ),
    )
    .orderBy(desc(inventoryNotes.lastSeenAt));

  for (const row of rows) {
    if (!row.assetId || coverageByAsset.has(row.assetId)) {
      continue;
    }
    const data = normalizeScanCoverageData(row.data);
    if (data.family !== BROAD_SURFACE_SCAN_FAMILY) {
      continue;
    }
    coverageByAsset.set(row.assetId, {
      assetId: row.assetId,
      lastSeenAt: toIsoString(row.lastSeenAt) ?? String(row.lastSeenAt),
      data,
    });
  }

  return coverageByAsset;
};

const loadOpenFindingsByAssetIds = async (params: {
  db: DatabaseClient;
  organizationId: string;
  scopeId: string;
  assetIds: string[];
}): Promise<Map<string, AssetFindingSummary>> => {
  const findingSummaryByAsset = new Map<string, AssetFindingSummary>();
  if (params.assetIds.length === 0) return findingSummaryByAsset;

  const rows = await params.db
    .select({
      assetId: findings.assetId,
      severity: findings.severity,
    })
    .from(findings)
    .where(
      and(
        eq(findings.organizationId, params.organizationId),
        eq(findings.scopeId, params.scopeId),
        inArray(findings.state, [...OPEN_RISK_STATES]),
        inArray(findings.assetId, params.assetIds),
      ),
    );

  for (const row of rows) {
    if (!row.assetId) continue;
    const summary = findingSummaryByAsset.get(row.assetId) ?? emptyFindingSummary();
    const key = severityKey(row.severity);
    if (key) {
      summary[key] += 1;
    }
    summary.total += 1;
    findingSummaryByAsset.set(row.assetId, summary);
  }

  return findingSummaryByAsset;
};

const loadExactVerifiedTargetMatches = async (params: {
  db: DatabaseClient;
  scopeId: string;
}): Promise<Set<string>> => {
  const rows = await params.db
    .select({
      type: scopeTargets.type,
      value: scopeTargets.value,
    })
    .from(scopeTargets)
    .where(and(eq(scopeTargets.scopeId, params.scopeId), eq(scopeTargets.verified, true)));

  const matches = new Set<string>();
  for (const row of rows) {
    matches.add(`${row.type}:${normalizeAssetValueForComparison(row.type, row.value)}`);
  }
  return matches;
};

export const loadAssetFocusEnrichments = async (
  params: LoadAssetFocusEnrichmentParams,
): Promise<Map<string, AssetFocusEnrichment>> => {
  const enrichments = new Map<string, AssetFocusEnrichment>();
  if (params.assets.length === 0) return enrichments;

  const assetIds = params.assets.map((asset) => asset.id);
  const [servicesByAsset, techsByAsset, coverageByAsset, openFindingsByAsset, exactTargetMatches] =
    await Promise.all([
      loadServicesByAssetIds({
        db: params.db,
        userId: params.userId,
        organizationId: params.organizationId,
        assetIds,
      }),
      loadTechsByAssetIds({
        db: params.db,
        userId: params.userId,
        organizationId: params.organizationId,
        assetIds,
      }),
      loadCoverageByAssetIds({
        db: params.db,
        userId: params.userId,
        organizationId: params.organizationId,
        assetIds,
      }),
      loadOpenFindingsByAssetIds({
        db: params.db,
        organizationId: params.organizationId,
        scopeId: params.scopeId,
        assetIds,
      }),
      loadExactVerifiedTargetMatches({
        db: params.db,
        scopeId: params.scopeId,
      }),
    ]);

  for (const asset of params.assets) {
    const services = servicesByAsset.get(asset.id) ?? [];
    const techs = techsByAsset.get(asset.id) ?? [];
    const coverage = coverageByAsset.get(asset.id);
    const exactVerifiedTargetMatch = exactTargetMatches.has(
      `${asset.kind}:${normalizeAssetValueForComparison(asset.kind, asset.value)}`,
    );
    const needsBroadScan = computeNeedsBroadScan({
      assetValue: asset.value,
      lastScannedAt: toIsoString(asset.lastScannedAt) ?? null,
      services,
      techs,
      coverage,
      now: params.now,
    });
    const openFindings = openFindingsByAsset.get(asset.id) ?? emptyFindingSummary();
    const focus = deriveAssetFocus({
      assetId: asset.id,
      assetKind: asset.kind,
      assetValue: asset.value,
      lastScannedAt: toIsoString(asset.lastScannedAt) ?? null,
      serviceCount: services.length,
      needsBroadScan,
      exactVerifiedTargetMatch,
      openFindings,
    });

    enrichments.set(asset.id, {
      focus,
      needsBroadScan,
      serviceCount: services.length,
      openFindings,
      exactVerifiedTargetMatch,
    });
  }

  return enrichments;
};

export const toPriorityAssetSummary = (asset: {
  id: string;
  value: string;
  focus: AssetFocus;
}): { assetId: string; value: string; label: AssetFocusLabel; reasons: string[] } => ({
  assetId: asset.id,
  value: asset.value,
  label: asset.focus.label,
  reasons: asset.focus.reasons,
});
