import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { logger } from '@/shared/logger';
import {
  inventoryNotes,
  type ComponentObservationSource,
  type ComponentVersionReadMethod,
} from '@/db/schema';
import {
  normalizeScanCoverageData,
  type InventoryProjection,
} from '@/domains/security-ops/assets/InventoryProjection';
import { ntypeSchemas } from '@/domains/security-ops/tools/ntypeSchemas';

const EvidenceWithExcerptSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1).optional(),
  excerpt: z.string().min(1).optional(),
});

const AssetRefSchema = z.object({
  kind: z.enum(['domain', 'ip']),
  value: z.string().min(1),
});

export const ReportNoteSchema = z.object({
  assetRef: AssetRefSchema.optional(),
  ntype: z.string().min(1),
  title: z.string().min(1).optional(),
  data: z.record(z.unknown()),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(EvidenceWithExcerptSchema).optional(),
});

type AssetRef = z.infer<typeof AssetRefSchema>;
type ReportNoteInput = z.infer<typeof ReportNoteSchema>;
type EvidenceWithExcerpt = z.infer<typeof EvidenceWithExcerptSchema> & { fileMissing?: boolean };

type InventoryNoteContext = {
  organizationId: string;
  scopeId: string;
  runId?: string;
};

type InventoryNoteWriterOptions = {
  inventoryProjection: InventoryProjection;
  now?: () => Date;
  normalizeSessionId: (raw: string | undefined) => string | undefined;
  normalizeNtype: (raw: string) => string;
  normalizeAssetValue: (kind: AssetRef['kind'], rawValue: string) => string;
  normalizeToolText: (value: string) => string;
  normalizeOptionalToolText: (value: string | undefined) => string | undefined;
  normalizeAssetRefForHost: (params: { assetRef: AssetRef; endpointUrl?: string }) => AssetRef;
  extractHostnameFromUrl: (rawUrl: string) => string | undefined;
  pruneNullishDeep: (value: unknown) => unknown;
  buildReportNoteValidationError: (detail: string, ntype?: string) => Error;
  dedupeKeyForNtype: (ntype: string, data: Record<string, unknown>) => string;
  mergeReportNoteData: (
    ntype: string,
    existing: Record<string, unknown> | null | undefined,
    incoming: Record<string, unknown>,
  ) => Record<string, unknown>;
  mergeEvidenceWithExcerptsByPath: (
    existing: EvidenceWithExcerpt[] | null | undefined,
    incoming: EvidenceWithExcerpt[],
  ) => EvidenceWithExcerpt[];
  isUniqueViolation: (error: unknown) => boolean;
  resolveEvidenceWithExcerpts: (workspaceDir: string, evidence: z.infer<typeof EvidenceWithExcerptSchema>[]) => Promise<EvidenceWithExcerpt[]>;
  upsertAsset: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context: InventoryNoteContext;
    input: AssetRef;
  }) => Promise<{ assetId: string }>;
  updateAssetLastScannedAt: (assetId: string, now: Date) => Promise<void>;
  incrementRunCounter: (runId: string | undefined, column: 'inventoryAdded') => Promise<void>;
  /**
   * Project a tech.fingerprint note into the typed component inventory.
   *
   * Optional so existing callers and tests need no change: the note remains the
   * narrative record, and this is the matchable projection of it. Failures here
   * must never fail the note write — see recordComponentFromTechFingerprint.
   */
  recordComponentObservation?: (params: {
    organizationId: string;
    assetId: string;
    scopeId?: string | null;
    observedByUserId?: string | null;
    sessionId?: string | null;
    source: ComponentObservationSource;
    versionReadMethod?: ComponentVersionReadMethod;
    product: string;
    version?: string | null;
    category?: string | null;
    confidence?: number | null;
    evidence?: EvidenceWithExcerpt[];
  }) => Promise<unknown>;
};

const BROAD_SURFACE_SCAN_FAMILY = 'broad-surface';
const BROAD_SURFACE_SCAN_PROFILE_VERSION = 'broad-surface-scan/v1';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

