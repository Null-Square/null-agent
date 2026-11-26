import { createHash } from 'crypto';
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { assets, findings, inventoryNotes, inventoryServices, type RiskState } from '@/db/schema';
import type { FindingCodeLocation } from '@/domains/security-ops/findings/findingContracts';

export type InventoryServiceSummary = {
  id: string;
  assetId: string;
  protocol: string;
  port: number;
  serviceName?: string | null;
  product?: string | null;
  version?: string | null;
  lastSeenAt: string;
};

export type InventoryEndpointSummary = {
  id: string;
  assetId: string;
  url: string;
  method: string;
  statusCode?: number;
  title?: string | null;
  lastSeenAt: string;
};

export type InventoryTechSummary = {
  id: string;
  assetId: string;
  product: string;
  version?: string;
  category?: string;
  confidence?: number;
  lastSeenAt: string;
};

export type EndpointLocation = {
  url?: string;
  method?: string;
};

export type FindingDuplicateCandidateRow = {
  id: string;
  assetKind: string;
  assetValue: string;
  dedupeKey: string;
  title: string;
  severity: string;
  state: RiskState;
  summary: string;
  businessImpact: string | null;
  technicalAnalysis: string | null;
  pocDescription: string | null;
  pocScriptCode: string | null;
  assumptions: string | null;
  fixEffort: string | null;
  remediation: string | null;
  confidenceScore: number | null;
  cweId: string | null;
  cveId: string | null;
  cweIds: string[] | null;
  cveIds: string[] | null;
  owaspCategory: string | null;
  cvssVector: string | null;
  cvssScore: number | null;
  endpointId: string | null;
  serviceId: string | null;
  codeLocations: FindingCodeLocation[];
};

export type ScanCoverageStatus = 'completed' | 'blocked';

export type ScanCoverageData = {
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
    rowsParsed?: number;
    rowsKept?: number;
    suppressed?: number;
    duplicates?: number;
  };
};

export type ScanCoverageSummary = {
  assetId: string;
  lastSeenAt: string;
  data: ScanCoverageData;
};

const BROAD_SURFACE_SCAN_FAMILY = 'broad-surface';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbExecutor = DatabaseClient | any;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSqlClause = (clause: SQL<unknown> | undefined): clause is SQL<unknown> =>
  clause !== undefined;

const normalizeToolText = (value: string): string => value.trim();

const normalizeOptionalToolText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeToolText(value);
  return normalized.length > 0 ? normalized : undefined;
};

const toNonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
};

