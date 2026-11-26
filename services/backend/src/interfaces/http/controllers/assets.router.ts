import { Router } from 'express';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { db } from '@/db/client';
import {
  assets,
  findingEvidence,
  findings,
  inventoryNotes,
  inventoryServices,
  scopes,
} from '@/db/schema';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import {
  type AssetFocusEnrichment,
  loadAssetFocusEnrichments,
} from '@/domains/security-ops/assets/assetFocus';
import { and, eq, desc, sql, count, type SQL } from 'drizzle-orm';
import { customerVisibleAssetClause } from '@/domains/security-ops/assets/assetConfirmation';
import { sendApiError, ERROR_CODES } from '@/shared/errors';
import { toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 500;
const ALLOWED_ASSET_KINDS = new Set(['domain', 'ip', 'cloud_resource', 'all']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parseListLimit = (value: string | undefined): number | null => {
  if (!value) return DEFAULT_LIST_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.floor(parsed), MAX_LIST_LIMIT);
};

export function createAssetsRouter(): Router {
  const router = Router();
  const orgService = new OrganizationService(db);
  const isSqlClause = (clause: SQL<unknown> | undefined): clause is SQL<unknown> => clause !== undefined;

  const toIsoValue = (value: Date | string | null | undefined): string | null => {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  };

  const mapEnrichedAsset = (
    row: {
      id: string;
      kind: string;
      value: string;
      tags: string[] | null;
      scopeId: string | null;
      firstSeenAt: Date | string;
      lastSeenAt: Date | string;
      lastScannedAt?: Date | string | null;
    findingCount?: number | string | null;
    serviceCount?: number | string | null;
    endpointCount?: number | string | null;
    observationCount?: number | string | null;
    subdomainCount?: number | string | null;
    },
    enrichment?: AssetFocusEnrichment,
  ) => {
    const focus = enrichment?.focus ?? { score: 0, label: 'low', reasons: [] };
    return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    tags: row.tags ?? [],
    scopeId: row.scopeId,
    firstSeenAt: toIsoValue(row.firstSeenAt) ?? String(row.firstSeenAt),
    lastSeenAt: toIsoValue(row.lastSeenAt) ?? String(row.lastSeenAt),
    lastScannedAt: toIsoValue(row.lastScannedAt),
    findingCount: Number(row.findingCount ?? enrichment?.openFindings.total ?? 0),
    serviceCount: Number(row.serviceCount ?? enrichment?.serviceCount ?? 0),
    endpointCount: Number(row.endpointCount ?? 0),
    observationCount: Number(row.observationCount ?? 0),
    subdomainCount: Number(row.subdomainCount ?? 0),
    focus,
    };
  };

  const enrichAssetRows = async <
    TRow extends {
      id: string;
      kind: string;
      value: string;
      scopeId?: string | null;
      lastScannedAt?: Date | string | null;
    },
  >(
    orgId: string,
    userId: string | undefined,
    rows: TRow[],
  ) => {
    const grouped = new Map<string, TRow[]>();
    for (const row of rows) {
      if (!row.scopeId) continue;
      const list = grouped.get(row.scopeId) ?? [];
      list.push(row);
      grouped.set(row.scopeId, list);
    }

    const merged = new Map<string, AssetFocusEnrichment>();
    for (const [scopeId, scopedRows] of grouped) {
      const enrichments = await loadAssetFocusEnrichments({
        db,
        organizationId: orgId,
        ...(userId ? { userId } : {}),
        scopeId,
        assets: scopedRows.map((row) => ({
          id: row.id,
          kind: row.kind,
          value: row.value,
          lastScannedAt: row.lastScannedAt,
        })),
      });
      for (const [assetId, enrichment] of enrichments.entries()) {
        merged.set(assetId, enrichment);
      }
    }

    return merged;
  };

  router.use(authMiddleware);

  async function getOrgId(req: { user?: { id: string }; organizationId?: string }): Promise<string> {
    if (req.organizationId) return req.organizationId;
    const userId = req.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const org = await orgService.getForUser(userId);
    req.organizationId = org.id;
    return org.id;
  }

  // GET /api/app/assets — list assets with optional filters
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const { scopeId, kind, limit } = req.query as Record<string, string | undefined>;
      const normalizedKind = kind?.trim().toLowerCase();
      const safeLimit = parseListLimit(limit);

      if (scopeId && !UUID_RE.test(scopeId)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'scopeId must be a valid UUID',
        });
      }
      if (normalizedKind && !ALLOWED_ASSET_KINDS.has(normalizedKind)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'kind must be one of: domain, ip, cloud_resource, all',
        });
      }
      if (safeLimit === null) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'limit must be a positive number',
        });
      }

      const whereClauses = [
        eq(assets.organizationId, orgId),
        customerVisibleAssetClause(scopeId),
        normalizedKind && normalizedKind !== 'all' ? eq(assets.kind, normalizedKind) : undefined,
      ].filter(isSqlClause);

      const rows = await db
        .select({
          id: assets.id,
          kind: assets.kind,
          value: assets.value,
          tags: assets.tags,
          scopeId: assets.scopeId,
          lastScannedAt: assets.lastScannedAt,
          firstSeenAt: assets.firstSeenAt,
          lastSeenAt: assets.lastSeenAt,
          findingCount: sql<number>`(
            select count(*)::int
            from ${findings}
            where ${findings.assetId} = ${assets.id}
          )`,
          serviceCount: sql<number>`(
            select count(*)::int
            from ${inventoryServices}
            where ${inventoryServices.assetId} = ${assets.id}
          )`,
          endpointCount: sql<number>`(
            select count(*)::int
            from ${inventoryNotes}
            where ${inventoryNotes.assetId} = ${assets.id}
              and ${inventoryNotes.ntype} = 'http.endpoint'
          )`,
          observationCount: sql<number>`(
            select count(*)::int
            from ${inventoryNotes}
            where ${inventoryNotes.assetId} = ${assets.id}
          )`,
          subdomainCount: sql<number>`(
            select count(*)::int
            from ${inventoryNotes}
            where ${inventoryNotes.assetId} = ${assets.id}
              and ${inventoryNotes.ntype} = 'dns.subdomain'
          )`,
        })
        .from(assets)
        .where(and(...whereClauses))
        .orderBy(desc(assets.lastSeenAt))
        .limit(safeLimit);

      const focusByAsset = await enrichAssetRows(orgId, undefined, rows);

      const mapped = rows.map((row) => mapEnrichedAsset(row, focusByAsset.get(row.id)));

      res.json(mapped);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to list assets');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to list assets' });
    }
  });

  // POST /api/app/assets — create an asset manually
  router.post('/', async (req, res) => {
    try {
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        message: 'Manual asset creation is disabled. Assets must be discovered through runs.',
        status: 405,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to reject manual asset creation');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to reject manual asset creation' });
    }
  });

  // GET /api/app/assets/:id — asset detail
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req);

      const [row] = await db
        .select({
          id: assets.id,
          organizationId: assets.organizationId,
          scopeId: assets.scopeId,
          userId: assets.userId,
          kind: assets.kind,
          value: assets.value,
          tags: assets.tags,
          evidence: assets.evidence,
          parentAssetId: assets.parentAssetId,
          lastScannedAt: assets.lastScannedAt,
          firstSeenAt: assets.firstSeenAt,
          lastSeenAt: assets.lastSeenAt,
          createdAt: assets.createdAt,
          updatedAt: assets.updatedAt,
        })
        .from(assets)
        .where(and(eq(assets.organizationId, orgId), eq(assets.id, req.params.id), customerVisibleAssetClause()))
        .limit(1);

      if (!row) {
        return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Asset not found' });
      }

      // Get counts
      const [findingCountRow] = await db
        .select({ count: count() })
        .from(findings)
        .where(eq(findings.assetId, row.id));

      const [serviceCountRow] = await db
        .select({ count: count() })
        .from(inventoryServices)
        .where(eq(inventoryServices.assetId, row.id));

      const [endpointCountRow] = await db
        .select({ count: count() })
        .from(inventoryNotes)
        .where(and(eq(inventoryNotes.assetId, row.id), eq(inventoryNotes.ntype, 'http.endpoint')));

      const [observationCountRow] = await db
        .select({ count: count() })
        .from(inventoryNotes)
        .where(eq(inventoryNotes.assetId, row.id));

      const [subdomainCountRow] = await db
        .select({ count: count() })
        .from(inventoryNotes)
        .where(and(eq(inventoryNotes.assetId, row.id), eq(inventoryNotes.ntype, 'dns.subdomain')));

      const focusByAsset = await enrichAssetRows(orgId, undefined, [row]);

      res.json(
        mapEnrichedAsset(
          {
            ...row,
            findingCount: findingCountRow?.count,
            serviceCount: serviceCountRow?.count,
            endpointCount: endpointCountRow?.count,
            observationCount: observationCountRow?.count,
            subdomainCount: subdomainCountRow?.count,
          },
          focusByAsset.get(row.id),
        ),
      );
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to get asset detail');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get asset' });
    }
  });

  // GET /api/app/assets/:id/services — services for this asset
  router.get('/:id/services', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      // Verify asset ownership
      const [asset] = await db.select({ id: assets.id }).from(assets)
        .where(and(eq(assets.organizationId, orgId), eq(assets.id, req.params.id), customerVisibleAssetClause())).limit(1);
      if (!asset) return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Asset not found' });

      const rows = await db
        .select()
        .from(inventoryServices)
        .where(eq(inventoryServices.assetId, req.params.id))
        .orderBy(desc(inventoryServices.lastSeenAt));

      res.json(
        rows.map((row) => ({
          ...row,
          evidence: row.evidence ?? [],
          firstSeenAt: row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : row.firstSeenAt,
          lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        })),
      );
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to get services');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get services' });
    }
  });

  // GET /api/app/assets/:id/endpoints — endpoints for this asset
  router.get('/:id/endpoints', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const [asset] = await db.select({ id: assets.id }).from(assets)
        .where(and(eq(assets.organizationId, orgId), eq(assets.id, req.params.id), customerVisibleAssetClause())).limit(1);
      if (!asset) return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Asset not found' });

      const rows = await db
        .select({
          id: inventoryNotes.id,
          organizationId: inventoryNotes.organizationId,
          userId: inventoryNotes.userId,
          assetId: inventoryNotes.assetId,
          title: inventoryNotes.title,
          data: inventoryNotes.data,
          evidence: inventoryNotes.evidence,
          firstSeenAt: inventoryNotes.firstSeenAt,
          lastSeenAt: inventoryNotes.lastSeenAt,
          createdAt: inventoryNotes.createdAt,
          updatedAt: inventoryNotes.updatedAt,
        })
        .from(inventoryNotes)
        .where(and(eq(inventoryNotes.assetId, req.params.id), eq(inventoryNotes.ntype, 'http.endpoint')))
        .orderBy(desc(inventoryNotes.lastSeenAt));

      const mapped = rows.map((row) => {
        const data = typeof row.data === 'object' && row.data !== null ? row.data as Record<string, unknown> : {};
        const method = typeof data.method === 'string' ? String(data.method).trim().toUpperCase() : 'GET';
        const statusCode =
          typeof data.statusCode === 'number'
            ? data.statusCode
            : typeof data.statusCode === 'string'
              ? Number(data.statusCode) || undefined
              : undefined;
        const titleFromData = typeof data.title === 'string' ? data.title : undefined;

        return {
          id: row.id,
          organizationId: row.organizationId,
          userId: row.userId,
          assetId: row.assetId,
          serviceId: null,
          url: typeof data.url === 'string' ? data.url : '',
          method,
          statusCode,
          title: row.title ?? titleFromData ?? null,
          evidence: row.evidence ?? [],
          firstSeenAt: row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : row.firstSeenAt,
          lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        };
      });

      res.json(mapped);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to get endpoints');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get endpoints' });
    }
  });

  // GET /api/app/assets/:id/subdomains — subdomains for this asset
  router.get('/:id/subdomains', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const [asset] = await db.select({ id: assets.id }).from(assets)
        .where(and(eq(assets.organizationId, orgId), eq(assets.id, req.params.id), customerVisibleAssetClause())).limit(1);
      if (!asset) return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Asset not found' });

      const rows = await db
        .select({
          id: inventoryNotes.id,
          organizationId: inventoryNotes.organizationId,
          userId: inventoryNotes.userId,
          assetId: inventoryNotes.assetId,
          data: inventoryNotes.data,
          evidence: inventoryNotes.evidence,
          firstSeenAt: inventoryNotes.firstSeenAt,
          lastSeenAt: inventoryNotes.lastSeenAt,
          createdAt: inventoryNotes.createdAt,
          updatedAt: inventoryNotes.updatedAt,
        })
        .from(inventoryNotes)
        .where(and(eq(inventoryNotes.assetId, req.params.id), eq(inventoryNotes.ntype, 'dns.subdomain')))
        .orderBy(desc(inventoryNotes.lastSeenAt));

      const mapped = rows.map((row) => {
        const data = typeof row.data === 'object' && row.data !== null ? row.data as Record<string, unknown> : {};
        const resolvedIps = Array.isArray(data.resolvedIps)
          ? data.resolvedIps.filter((value): value is string => typeof value === 'string')
          : [];
        return {
          id: row.id,
          organizationId: row.organizationId,
          userId: row.userId,
          assetId: row.assetId,
          hostname: typeof data.hostname === 'string' ? data.hostname : '',
          resolvedIps,
          evidence: row.evidence ?? [],
          firstSeenAt: row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : row.firstSeenAt,
          lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        };
      });

      res.json(mapped);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to get subdomains');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get subdomains' });
    }
  });

  // GET /api/app/assets/:id/tech — tech fingerprints for this asset
  router.get('/:id/tech', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const [asset] = await db.select({ id: assets.id }).from(assets)
        .where(and(eq(assets.organizationId, orgId), eq(assets.id, req.params.id), customerVisibleAssetClause())).limit(1);
      if (!asset) return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Asset not found' });

      const rows = await db
        .select({
          id: inventoryNotes.id,
          organizationId: inventoryNotes.organizationId,
          userId: inventoryNotes.userId,
          assetId: inventoryNotes.assetId,
          confidence: inventoryNotes.confidence,
          data: inventoryNotes.data,
          evidence: inventoryNotes.evidence,
          firstSeenAt: inventoryNotes.firstSeenAt,
          lastSeenAt: inventoryNotes.lastSeenAt,
          createdAt: inventoryNotes.createdAt,
          updatedAt: inventoryNotes.updatedAt,
        })
        .from(inventoryNotes)
        .where(and(eq(inventoryNotes.assetId, req.params.id), eq(inventoryNotes.ntype, 'tech.fingerprint')))
        .orderBy(desc(inventoryNotes.lastSeenAt));

      const mapped = rows.map((row) => {
        const data = typeof row.data === 'object' && row.data !== null ? row.data as Record<string, unknown> : {};
        const confidenceFromData =
          typeof data.confidence === 'number'
            ? data.confidence
            : typeof data.confidence === 'string'
              ? Number(data.confidence) || undefined
              : undefined;
        const normalizedConfidence = row.confidence ?? confidenceFromData;
        return {
          id: row.id,
          organizationId: row.organizationId,
          userId: row.userId,
          assetId: row.assetId,
          product: typeof data.product === 'string' ? data.product : '',
          version: typeof data.version === 'string' ? data.version : null,
          category: typeof data.category === 'string' ? data.category : null,
          confidence: normalizedConfidence === undefined || normalizedConfidence === null
            ? null
            : Math.max(0, Math.min(100, Math.round(normalizedConfidence * 100))),
          evidence: row.evidence ?? [],
          firstSeenAt: row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : row.firstSeenAt,
          lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        };
      });

      res.json(mapped);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to get tech');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get tech' });
    }
  });

  // GET /api/app/assets/:id/scan-coverage — curated customer summary of the latest broad scan
  router.get('/:id/scan-coverage', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const [asset] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.organizationId, orgId), eq(assets.id, req.params.id), customerVisibleAssetClause()))
        .limit(1);
      if (!asset) {
        return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Asset not found' });
      }

      const [coverage] = await db
        .select({
          data: inventoryNotes.data,
          lastSeenAt: inventoryNotes.lastSeenAt,
        })
        .from(inventoryNotes)
        .where(and(eq(inventoryNotes.assetId, req.params.id), eq(inventoryNotes.ntype, 'scan.coverage')))
        .orderBy(desc(inventoryNotes.lastSeenAt))
        .limit(1);

      if (!coverage) {
        return res.json(null);
      }

      const data = isRecord(coverage.data) ? coverage.data : {};
      const stats = isRecord(data.stats) ? data.stats : {};
      const rawStatus = data.status;

      res.json({
        status: rawStatus === 'completed' || rawStatus === 'blocked' ? rawStatus : 'unknown',
        assessedAt: toIsoValue(coverage.lastSeenAt) ?? String(coverage.lastSeenAt),
        endpointsDiscovered: toNonNegativeInteger(stats.endpointsDiscovered),
        findingsCreated: toNonNegativeInteger(stats.findingsCreated),
        technologiesDetected: toNonNegativeInteger(stats.techsDetected),
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to get scan coverage');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get scan coverage' });
    }
  });

  // GET /api/app/assets/:id/findings — findings for this asset
  router.get('/:id/findings', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const [asset] = await db.select({
        id: assets.id,
        value: assets.value,
        kind: assets.kind,
        scopeId: assets.scopeId,
      }).from(assets)
        .where(and(eq(assets.organizationId, orgId), eq(assets.id, req.params.id), customerVisibleAssetClause())).limit(1);
      if (!asset) return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Asset not found' });

      const [scope] = asset.scopeId
        ? await db
            .select({ name: scopes.name })
            .from(scopes)
            .where(and(eq(scopes.organizationId, orgId), eq(scopes.id, asset.scopeId)))
            .limit(1)
        : [];

      const rows = await db
        .select({
          id: findings.id,
          title: findings.title,
          severity: findings.severity,
          state: findings.state,
          summary: findings.summary,
          businessImpact: findings.businessImpact,
          remediation: findings.remediation,
          cweId: findings.cweId,
          cveId: findings.cveId,
          cweIds: findings.cweIds,
          cveIds: findings.cveIds,
          owaspCategory: findings.owaspCategory,
          cvssVector: findings.cvssVector,
          cvssScore: findings.cvssScore,
          confidence: findings.confidenceScore,
          evidenceCount: sql<number>`(
            select count(*)::int
            from ${findingEvidence}
            where ${findingEvidence.findingId} = ${findings.id}
          )`,
          firstSeenAt: findings.firstSeenAt,
          lastSeenAt: findings.lastSeenAt,
          createdAt: findings.createdAt,
        })
        .from(findings)
        .where(eq(findings.assetId, req.params.id))
        .orderBy(desc(findings.lastSeenAt));

      res.json(
        rows.map((row) => ({
          ...row,
          evidenceCount: Number(row.evidenceCount ?? 0),
          assetId: asset.id,
          assetValue: asset.value,
          assetKind: asset.kind,
          scopeId: asset.scopeId,
          scopeName: scope?.name ?? 'Unknown',
          firstSeenAt: row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : row.firstSeenAt,
          lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        })),
      );
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[assets] Failed to get asset findings');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get asset findings' });
    }
  });

  return router;
}