export class InventoryNoteWriter {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options: InventoryNoteWriterOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Mirror a tech.fingerprint note into `inventory_components`.
   *
   * Deliberately best-effort. The note is the agent's record of what it saw and
   * must land even if identity resolution or the component write fails; a
   * missing projection costs us a match, while a thrown error would cost the
   * observation itself. Unresolvable products are not errors either — the
   * component service counts them as coverage gaps.
   */
  private async recordComponentFromTechFingerprint(params: {
    organizationId: string;
    assetId: string;
    scopeId: string;
    userId: string;
    sessionId?: string;
    data: Record<string, unknown>;
    confidence?: number;
    evidence: EvidenceWithExcerpt[];
    observationSource: ComponentObservationSource;
  }): Promise<void> {
    const record = this.options.recordComponentObservation;
    if (!record) return;

    const product = typeof params.data['product'] === 'string' ? params.data['product'] : '';
    if (!product.trim()) return;

    const version = typeof params.data['version'] === 'string' ? params.data['version'] : null;
    const category = typeof params.data['category'] === 'string' ? params.data['category'] : null;
    const versionReadMethod =
      typeof params.data['versionReadMethod'] === 'string'
        ? (params.data['versionReadMethod'] as ComponentVersionReadMethod)
        : undefined;

    try {
      await record({
        organizationId: params.organizationId,
        assetId: params.assetId,
        scopeId: params.scopeId,
        observedByUserId: params.userId,
        sessionId: params.sessionId ?? null,
        source: params.observationSource,
        versionReadMethod,
        product,
        version,
        category,
        confidence: params.confidence ?? null,
        evidence: params.evidence,
      });
    } catch (error) {
      logger.warn(
        { err: error, assetId: params.assetId, product },
        '[threat-watch] Failed to project tech fingerprint into component inventory',
      );
    }
  }