const toIsoString = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const buildAssetInventoryFingerprint = (params: {
  assetValue: string;
  services: InventoryServiceSummary[];
  techs: InventoryTechSummary[];
}): string => {
  const stableSort = (values: unknown[]): unknown[] =>
    [...values].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

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

export const normalizeScanCoverageData = (value: unknown): ScanCoverageData => {
  if (!isRecord(value)) {
    return {};
  }
  const family = typeof value['family'] === 'string' ? normalizeOptionalToolText(value['family']) : undefined;
  const statusRaw = typeof value['status'] === 'string' ? normalizeOptionalToolText(value['status']) : undefined;
  const status =
    statusRaw === 'completed' || statusRaw === 'blocked'
      ? (statusRaw as ScanCoverageStatus)
      : undefined;
  const profileVersion =
    typeof value['profileVersion'] === 'string' ? normalizeOptionalToolText(value['profileVersion']) : undefined;
  const inventoryFingerprint =
    typeof value['inventoryFingerprint'] === 'string'
      ? normalizeOptionalToolText(value['inventoryFingerprint'])
      : undefined;
  const reason = typeof value['reason'] === 'string' ? normalizeOptionalToolText(value['reason']) : undefined;
  const toolset = Array.isArray(value['toolset'])
    ? value['toolset']
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;
  const statsRaw = isRecord(value['stats']) ? value['stats'] : undefined;
  const stats = statsRaw
    ? {
        ...(toNonNegativeInt(statsRaw['endpointsDiscovered']) !== undefined
          ? { endpointsDiscovered: toNonNegativeInt(statsRaw['endpointsDiscovered']) }
          : {}),
        ...(toNonNegativeInt(statsRaw['findingsCreated']) !== undefined
          ? { findingsCreated: toNonNegativeInt(statsRaw['findingsCreated']) }
          : {}),
        ...(toNonNegativeInt(statsRaw['techsDetected']) !== undefined
          ? { techsDetected: toNonNegativeInt(statsRaw['techsDetected']) }
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

export class InventoryProjection {
  constructor(private readonly db: DatabaseClient) {}

  async loadEndpointLocationsByIds(params: {
    executor: DbExecutor;
    endpointIds: string[];
  }): Promise<Map<string, EndpointLocation>> {
    const endpointMap = new Map<string, EndpointLocation>();
    if (params.endpointIds.length === 0) {
      return endpointMap;
    }

    const rows = await params.executor
      .select({
        id: inventoryNotes.id,
        data: inventoryNotes.data,
      })
      .from(inventoryNotes)
      .where(inArray(inventoryNotes.id, params.endpointIds));

    for (const row of rows) {
      const data = isRecord(row.data) ? row.data : {};
      const url = typeof data['url'] === 'string' ? normalizeOptionalToolText(data['url']) : undefined;
      const methodRaw = typeof data['method'] === 'string' ? normalizeOptionalToolText(data['method']) : undefined;
      endpointMap.set(row.id, {
        url,
        method: methodRaw ? methodRaw.toUpperCase() : undefined,
      });
    }

    return endpointMap;
  }

  async queryDuplicateCandidateRows(params: {
    executor: DbExecutor;
    organizationId: string;
    assetId: string;
    scopeId?: string;
    endpointId?: string;
    serviceId?: string;
    limit?: number;
  }): Promise<FindingDuplicateCandidateRow[]> {
    const candidateLimit = params.limit ?? (params.scopeId ? 50 : 12);
    const baseClauses = [
      eq(findings.organizationId, params.organizationId),
      eq(findings.sourceKind, 'assessment'),
      params.scopeId ? eq(findings.scopeId, params.scopeId) : eq(findings.assetId, params.assetId),
      sql`${findings.state} <> 'dismissed'`,
    ].filter(isSqlClause);

    const selectFields = {
      id: findings.id,
      assetKind: assets.kind,
      assetValue: assets.value,
      dedupeKey: findings.dedupeKey,
      title: findings.title,
      severity: findings.severity,
      state: findings.state,
      summary: findings.summary,
      businessImpact: findings.businessImpact,
      technicalAnalysis: findings.technicalAnalysis,
      pocDescription: findings.pocDescription,
      pocScriptCode: findings.pocScriptCode,
      assumptions: findings.assumptions,
      fixEffort: findings.fixEffort,
      remediation: findings.remediation,
      confidenceScore: findings.confidenceScore,
      cweId: findings.cweId,
      cveId: findings.cveId,
      cweIds: findings.cweIds,
      cveIds: findings.cveIds,
      owaspCategory: findings.owaspCategory,
      cvssVector: findings.cvssVector,
      cvssScore: findings.cvssScore,
      endpointId: findings.endpointId,
      serviceId: findings.serviceId,
      codeLocations: findings.codeLocations,
    };

    const runQuery = async (extraClauses: Array<SQL<unknown> | undefined>): Promise<FindingDuplicateCandidateRow[]> =>
      params.executor
        .select(selectFields)
        .from(findings)
        .innerJoin(assets, eq(findings.assetId, assets.id))
        .where(and(...baseClauses, ...extraClauses.filter(isSqlClause)))
        .orderBy(desc(findings.lastSeenAt))
        .limit(candidateLimit);

    if (params.endpointId) {
      const endpointRows = await runQuery([eq(findings.endpointId, params.endpointId)]);
      if (endpointRows.length > 0) {
        return endpointRows;
      }
    }

    if (params.serviceId) {
      const serviceRows = await runQuery([eq(findings.serviceId, params.serviceId)]);
      if (serviceRows.length > 0) {
        return serviceRows;
      }
    }

    return runQuery([]);
  }

  async loadInventoryServicesByAssetIds(params: {
    userId: string;
    organizationId?: string;
    assetIds: string[];
  }): Promise<Map<string, InventoryServiceSummary[]>> {
    const servicesByAsset = new Map<string, InventoryServiceSummary[]>();
    if (params.assetIds.length === 0) {
      return servicesByAsset;
    }

    const rows = await this.db
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
          eq(inventoryServices.userId, params.userId),
          params.organizationId ? eq(inventoryServices.organizationId, params.organizationId) : undefined,
          inArray(inventoryServices.assetId, params.assetIds),
        ),
      )
      .orderBy(desc(inventoryServices.lastSeenAt));

    for (const row of rows) {
      const list = servicesByAsset.get(row.assetId) ?? [];
      list.push({
        id: row.id,
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
  }

  async loadInventoryEndpointsByAssetIds(params: {
    userId: string;
    organizationId?: string;
    assetIds: string[];
  }): Promise<Map<string, InventoryEndpointSummary[]>> {
    const endpointsByAsset = new Map<string, InventoryEndpointSummary[]>();
    if (params.assetIds.length === 0) {
      return endpointsByAsset;
    }

    const rows = await this.db
      .select({
        id: inventoryNotes.id,
        assetId: inventoryNotes.assetId,
        title: inventoryNotes.title,
        data: inventoryNotes.data,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.userId, params.userId),
          params.organizationId ? eq(inventoryNotes.organizationId, params.organizationId) : undefined,
          inArray(inventoryNotes.assetId, params.assetIds),
          eq(inventoryNotes.ntype, 'http.endpoint'),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt));

    for (const row of rows) {
      if (!row.assetId) {
        continue;
      }
      const data = isRecord(row.data) ? row.data : {};
      const methodRaw = typeof data['method'] === 'string' ? normalizeToolText(data['method']) : 'GET';
      const titleFromData =
        typeof data['title'] === 'string' ? normalizeOptionalToolText(data['title']) : undefined;
      const statusCodeValue =
        typeof data['statusCode'] === 'number'
          ? data['statusCode']
          : typeof data['statusCode'] === 'string'
            ? Number(data['statusCode']) || undefined
            : undefined;
      const list = endpointsByAsset.get(row.assetId) ?? [];
      list.push({
        id: row.id,
        assetId: row.assetId,
        url: typeof data['url'] === 'string' ? data['url'] : '',
        method: methodRaw || 'GET',
        statusCode: statusCodeValue,
        title: titleFromData ?? row.title ?? undefined,
        lastSeenAt: toIsoString(row.lastSeenAt) ?? String(row.lastSeenAt),
      });
      endpointsByAsset.set(row.assetId, list);
    }

    return endpointsByAsset;
  }

  async loadInventoryTechsByAssetIds(params: {
    userId: string;
    organizationId?: string;
    assetIds: string[];
  }): Promise<Map<string, InventoryTechSummary[]>> {
    const techsByAsset = new Map<string, InventoryTechSummary[]>();
    if (params.assetIds.length === 0) {
      return techsByAsset;
    }

    const rows = await this.db
      .select({
        id: inventoryNotes.id,
        assetId: inventoryNotes.assetId,
        data: inventoryNotes.data,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.userId, params.userId),
          params.organizationId ? eq(inventoryNotes.organizationId, params.organizationId) : undefined,
          inArray(inventoryNotes.assetId, params.assetIds),
          eq(inventoryNotes.ntype, 'tech.fingerprint'),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt));

    for (const row of rows) {
      if (!row.assetId) {
        continue;
      }
      const data = isRecord(row.data) ? row.data : {};
      const product = typeof data['product'] === 'string' ? normalizeOptionalToolText(data['product']) : undefined;
      if (!product) {
        continue;
      }
      const list = techsByAsset.get(row.assetId) ?? [];
      list.push({
        id: row.id,
        assetId: row.assetId,
        product,
        version: typeof data['version'] === 'string' ? normalizeOptionalToolText(data['version']) : undefined,
        category: typeof data['category'] === 'string' ? normalizeOptionalToolText(data['category']) : undefined,
        confidence:
          typeof data['confidence'] === 'number'
            ? data['confidence']
            : typeof data['confidence'] === 'string'
              ? Number(data['confidence']) || undefined
              : undefined,
        lastSeenAt: toIsoString(row.lastSeenAt) ?? String(row.lastSeenAt),
      });
      techsByAsset.set(row.assetId, list);
    }

    return techsByAsset;
  }

  async loadBroadScanCoverageByAssetIds(params: {
    userId: string;
    organizationId?: string;
    assetIds: string[];
  }): Promise<Map<string, ScanCoverageSummary>> {
    const coverageByAsset = new Map<string, ScanCoverageSummary>();
    if (params.assetIds.length === 0) {
      return coverageByAsset;
    }

    const rows = await this.db
      .select({
        id: inventoryNotes.id,
        assetId: inventoryNotes.assetId,
        data: inventoryNotes.data,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.userId, params.userId),
          params.organizationId ? eq(inventoryNotes.organizationId, params.organizationId) : undefined,
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
  }

  async computeCurrentInventoryFingerprint(params: {
    userId: string;
    organizationId?: string;
    assetId: string;
    assetValue: string;
  }): Promise<string> {
    const assetIds = [params.assetId];
    const [servicesByAsset, techsByAsset] = await Promise.all([
      this.loadInventoryServicesByAssetIds({
        userId: params.userId,
        organizationId: params.organizationId,
        assetIds,
      }),
      this.loadInventoryTechsByAssetIds({
        userId: params.userId,
        organizationId: params.organizationId,
        assetIds,
      }),
    ]);

    return buildAssetInventoryFingerprint({
      assetValue: params.assetValue,
      services: servicesByAsset.get(params.assetId) ?? [],
      techs: techsByAsset.get(params.assetId) ?? [],
    });
  }
}
