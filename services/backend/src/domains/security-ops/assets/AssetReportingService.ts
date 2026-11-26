import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { inventoryServices, type ComponentVersionReadMethod } from '@/db/schema';
import { logger } from '@/shared/logger';
import type {
  AssetIngestionWriter,
  AssetWriterContext,
  AssetWriterEvidenceRef,
  AssetWriterResolvedEvidenceRef
} from '@/domains/security-ops/assets/AssetIngestionWriter';

export const EvidenceRefSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1).optional(),
});

export const AssetKindSchema = z.enum(['domain', 'ip']);
export const AssetRefSchema = z.object({
  kind: AssetKindSchema,
  value: z.string().min(1),
});

export const ReportAssetSchema = z.object({
  kind: AssetKindSchema,
  value: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  evidence: z.array(EvidenceRefSchema).optional(),
});

const ServiceProtocolSchema = z.enum(['tcp', 'udp', 'http', 'https']);
const ActiveVersionReadMethodSchema = z.enum([
  'http_banner',
  'service_probe',
  'application_fingerprint',
  'error_behavior',
  'tls_fingerprint',
]);
export const ReportServiceSchema = z.object({
  assetRef: AssetRefSchema,
  hostname: z.string().min(1).optional(),
  protocol: ServiceProtocolSchema,
  port: z.number().int().min(1).max(65535),
  serviceName: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  versionReadMethod: ActiveVersionReadMethodSchema.optional(),
  evidence: z.array(EvidenceRefSchema).optional(),
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type AssetRef = z.infer<typeof AssetRefSchema>;
export type ReportAssetInput = z.infer<typeof ReportAssetSchema>;
export type ReportAssetResult = { assetId: string; created: boolean };
export type ReportServiceResult = { serviceId: string; created: boolean };

export type AssetReportingContext = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
};

export type AssetIngestSummaryCounters = {
  assetsCreated: number;
  assetsTouched: number;
};

type AssetReportingServiceOptions = {
  now: () => Date;
  assetWriter: Pick<AssetIngestionWriter, 'upsertAsset' | 'incrementRunCounter'>;
  /**
   * Project a reported service into the typed component inventory.
   *
   * `inventory_services` carries a real product and version per port, so it is
   * the second matchable writer alongside tech.fingerprint notes. Optional, and
   * best-effort, for the same reason as the note path: the service record must
   * land even if identity resolution fails.
   */
  recordComponentObservation?: (params: {
    organizationId: string;
    assetId: string;
    scopeId?: string | null;
    observedByUserId?: string | null;
    sessionId?: string | null;
    product: string;
    version?: string | null;
    versionReadMethod?: ComponentVersionReadMethod;
    port?: number | null;
    serviceId?: string | null;
    evidence?: Array<{ path: string; label?: string }>;
  }) => Promise<unknown>;
  normalizeSessionId: (raw: string | undefined) => string | undefined;
  normalizeAssetValue: (kind: z.infer<typeof AssetKindSchema>, rawValue: string) => string;
  normalizeAssetRefForHost: (params: {
    assetRef: AssetRef;
    hostname?: string;
    endpointUrl?: string;
  }) => AssetRef;
  resolveEvidenceRefs: (
    workspaceDir: string,
    evidence: EvidenceRef[] | undefined,
  ) => Promise<AssetWriterResolvedEvidenceRef[]>;
  mergeEvidenceByPath: (
    existing: AssetWriterEvidenceRef[] | null | undefined,
    incoming: AssetWriterEvidenceRef[] | null | undefined,
  ) => AssetWriterEvidenceRef[];
  isUniqueViolation: (error: unknown) => boolean;
  emitSecurityOpsEvent: (
    organizationId: string | undefined,
    event: {
      type: 'finding_created' | 'asset_discovered';
      payload: Record<string, unknown>;
      summary: string;
    },
  ) => Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbExecutor = DatabaseClient | any;

export class AssetReportingService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options: AssetReportingServiceOptions,
  ) {}

  async upsertAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: AssetReportingContext;
    input: ReportAssetInput & {
      parentAssetId?: string | null;
    };
    executor?: DbExecutor;
  }): Promise<ReportAssetResult> {
    return this.options.assetWriter.upsertAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context as AssetWriterContext | undefined,
      input: params.input,
      executor: params.executor,
    });
  }

  async reportAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context: AssetReportingContext;
    input: unknown;
  }): Promise<ReportAssetResult> {
    const parsed = ReportAssetSchema.parse(params.input);
    const organizationId = this.requireOrganizationId(params.context);
    const sessionId = this.options.normalizeSessionId(params.sessionId);

    const result = await this.db.transaction(async (tx) =>
      this.upsertAsset({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId,
        context: params.context,
        input: parsed,
        executor: tx,
      }),
    );

    if (result.created) {
      const normalizedValue = this.options.normalizeAssetValue(parsed.kind, parsed.value);
      await this.options.emitSecurityOpsEvent(organizationId, {
        type: 'asset_discovered',
        payload: {
          assetId: result.assetId,
          kind: parsed.kind,
          value: normalizedValue,
        },
        summary: `New asset discovered: ${normalizedValue} (${parsed.kind})`,
      });
    }

    return result;
  }

  /**
   * Mirror a reported service into `inventory_components`.
   *
   * Best-effort by design: a failure here costs a match, while throwing would
   * cost the service record itself.
   */
  private async projectServiceComponent(params: {
    organizationId: string;
    assetId: string;
    scopeId?: string | null;
    userId: string;
    sessionId?: string;
    parsed: {
      product?: string | null;
      version?: string | null;
      versionReadMethod?: ComponentVersionReadMethod;
      port: number;
    };
    serviceId: string;
    evidence: Array<{ path: string; label?: string }>;
  }): Promise<void> {
    const record = this.options.recordComponentObservation;
    const product = params.parsed.product?.trim();
    if (!record || !product) return;

    try {
      await record({
        organizationId: params.organizationId,
        assetId: params.assetId,
        scopeId: params.scopeId ?? null,
        observedByUserId: params.userId,
        sessionId: params.sessionId ?? null,
        product,
        version: params.parsed.version ?? null,
        versionReadMethod: params.parsed.versionReadMethod,
        port: params.parsed.port,
        serviceId: params.serviceId,
        evidence: params.evidence,
      });
    } catch (error) {
      logger.warn(
        { err: error, assetId: params.assetId, product },
        '[threat-watch] Failed to project service into component inventory',
      );
    }
  }

  async reportService(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context: AssetReportingContext;
    input: unknown;
  }): Promise<ReportServiceResult> {
    const parsed = ReportServiceSchema.parse(params.input);
    const now = this.options.now();
    const sessionId = this.options.normalizeSessionId(params.sessionId);
    const organizationId = this.requireOrganizationId(params.context);
    const normalizedAssetRef = this.options.normalizeAssetRefForHost({
      assetRef: parsed.assetRef,
      hostname: parsed.hostname,
    });

    const { assetId } = await this.upsertAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId,
      context: params.context,
      input: {
        kind: normalizedAssetRef.kind,
        value: normalizedAssetRef.value,
      },
    });

    const evidence = await this.options.resolveEvidenceRefs(params.workspaceDir, parsed.evidence);

    const [existing] = await this.db
      .select({
        id: inventoryServices.id,
        evidence: inventoryServices.evidence,
      })
      .from(inventoryServices)
      .where(
        and(
          eq(inventoryServices.userId, params.userId),
          eq(inventoryServices.assetId, assetId),
          eq(inventoryServices.protocol, parsed.protocol),
          eq(inventoryServices.port, parsed.port),
        ),
      )
      .limit(1);

    if (existing) {
      await this.db
        .update(inventoryServices)
        .set({
          organizationId,
          serviceName: parsed.serviceName ?? undefined,
          product: parsed.product ?? undefined,
          version: parsed.version ?? undefined,
          evidence: this.options.mergeEvidenceByPath(existing.evidence, evidence),
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(inventoryServices.id, existing.id));
      await this.projectServiceComponent({
        organizationId,
        assetId,
        scopeId: params.context.scopeId,
        userId: params.userId,
        sessionId,
        parsed,
        serviceId: existing.id,
        evidence,
      });
      return { serviceId: existing.id, created: false };
    }

    try {
      const [row] = await this.db
        .insert(inventoryServices)
        .values({
          organizationId,
          userId: params.userId,
          assetId,
          protocol: parsed.protocol,
          port: parsed.port,
          serviceName: parsed.serviceName ?? undefined,
          product: parsed.product ?? undefined,
          version: parsed.version ?? undefined,
          evidence,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: inventoryServices.id });
      await this.options.assetWriter.incrementRunCounter(params.context.runId, 'inventoryAdded');
      await this.projectServiceComponent({
        organizationId,
        assetId,
        scopeId: params.context.scopeId,
        userId: params.userId,
        sessionId,
        parsed,
        serviceId: row.id,
        evidence,
      });
      return { serviceId: row.id, created: true };
    } catch (error) {
      if (!this.options.isUniqueViolation(error)) {
        throw error;
      }
    }

    const [afterRace] = await this.db
      .select({ id: inventoryServices.id, evidence: inventoryServices.evidence })
      .from(inventoryServices)
      .where(
        and(
          eq(inventoryServices.userId, params.userId),
          eq(inventoryServices.assetId, assetId),
          eq(inventoryServices.protocol, parsed.protocol),
          eq(inventoryServices.port, parsed.port),
        ),
      )
      .limit(1);
    if (!afterRace) {
      throw new Error('Failed to upsert service');
    }
    await this.db
      .update(inventoryServices)
      .set({
        organizationId,
        serviceName: parsed.serviceName ?? undefined,
        product: parsed.product ?? undefined,
        version: parsed.version ?? undefined,
        evidence: this.options.mergeEvidenceByPath(afterRace.evidence, evidence),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(inventoryServices.id, afterRace.id));
    await this.projectServiceComponent({
      organizationId,
      assetId,
      scopeId: params.context.scopeId,
      userId: params.userId,
      sessionId,
      parsed,
      serviceId: afterRace.id,
      evidence,
    });
    return { serviceId: afterRace.id, created: false };
  }

  async ensureIngestedAsset(params: {
    summary: AssetIngestSummaryCounters;
    seenAssets: Set<string>;
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context: AssetReportingContext;
    assetRef: AssetRef;
    evidence: EvidenceRef[];
  }): Promise<void> {
    const assetKey = `${params.assetRef.kind}:${params.assetRef.value}`;
    if (params.seenAssets.has(assetKey)) {
      return;
    }
    params.seenAssets.add(assetKey);

    const result = await this.reportAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      input: {
        kind: params.assetRef.kind,
        value: params.assetRef.value,
        evidence: params.evidence,
      },
    });

    if (result.created) {
      params.summary.assetsCreated += 1;
    } else {
      params.summary.assetsTouched += 1;
    }
  }

  private requireOrganizationId(context: AssetReportingContext): string {
    if (!context.organizationId) {
      throw new Error('organizationId is required in SecurityOps context');
    }
    return context.organizationId;
  }
}