  async reportNote(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    /** Trusted internal provenance supplied by scanner ingestion. */
    componentObservationSource?: ComponentObservationSource;
    context: InventoryNoteContext;
    input: unknown;
  }): Promise<{ noteId: string; created: boolean; dedupeKey: string }> {
    const parsedResult = ReportNoteSchema.safeParse(params.input);
    if (!parsedResult.success) {
      const rawNtype =
        isRecord(params.input) && typeof params.input['ntype'] === 'string'
          ? (params.input['ntype'] as string)
          : undefined;
      throw this.options.buildReportNoteValidationError(formatZodIssues(parsedResult.error), rawNtype);
    }
    const parsed: ReportNoteInput = parsedResult.data;
    const now = this.now();
    const sessionId = this.options.normalizeSessionId(params.sessionId);
    const organizationId = params.context.organizationId;
    const scopeId = params.context.scopeId;
    const ntype = this.options.normalizeNtype(parsed.ntype);
    const ntypeSchema = ntypeSchemas[ntype];

    let normalizedAssetRef = parsed.assetRef
      ? {
          kind: parsed.assetRef.kind,
          value: this.options.normalizeAssetValue(parsed.assetRef.kind, parsed.assetRef.value),
        }
      : undefined;
    const normalizedTitle = parsed.title ? this.options.normalizeToolText(parsed.title) : undefined;
    let normalizedConfidence = parsed.confidence;
    const prunedData = this.options.pruneNullishDeep(parsed.data);
    let normalizedData = isRecord(prunedData) ? { ...prunedData } : {};

    if (ntype === 'http.endpoint') {
      const normalizedUrl =
        typeof normalizedData['url'] === 'string' ? this.options.normalizeToolText(normalizedData['url']) : undefined;
      const normalizedMethodRaw =
        typeof normalizedData['method'] === 'string'
          ? this.options.normalizeOptionalToolText(normalizedData['method'])
          : undefined;
      const normalizedEndpointTitle =
        typeof normalizedData['title'] === 'string'
          ? this.options.normalizeOptionalToolText(normalizedData['title'])
          : normalizedTitle;
      if (normalizedUrl) {
        normalizedData['url'] = normalizedUrl;
        normalizedData['method'] = (normalizedMethodRaw ?? 'GET').toUpperCase();
        if (normalizedEndpointTitle) {
          normalizedData['title'] = normalizedEndpointTitle;
        }
        if (normalizedAssetRef) {
          normalizedAssetRef = this.options.normalizeAssetRefForHost({
            assetRef: normalizedAssetRef,
            endpointUrl: normalizedUrl,
          });
        }
      }
    } else if (ntype === 'dns.subdomain') {
      if (typeof normalizedData['hostname'] === 'string') {
        normalizedData['hostname'] = this.options.normalizeAssetValue('domain', normalizedData['hostname']);
      }
    } else if (ntype === 'tech.fingerprint') {
      if (typeof normalizedData['product'] === 'string') {
        normalizedData['product'] = this.options.normalizeToolText(normalizedData['product']).toLowerCase();
      }

      const confidenceValue = normalizedData['confidence'];
      if (typeof confidenceValue === 'string') {
        const confidenceMap: Record<'high' | 'medium' | 'low', number> = {
          high: 0.9,
          medium: 0.7,
          low: 0.4,
        };
        const normalizedLabel = this.options.normalizeToolText(confidenceValue).toLowerCase();
        if (normalizedLabel in confidenceMap) {
          const mappedConfidence = confidenceMap[normalizedLabel as keyof typeof confidenceMap];
          normalizedData['confidence'] = mappedConfidence;
          normalizedConfidence = normalizedConfidence ?? mappedConfidence;
        }
      }
    } else if (ntype === 'scan.coverage') {
      const statusRaw =
        typeof normalizedData['status'] === 'string'
          ? this.options.normalizeToolText(normalizedData['status']).toLowerCase()
          : '';
      if (statusRaw && statusRaw !== 'completed' && statusRaw !== 'blocked' && statusRaw.includes('blocked')) {
        normalizedData['status'] = 'blocked';
        if (typeof normalizedData['reason'] !== 'string' || normalizedData['reason'].trim().length === 0) {
          normalizedData['reason'] = `Normalized noncanonical status "${statusRaw}" to blocked.`;
        }
      }
      if (typeof normalizedData['profileVersion'] !== 'string' || normalizedData['profileVersion'].trim().length === 0) {
        const family =
          typeof normalizedData['family'] === 'string'
            ? this.options.normalizeToolText(normalizedData['family']).toLowerCase()
            : BROAD_SURFACE_SCAN_FAMILY;
        normalizedData['profileVersion'] =
          family === BROAD_SURFACE_SCAN_FAMILY ? BROAD_SURFACE_SCAN_PROFILE_VERSION : `${family}/v1`;
      }
    }

    let assetId: string | undefined;
    if (normalizedAssetRef) {
      const result = await this.options.upsertAsset({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId,
        context: params.context,
        input: normalizedAssetRef,
      });
      assetId = result.assetId;
    }

    if (ntype === 'scan.coverage' && !assetId) {
      throw this.options.buildReportNoteValidationError('assetRef: Required', ntype);
    }

    if (ntype === 'approach.tried' && !assetId) {
      const rawEndpoint = isRecord(parsed.data) ? (parsed.data['endpoint'] as string | undefined) : undefined;
      const hostname = rawEndpoint ? this.options.extractHostnameFromUrl(rawEndpoint) : undefined;
      if (!hostname) {
        throw this.options.buildReportNoteValidationError(
          'endpoint: endpoint must be a full URL when assetRef is omitted',
          ntype,
        );
      }
      const result = await this.options.upsertAsset({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId,
        context: params.context,
        input: { kind: 'domain', value: hostname },
      });
      assetId = result.assetId;
    }

    if (ntype === 'scan.coverage' && assetId && normalizedAssetRef) {
      const scanCoverageData = { ...normalizedData };
      const inventoryFingerprint =
        typeof scanCoverageData['inventoryFingerprint'] === 'string'
          ? this.options.normalizeOptionalToolText(scanCoverageData['inventoryFingerprint'])
          : undefined;
      if (!inventoryFingerprint) {
        scanCoverageData['inventoryFingerprint'] = await this.options.inventoryProjection.computeCurrentInventoryFingerprint({
          userId: params.userId,
          organizationId,
          assetId,
          assetValue: normalizedAssetRef.value,
        });
      }
      normalizedData = scanCoverageData;
    }

    if (ntypeSchema) {
      const validation = ntypeSchema.safeParse(normalizedData);
      if (!validation.success) {
        throw this.options.buildReportNoteValidationError(formatZodIssues(validation.error), ntype);
      }
      normalizedData = validation.data as Record<string, unknown>;
    }

    const dedupeKey = this.options.dedupeKeyForNtype(ntype, normalizedData);
    const evidence = await this.options.resolveEvidenceWithExcerpts(params.workspaceDir, parsed.evidence ?? []);

    // Placed before the note branches so it runs on both first sight and
    // re-confirmation: a component's freshness matters as much as its discovery.
    if (ntype === 'tech.fingerprint' && assetId) {
      await this.recordComponentFromTechFingerprint({
        organizationId,
        assetId,
        scopeId,
        userId: params.userId,
        sessionId,
        data: normalizedData,
        confidence: normalizedConfidence,
        evidence,
        observationSource: params.componentObservationSource ?? 'agent',
      });
    }

    const whereClauses = [
      eq(inventoryNotes.userId, params.userId),
      eq(inventoryNotes.organizationId, organizationId),
      eq(inventoryNotes.ntype, ntype),
      eq(inventoryNotes.dedupeKey, dedupeKey),
      assetId ? eq(inventoryNotes.assetId, assetId) : isNull(inventoryNotes.assetId),
    ] as const;

    const [existing] = await this.db
      .select({
        id: inventoryNotes.id,
        data: inventoryNotes.data,
        evidence: inventoryNotes.evidence,
      })
      .from(inventoryNotes)
      .where(and(...whereClauses))
      .limit(1);

    if (existing) {
      const mergedData = this.options.mergeReportNoteData(ntype, existing.data, normalizedData);
      await this.db
        .update(inventoryNotes)
        .set({
          scopeId,
          sessionId: sessionId ?? undefined,
          title: normalizedTitle,
          data: mergedData,
          confidence: normalizedConfidence ?? undefined,
          evidence: this.options.mergeEvidenceWithExcerptsByPath(existing.evidence, evidence),
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(inventoryNotes.id, existing.id));
      const scanCoverage = normalizeScanCoverageData(mergedData);
      if (
        assetId &&
        ntype === 'scan.coverage' &&
        scanCoverage.family === BROAD_SURFACE_SCAN_FAMILY &&
        scanCoverage.status === 'completed'
      ) {
        await this.options.updateAssetLastScannedAt(assetId, now);
      }
      return { noteId: existing.id, created: false, dedupeKey };
    }

    try {
      const [row] = await this.db
        .insert(inventoryNotes)
        .values({
          userId: params.userId,
          organizationId,
          assetId: assetId ?? null,
          scopeId,
          sessionId: sessionId ?? null,
          ntype,
          title: normalizedTitle,
          data: normalizedData,
          dedupeKey,
          confidence: normalizedConfidence ?? undefined,
          evidence,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: inventoryNotes.id });
      await this.options.incrementRunCounter(params.context.runId, 'inventoryAdded');
      const scanCoverage = normalizeScanCoverageData(normalizedData);
      if (
        assetId &&
        ntype === 'scan.coverage' &&
        scanCoverage.family === BROAD_SURFACE_SCAN_FAMILY &&
        scanCoverage.status === 'completed'
      ) {
        await this.options.updateAssetLastScannedAt(assetId, now);
      }
      return { noteId: row.id, created: true, dedupeKey };
    } catch (error) {
      if (!this.options.isUniqueViolation(error)) {
        throw error;
      }
    }

    const [afterRace] = await this.db
      .select({
        id: inventoryNotes.id,
        data: inventoryNotes.data,
        evidence: inventoryNotes.evidence,
      })
      .from(inventoryNotes)
      .where(and(...whereClauses))
      .limit(1);
    if (!afterRace) {
      throw new Error('Failed to upsert note');
    }

    const mergedData = this.options.mergeReportNoteData(ntype, afterRace.data, normalizedData);
    await this.db
      .update(inventoryNotes)
      .set({
        scopeId,
        sessionId: sessionId ?? undefined,
        title: normalizedTitle,
        data: mergedData,
        confidence: normalizedConfidence ?? undefined,
        evidence: this.options.mergeEvidenceWithExcerptsByPath(afterRace.evidence, evidence),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(inventoryNotes.id, afterRace.id));

    const scanCoverage = normalizeScanCoverageData(mergedData);
    if (
      assetId &&
      ntype === 'scan.coverage' &&
      scanCoverage.family === BROAD_SURFACE_SCAN_FAMILY &&
      scanCoverage.status === 'completed'
    ) {
      await this.options.updateAssetLastScannedAt(assetId, now);
    }

    return { noteId: afterRace.id, created: false, dedupeKey };
  }
}
