import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  complianceControlChecks,
  complianceAcceptedRisks,
  complianceEvidenceItems,
  complianceEvidenceMappings,
  findingEvidence,
  findings,
  scopes,
  type ComplianceAcceptedRiskRow,
  type ComplianceEvidenceItemRow,
  type ComplianceEvidenceMappingRow,
  type ComplianceEvidenceMappingConfidence,
  type ComplianceEvidenceMappingSource,
  type ComplianceEvidenceReviewStatus,
  type ComplianceEvidenceSourceType,
  type ComplianceEvidenceType,
} from '@/db/schema';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { logger } from '@/shared/logger';
import { ComplianceReadinessService, type ComplianceReadinessStatus } from './ComplianceReadinessService';
import { FRAMEWORK_REGISTRY, type ComplianceFrameworkKey } from './frameworks';
import { isComplianceFrameworkKey } from './profile';

export interface ComplianceEvidenceArtifact {
  fileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  storageRef?: string | null;
  sourceRef?: string | null;
}

export interface ComplianceEvidenceCitationAnchor {
  page?: number | null;
  section?: string | null;
  line?: number | null;
  chunkId?: string | null;
  excerpt?: string | null;
  excerptSha256?: string | null;
}

export interface ComplianceEvidenceMappingInput {
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  mappingSource?: ComplianceEvidenceMappingSource;
  confidence?: ComplianceEvidenceMappingConfidence;
  rationale?: string | null;
  citationAnchors?: ComplianceEvidenceCitationAnchor[];
}

export interface ComplianceEvidenceItemWithMappings extends ComplianceEvidenceItemRow {
  mappings: ComplianceEvidenceMappingRow[];
  agentReview: ComplianceEvidenceAgentReview | null;
}

export interface ComplianceEvidenceAgentReview {
  status: 'reviewed' | 'needs_more_evidence';
  checkId: string;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  verdict: 'pass' | 'fail' | 'needs_context' | 'not_attempted';
  reviewedAt: Date;
  reason: string;
}

export interface ComplianceEvidenceCreateInput {
  organizationId: string;
  scopeId?: string | null;
  uploadedBy?: string | null;
  title: string;
  description?: string | null;
  sourceType?: ComplianceEvidenceSourceType;
  evidenceType?: ComplianceEvidenceType;
  owner?: string | null;
  artifact?: ComplianceEvidenceArtifact;
  metadata?: Record<string, unknown>;
  observationStartedAt?: Date | null;
  observationEndedAt?: Date | null;
  validUntil?: Date | null;
  mappings: ComplianceEvidenceMappingInput[];
}

export interface ComplianceEvidenceUpdateInput {
  organizationId: string;
  evidenceItemId: string;
  actorUserId?: string | null;
  title: string;
  description?: string | null;
  evidenceType: ComplianceEvidenceType;
  owner?: string | null;
  observationStartedAt?: Date | null;
  observationEndedAt?: Date | null;
  validUntil?: Date | null;
  mappings: ComplianceEvidenceMappingInput[];
}

export interface ComplianceEvidenceMappingUpsertInput {
  organizationId: string;
  evidenceItemId: string;
  actorUserId?: string | null;
  mappings: ComplianceEvidenceMappingInput[];
}

export interface ComplianceEvidenceAnnotateInput {
  organizationId: string;
  evidenceItemId: string;
  actorUserId?: string | null;
  title?: string | null;
  description?: string | null;
  evidenceType?: ComplianceEvidenceType;
  validUntil?: Date | null;
}

export interface ComplianceAcceptedRiskCreateInput {
  organizationId: string;
  scopeId?: string | null;
  approvedBy?: string | null;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  evidenceItemId?: string | null;
  owner: string;
  rationale: string;
  expiresAt: Date;
}

export interface ComplianceFindingEvidenceCreateInput {
  organizationId: string;
  scopeId?: string | null;
  uploadedBy?: string | null;
  findingId: string;
  mappings: ComplianceEvidenceMappingInput[];
}

export interface ComplianceIntegrationEvidenceUpsertInput {
  organizationId: string;
  scopeId?: string | null;
  provider: string;
  sourceRecordId: string;
  title: string;
  description?: string | null;
  evidenceType?: ComplianceEvidenceType;
  owner?: string | null;
  artifact: ComplianceEvidenceArtifact;
  metadata?: Record<string, unknown>;
  observationStartedAt?: Date | null;
  observationEndedAt?: Date | null;
  validUntil?: Date | null;
  mappings: ComplianceEvidenceMappingInput[];
}

export interface ComplianceIntegrationEvidenceUpsertResult {
  evidence: ComplianceEvidenceItemWithMappings;
  created: boolean;
  updated: boolean;
  reviewReset: boolean;
}

export interface ComplianceMissingEvidenceItem {
  frameworkKey: ComplianceFrameworkKey;
  frameworkLabel: string;
  controlId: string;
  title: string;
  theme: string;
  supportLevel: string;
  status: ComplianceReadinessStatus;
  score: number;
  gap: string;
  mappedEvidenceCount: number;
  approvedEvidenceCount: number;
  acceptedRiskCount: number;
}

const mapItemRows = (
  items: ComplianceEvidenceItemRow[],
  mappings: ComplianceEvidenceMappingRow[],
  agentReviews: Map<string, ComplianceEvidenceAgentReview> = new Map(),
): ComplianceEvidenceItemWithMappings[] => {
  const byItemId = new Map<string, ComplianceEvidenceMappingRow[]>();
  for (const mapping of mappings) {
    const list = byItemId.get(mapping.evidenceItemId) ?? [];
    list.push(mapping);
    byItemId.set(mapping.evidenceItemId, list);
  }
  return items.map((item) => ({ ...item, mappings: byItemId.get(item.id) ?? [], agentReview: agentReviews.get(item.id) ?? null }));
};

const requiresDurableEvidenceFile = (sourceType: ComplianceEvidenceSourceType): boolean =>
  sourceType === 'user_upload' || sourceType === 'user_attestation' || sourceType === 'integration';

export const complianceEvidenceHasDurableFile = (artifact?: ComplianceEvidenceArtifact | null): boolean => {
  if (!artifact) return false;
  const size = typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : 0;
  return Boolean(
    artifact.fileName &&
      artifact.storageRef &&
      artifact.sha256 &&
      /^[a-f0-9]{64}$/i.test(artifact.sha256) &&
      size > 0,
  );
};

const normalizeCitationAnchors = (
  anchors: ComplianceEvidenceCitationAnchor[] | undefined,
): ComplianceEvidenceCitationAnchor[] =>
  (Array.isArray(anchors) ? anchors : [])
    .slice(0, 10)
    .map((anchor) => ({
      page: typeof anchor.page === 'number' && Number.isFinite(anchor.page) ? Math.max(1, Math.floor(anchor.page)) : null,
      section: typeof anchor.section === 'string' && anchor.section.trim() ? anchor.section.trim().slice(0, 240) : null,
      line: typeof anchor.line === 'number' && Number.isFinite(anchor.line) ? Math.max(1, Math.floor(anchor.line)) : null,
      chunkId: typeof anchor.chunkId === 'string' && anchor.chunkId.trim() ? anchor.chunkId.trim().slice(0, 160) : null,
      excerpt: typeof anchor.excerpt === 'string' && anchor.excerpt.trim() ? anchor.excerpt.trim().slice(0, 1000) : null,
      excerptSha256:
        typeof anchor.excerptSha256 === 'string' && /^[a-f0-9]{64}$/i.test(anchor.excerptSha256)
          ? anchor.excerptSha256.toLowerCase()
          : null,
    }))
    .filter((anchor) => Boolean(anchor.page || anchor.section || anchor.line || anchor.chunkId || anchor.excerpt || anchor.excerptSha256));

export class ComplianceEvidenceService {
  private readonly readinessService: ComplianceReadinessService;
  private readonly auditService: AuditService;
  private readonly log = logger.child({ scope: 'ComplianceEvidenceService' });

  constructor(private readonly db: DatabaseClient) {
    this.readinessService = new ComplianceReadinessService(db);
    this.auditService = new AuditService(db);
  }

  async listEvidenceItems(params: {
    organizationId: string;
    scopeId?: string | null;
    framework?: ComplianceFrameworkKey | null;
    status?: ComplianceEvidenceReviewStatus | null;
    sourceType?: ComplianceEvidenceSourceType | null;
    limit?: number;
  }): Promise<ComplianceEvidenceItemWithMappings[]> {
    const filters = [eq(complianceEvidenceItems.organizationId, params.organizationId)];
    if (params.scopeId !== undefined) {
      filters.push(params.scopeId ? eq(complianceEvidenceItems.scopeId, params.scopeId) : isNull(complianceEvidenceItems.scopeId));
    }
    if (params.status) {
      filters.push(eq(complianceEvidenceItems.status, params.status));
    }
    if (params.sourceType) {
      filters.push(eq(complianceEvidenceItems.sourceType, params.sourceType));
    }

    const items = await this.db
      .select()
      .from(complianceEvidenceItems)
      .where(and(...filters))
      .orderBy(desc(complianceEvidenceItems.createdAt))
      .limit(Math.min(Math.max(params.limit ?? 100, 1), 500));

    if (items.length === 0) return [];

    const itemIds = items.map((item) => item.id);
    const mappingFilters = [inArray(complianceEvidenceMappings.evidenceItemId, itemIds)];
    if (params.framework) {
      mappingFilters.push(eq(complianceEvidenceMappings.frameworkKey, params.framework));
    }
    const mappings = await this.db
      .select()
      .from(complianceEvidenceMappings)
      .where(and(...mappingFilters))
      .orderBy(desc(complianceEvidenceMappings.createdAt));

    const agentReviews = await this.loadAgentReviews(items, params.framework ?? null);

    return mapItemRows(items, mappings, agentReviews);
  }

  async getEvidenceItem(params: {
    organizationId: string;
    evidenceItemId: string;
  }): Promise<ComplianceEvidenceItemWithMappings | null> {
    const [item] = await this.db
      .select()
      .from(complianceEvidenceItems)
      .where(and(eq(complianceEvidenceItems.organizationId, params.organizationId), eq(complianceEvidenceItems.id, params.evidenceItemId)))
      .limit(1);
    if (!item) return null;

    const mappings = await this.db
      .select()
      .from(complianceEvidenceMappings)
      .where(eq(complianceEvidenceMappings.evidenceItemId, item.id));
    const agentReviews = await this.loadAgentReviews([item], null);
    return { ...item, mappings, agentReview: agentReviews.get(item.id) ?? null };
  }

  async deleteEvidenceItem(params: {
    organizationId: string;
    evidenceItemId: string;
  }): Promise<boolean> {
    const [deleted] = await this.db
      .delete(complianceEvidenceItems)
      .where(
        and(
          eq(complianceEvidenceItems.organizationId, params.organizationId),
          eq(complianceEvidenceItems.id, params.evidenceItemId),
        ),
      )
      .returning({ id: complianceEvidenceItems.id });
    // Mappings cascade via the evidence_item_id foreign key (onDelete cascade).
    return Boolean(deleted);
  }

  async updateEvidenceItem(input: ComplianceEvidenceUpdateInput): Promise<ComplianceEvidenceItemWithMappings> {
    this.validateMappings(input.mappings);

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(complianceEvidenceItems)
        .where(and(eq(complianceEvidenceItems.organizationId, input.organizationId), eq(complianceEvidenceItems.id, input.evidenceItemId)))
        .limit(1);
      if (!existing) {
        throw new Error('Compliance evidence item not found');
      }

      const now = new Date();
      const [updated] = await tx
        .update(complianceEvidenceItems)
        .set({
          title: input.title.trim(),
          description: input.description ?? null,
          evidenceType: input.evidenceType,
          owner: input.owner ?? null,
          observationStartedAt: input.observationStartedAt ?? null,
          observationEndedAt: input.observationEndedAt ?? null,
          validUntil: input.validUntil ?? null,
          status: 'unreviewed',
          reviewNote: null,
          updatedAt: now,
        })
        .where(and(eq(complianceEvidenceItems.organizationId, input.organizationId), eq(complianceEvidenceItems.id, input.evidenceItemId)))
        .returning();

      await tx
        .delete(complianceEvidenceMappings)
        .where(eq(complianceEvidenceMappings.evidenceItemId, input.evidenceItemId));

      const mappings = input.mappings.length > 0
        ? await tx
          .insert(complianceEvidenceMappings)
          .values(
            input.mappings.map((mapping) => ({
              evidenceItemId: input.evidenceItemId,
              organizationId: input.organizationId,
              scopeId: updated.scopeId,
              frameworkKey: mapping.frameworkKey,
              controlId: mapping.controlId.trim().toUpperCase(),
              mappingSource: mapping.mappingSource ?? 'user_declared',
              confidence: mapping.confidence ?? 'medium',
              rationale: mapping.rationale ?? null,
              citationAnchors: normalizeCitationAnchors(mapping.citationAnchors),
              createdBy: input.actorUserId ?? null,
            })),
          )
          .onConflictDoUpdate({
            target: [
              complianceEvidenceMappings.evidenceItemId,
              complianceEvidenceMappings.frameworkKey,
              complianceEvidenceMappings.controlId,
            ],
            set: {
              mappingSource: sql`excluded.mapping_source`,
              confidence: sql`excluded.confidence`,
              rationale: sql`excluded.rationale`,
              citationAnchors: sql`excluded.citation_anchors`,
              createdBy: input.actorUserId ?? null,
              createdAt: new Date(),
            },
          })
          .returning()
        : [];

      return { ...updated, mappings, agentReview: null };
    });
  }

  async createEvidenceItem(input: ComplianceEvidenceCreateInput): Promise<ComplianceEvidenceItemWithMappings> {
    await this.ensureScopeBelongsToOrg(input.organizationId, input.scopeId);
    this.validateMappings(input.mappings);
    const sourceType = input.sourceType ?? 'user_upload';
    this.assertDurableFileForEvidenceSource(sourceType, input.artifact);

    const [item] = await this.db
      .insert(complianceEvidenceItems)
      .values({
        organizationId: input.organizationId,
        scopeId: input.scopeId ?? null,
        title: input.title,
        description: input.description ?? null,
        sourceType,
        evidenceType: input.evidenceType ?? 'other',
        owner: input.owner ?? null,
        status: 'unreviewed',
        artifact: input.artifact ?? {},
        metadata: input.metadata ?? {},
        observationStartedAt: input.observationStartedAt ?? null,
        observationEndedAt: input.observationEndedAt ?? null,
        validUntil: input.validUntil ?? null,
        uploadedBy: input.uploadedBy ?? null,
      })
      .returning();

    const mappings = input.mappings.length > 0
      ? await this.db
        .insert(complianceEvidenceMappings)
        .values(
          input.mappings.map((mapping) => ({
            evidenceItemId: item.id,
            organizationId: input.organizationId,
            scopeId: input.scopeId ?? null,
            frameworkKey: mapping.frameworkKey,
            controlId: mapping.controlId.trim().toUpperCase(),
            mappingSource: mapping.mappingSource ?? 'user_declared',
            confidence: mapping.confidence ?? 'medium',
            rationale: mapping.rationale ?? null,
            citationAnchors: normalizeCitationAnchors(mapping.citationAnchors),
            createdBy: input.uploadedBy ?? null,
          })),
        )
        .returning()
      : [];

    return { ...item, mappings, agentReview: null };
  }

  async upsertEvidenceMappings(input: ComplianceEvidenceMappingUpsertInput): Promise<ComplianceEvidenceItemWithMappings> {
    if (input.mappings.length === 0) {
      throw new Error('At least one compliance evidence mapping is required');
    }
    this.validateMappings(input.mappings);
    const [item] = await this.db
      .select()
      .from(complianceEvidenceItems)
      .where(and(eq(complianceEvidenceItems.organizationId, input.organizationId), eq(complianceEvidenceItems.id, input.evidenceItemId)))
      .limit(1);
    if (!item) {
      throw new Error('Compliance evidence item not found');
    }
    const normalizedMappings = input.mappings.map((mapping) => ({
      ...mapping,
      controlId: mapping.controlId.trim().toUpperCase(),
      mappingSource: mapping.mappingSource ?? 'system_suggested',
      confidence: mapping.confidence ?? 'medium',
      citationAnchors: normalizeCitationAnchors(mapping.citationAnchors),
    }));

    if (normalizedMappings.length > 0) {
      await this.db
        .insert(complianceEvidenceMappings)
        .values(
          normalizedMappings.map((mapping) => ({
            evidenceItemId: item.id,
            organizationId: input.organizationId,
            scopeId: item.scopeId,
            frameworkKey: mapping.frameworkKey,
            controlId: mapping.controlId,
            mappingSource: mapping.mappingSource,
            confidence: mapping.confidence,
            rationale: mapping.rationale ?? null,
            citationAnchors: mapping.citationAnchors,
            createdBy: input.actorUserId ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [
            complianceEvidenceMappings.evidenceItemId,
            complianceEvidenceMappings.frameworkKey,
            complianceEvidenceMappings.controlId,
          ],
          set: {
            mappingSource: sql`excluded.mapping_source`,
            confidence: sql`excluded.confidence`,
            rationale: sql`excluded.rationale`,
            citationAnchors: sql`excluded.citation_anchors`,
            createdBy: input.actorUserId ?? null,
            createdAt: new Date(),
          },
        });

      await Promise.all(normalizedMappings.map((mapping) =>
        this.logMappingAudit({
          organizationId: input.organizationId,
          actorUserId: input.actorUserId ?? null,
          action: 'compliance.evidence_mapping.suggested',
          evidenceItemId: item.id,
          frameworkKey: mapping.frameworkKey,
          controlId: mapping.controlId,
          changes: {
            mappingSource: mapping.mappingSource,
            confidence: mapping.confidence,
            rationale: mapping.rationale ?? null,
            citationAnchors: mapping.citationAnchors,
          },
        }),
      ));
    }

    const mappings = await this.db
      .select()
      .from(complianceEvidenceMappings)
      .where(eq(complianceEvidenceMappings.evidenceItemId, item.id))
      .orderBy(desc(complianceEvidenceMappings.createdAt));
    const agentReviews = await this.loadAgentReviews([item], null);
    return { ...item, mappings, agentReview: agentReviews.get(item.id) ?? null };
  }

  /**
   * Agent-authored metadata enrichment. The agent describes what an uploaded file is, assigns its
   * type, and sets a freshness window so the same artifact can be reasoned about across frameworks.
   * Only provided fields change; mappings and review status are untouched (mappings use map_compliance_evidence).
   */
  async annotateEvidenceItem(input: ComplianceEvidenceAnnotateInput): Promise<ComplianceEvidenceItemWithMappings> {
    const [existing] = await this.db
      .select()
      .from(complianceEvidenceItems)
      .where(and(eq(complianceEvidenceItems.organizationId, input.organizationId), eq(complianceEvidenceItems.id, input.evidenceItemId)))
      .limit(1);
    if (!existing) {
      throw new Error('Compliance evidence item not found');
    }

    const updates: Partial<typeof complianceEvidenceItems.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined && input.title !== null && input.title.trim().length > 0) {
      updates.title = input.title.trim();
    }
    if (input.description !== undefined) updates.description = input.description;
    if (input.evidenceType !== undefined) updates.evidenceType = input.evidenceType;
    if (input.validUntil !== undefined) updates.validUntil = input.validUntil;

    const [updated] = await this.db
      .update(complianceEvidenceItems)
      .set(updates)
      .where(and(eq(complianceEvidenceItems.organizationId, input.organizationId), eq(complianceEvidenceItems.id, input.evidenceItemId)))
      .returning();

    const mappings = await this.db
      .select()
      .from(complianceEvidenceMappings)
      .where(eq(complianceEvidenceMappings.evidenceItemId, input.evidenceItemId));
    const agentReviews = await this.loadAgentReviews([updated], null);
    return { ...updated, mappings, agentReview: agentReviews.get(updated.id) ?? null };
  }

  async createAcceptedRisk(input: ComplianceAcceptedRiskCreateInput): Promise<ComplianceAcceptedRiskRow> {
    await this.ensureScopeBelongsToOrg(input.organizationId, input.scopeId);
    this.validateControl(input.frameworkKey, input.controlId);
    if (input.expiresAt.getTime() <= Date.now()) {
      throw new Error('Accepted risk expiry must be in the future');
    }
    if (input.evidenceItemId) {
      const [item] = await this.db
        .select()
        .from(complianceEvidenceItems)
        .where(and(eq(complianceEvidenceItems.organizationId, input.organizationId), eq(complianceEvidenceItems.id, input.evidenceItemId)))
        .limit(1);
      if (!item) throw new Error('Accepted risk evidence item not found');
    }

    const [row] = await this.db
      .insert(complianceAcceptedRisks)
      .values({
        organizationId: input.organizationId,
        scopeId: input.scopeId ?? null,
        frameworkKey: input.frameworkKey,
        controlId: input.controlId.trim().toUpperCase(),
        evidenceItemId: input.evidenceItemId ?? null,
        owner: input.owner,
        rationale: input.rationale,
        status: 'active',
        approvedBy: input.approvedBy ?? null,
        expiresAt: input.expiresAt,
      })
      .returning();
    return row;
  }

  async createEvidenceFromFinding(input: ComplianceFindingEvidenceCreateInput): Promise<ComplianceEvidenceItemWithMappings> {
    await this.ensureScopeBelongsToOrg(input.organizationId, input.scopeId);
    this.validateMappings(input.mappings);

    const [finding] = await this.db
      .select({
        id: findings.id,
        title: findings.title,
        scopeId: findings.scopeId,
        severity: findings.severity,
        state: findings.state,
        lastSeenAt: findings.lastSeenAt,
      })
      .from(findings)
      .where(and(eq(findings.organizationId, input.organizationId), eq(findings.id, input.findingId)))
      .limit(1);
    if (!finding) {
      throw new Error('Finding not found for organization');
    }
    if (input.scopeId && finding.scopeId !== input.scopeId) {
      throw new Error('Finding is not in the requested scope');
    }

    const [artifact] = await this.db
      .select({
        path: findingEvidence.path,
        displayPath: findingEvidence.displayPath,
        createdAt: findingEvidence.createdAt,
      })
      .from(findingEvidence)
      .where(eq(findingEvidence.findingId, finding.id))
      .orderBy(desc(findingEvidence.createdAt))
      .limit(1);

    return this.createEvidenceItem({
      organizationId: input.organizationId,
      scopeId: finding.scopeId,
      uploadedBy: input.uploadedBy ?? null,
      title: `Finding evidence: ${finding.title}`,
      sourceType: 'agent_finding',
      evidenceType: 'system_export',
      artifact: {
        sourceRef: artifact?.displayPath ?? artifact?.path ?? `finding:${finding.id}`,
      },
      metadata: {
        findingId: finding.id,
        severity: finding.severity,
        state: finding.state,
      },
      observationEndedAt: finding.lastSeenAt,
      mappings: input.mappings,
    });
  }

  async upsertIntegrationEvidenceItem(
    input: ComplianceIntegrationEvidenceUpsertInput,
  ): Promise<ComplianceIntegrationEvidenceUpsertResult> {
    await this.ensureScopeBelongsToOrg(input.organizationId, input.scopeId);
    this.validateMappings(input.mappings);
    this.assertDurableFileForEvidenceSource('integration', input.artifact);

    const [existing] = await this.db
      .select()
      .from(complianceEvidenceItems)
      .where(
        and(
          eq(complianceEvidenceItems.organizationId, input.organizationId),
          input.scopeId ? eq(complianceEvidenceItems.scopeId, input.scopeId) : isNull(complianceEvidenceItems.scopeId),
          eq(complianceEvidenceItems.sourceType, 'integration'),
          sql`${complianceEvidenceItems.metadata}->'integration'->>'provider' = ${input.provider}`,
          sql`${complianceEvidenceItems.metadata}->'integration'->>'sourceRecordId' = ${input.sourceRecordId}`,
        ),
      )
      .limit(1);

    const normalizedMappings = input.mappings.map((mapping) => ({
      ...mapping,
      controlId: mapping.controlId.trim().toUpperCase(),
      mappingSource: mapping.mappingSource ?? 'system_suggested',
      confidence: mapping.confidence ?? 'medium',
      citationAnchors: normalizeCitationAnchors(mapping.citationAnchors),
    }));

    if (!existing) {
      const evidence = await this.createEvidenceItem({
        organizationId: input.organizationId,
        scopeId: input.scopeId ?? null,
        title: input.title,
        description: input.description ?? null,
        sourceType: 'integration',
        evidenceType: input.evidenceType ?? 'system_export',
        owner: input.owner ?? input.provider,
        artifact: input.artifact,
        metadata: input.metadata ?? {},
        observationStartedAt: input.observationStartedAt ?? null,
        observationEndedAt: input.observationEndedAt ?? null,
        validUntil: input.validUntil ?? null,
        mappings: normalizedMappings,
      });
      return { evidence, created: true, updated: false, reviewReset: false };
    }

    const existingArtifact = existing.artifact as ComplianceEvidenceArtifact | null;
    const artifactChanged = existingArtifact?.sha256 !== input.artifact.sha256;
    const now = new Date();
    const nextStatus = artifactChanged ? 'unreviewed' : existing.status;

    const [updated] = await this.db
      .update(complianceEvidenceItems)
      .set({
        title: input.title,
        description: input.description ?? null,
        evidenceType: input.evidenceType ?? 'system_export',
        owner: input.owner ?? input.provider,
        status: nextStatus,
        artifact: input.artifact,
        metadata: input.metadata ?? {},
        observationStartedAt: input.observationStartedAt ?? null,
        observationEndedAt: input.observationEndedAt ?? null,
        validUntil: input.validUntil ?? null,
        reviewNote: artifactChanged ? null : existing.reviewNote,
        updatedAt: now,
      })
      .where(and(eq(complianceEvidenceItems.organizationId, input.organizationId), eq(complianceEvidenceItems.id, existing.id)))
      .returning();

    await this.db
      .delete(complianceEvidenceMappings)
      .where(eq(complianceEvidenceMappings.evidenceItemId, existing.id));
    const insertedMappings = normalizedMappings.length > 0
      ? await this.db
        .insert(complianceEvidenceMappings)
        .values(
          normalizedMappings.map((mapping) => ({
            evidenceItemId: existing.id,
            organizationId: input.organizationId,
            scopeId: input.scopeId ?? null,
            frameworkKey: mapping.frameworkKey,
            controlId: mapping.controlId,
            mappingSource: mapping.mappingSource,
            confidence: mapping.confidence,
            rationale: mapping.rationale ?? null,
            citationAnchors: normalizeCitationAnchors(mapping.citationAnchors),
            createdBy: null,
          })),
        )
        .returning()
      : [];

    return {
      evidence: { ...updated, mappings: insertedMappings, agentReview: null },
      created: false,
      updated: true,
      reviewReset: artifactChanged && existing.status !== 'unreviewed',
    };
  }

  async expireIntegrationEvidenceForProvider(params: {
    organizationId: string;
    provider: string;
    scopeId?: string | null;
    reason?: string | null;
  }): Promise<number> {
    const filters = [
      eq(complianceEvidenceItems.organizationId, params.organizationId),
      eq(complianceEvidenceItems.sourceType, 'integration'),
      sql`${complianceEvidenceItems.metadata}->'integration'->>'provider' = ${params.provider}`,
    ];
    if (params.scopeId) {
      filters.push(eq(complianceEvidenceItems.scopeId, params.scopeId));
    }
    const now = new Date();
    const rows = await this.db
      .update(complianceEvidenceItems)
      .set({
        status: 'expired',
        validUntil: now,
        reviewNote: params.reason ?? 'Latest integration sync failed; evidence was expired to avoid preserving readiness silently.',
        updatedAt: now,
      })
      .where(and(...filters))
      .returning({ id: complianceEvidenceItems.id });
    return rows.length;
  }

  async listMissingEvidence(params: {
    organizationId: string;
    scopeId?: string | null;
    framework?: ComplianceFrameworkKey | null;
  }): Promise<ComplianceMissingEvidenceItem[]> {
    const readiness = await this.readinessService.getScopeReadiness({
      organizationId: params.organizationId,
      scopeId: params.scopeId ?? null,
    });
    const evidenceItems = await this.listEvidenceItems({
      organizationId: params.organizationId,
      scopeId: params.scopeId ?? null,
      framework: params.framework ?? null,
      limit: 500,
    });

    const mappingCounts = new Map<string, { total: number; approved: number }>();
    for (const item of evidenceItems) {
      for (const mapping of item.mappings) {
        const key = `${mapping.frameworkKey}:${mapping.controlId}`;
        const counts = mappingCounts.get(key) ?? { total: 0, approved: 0 };
        counts.total += 1;
        if (item.agentReview?.status === 'reviewed') {
          counts.approved += 1;
        }
        mappingCounts.set(key, counts);
      }
    }

    return readiness.frameworks
      .filter((framework) => !params.framework || framework.key === params.framework)
      .flatMap((framework) =>
        framework.controls
          .filter((control) => control.supportLevel === 'manual_evidence_required' || control.supportLevel === 'integration_required')
          .filter((control) => !['passing', 'accepted_risk', 'not_applicable'].includes(control.status))
          .map((control) => {
            const key = `${framework.key}:${control.id}`;
            const counts = mappingCounts.get(key) ?? { total: 0, approved: 0 };
            return {
              frameworkKey: framework.key,
              frameworkLabel: framework.label,
              controlId: control.id,
              title: control.title,
              theme: control.theme,
              supportLevel: control.supportLevel,
              status: control.status,
              score: control.score,
              gap: control.gaps[0] ?? control.rationale,
              mappedEvidenceCount: counts.total,
              approvedEvidenceCount: counts.approved,
              acceptedRiskCount: control.status === 'accepted_risk' ? 1 : 0,
            };
          }),
      );
  }

  private validateMappings(mappings: ComplianceEvidenceMappingInput[]): void {
    for (const mapping of mappings) {
      this.validateControl(mapping.frameworkKey, mapping.controlId);
    }
  }

  private async logMappingAudit(params: {
    organizationId: string;
    actorUserId?: string | null;
    action: string;
    evidenceItemId: string;
    frameworkKey: string;
    controlId: string;
    changes: Record<string, unknown>;
  }): Promise<void> {
    if (!params.actorUserId) return;
    try {
      await this.auditService.log({
        organizationId: params.organizationId,
        actorId: params.actorUserId,
        actorType: 'user',
        action: params.action,
        resourceType: 'compliance_evidence_mapping',
        resourceId: `${params.frameworkKey}:${params.controlId}:${params.evidenceItemId}`,
        changes: params.changes,
      });
    } catch (error) {
      this.log.warn({ err: error, evidenceItemId: params.evidenceItemId }, 'Failed to write compliance evidence mapping audit log');
    }
  }

  private async loadAgentReviews(
    items: ComplianceEvidenceItemRow[],
    framework?: ComplianceFrameworkKey | null,
  ): Promise<Map<string, ComplianceEvidenceAgentReview>> {
    if (items.length === 0) return new Map();
    const refs = items.map((item) => `compliance-evidence:${item.id}`);
    const refSql = sql.join(refs.map((ref) => sql`${ref}`), sql`, `);
    const filters = [
      eq(complianceControlChecks.organizationId, items[0]!.organizationId),
      inArray(complianceControlChecks.basis, ['agent_reviewed_user_evidence', 'agent_reviewed_integration']),
      sql`${complianceControlChecks.evidenceRefs} && ARRAY[${refSql}]::text[]`,
    ];
    if (framework) {
      filters.push(eq(complianceControlChecks.frameworkKey, framework));
    }

    const rows = await this.db
      .select({
        id: complianceControlChecks.id,
        frameworkKey: complianceControlChecks.frameworkKey,
        controlId: complianceControlChecks.controlId,
        verdict: complianceControlChecks.verdict,
        reason: complianceControlChecks.reason,
        evidenceRefs: complianceControlChecks.evidenceRefs,
        createdAt: complianceControlChecks.createdAt,
      })
      .from(complianceControlChecks)
      .where(and(...filters))
      .orderBy(desc(complianceControlChecks.createdAt))
      .limit(500);

    const byEvidenceId = new Map<string, ComplianceEvidenceAgentReview>();
    const itemIds = new Set(items.map((item) => item.id));
    for (const row of rows) {
      for (const ref of row.evidenceRefs) {
        const evidenceId = ref.toLowerCase().startsWith('compliance-evidence:')
          ? ref.slice('compliance-evidence:'.length)
          : ref;
        if (!itemIds.has(evidenceId) || byEvidenceId.has(evidenceId) || !isComplianceFrameworkKey(row.frameworkKey)) {
          continue;
        }
        byEvidenceId.set(evidenceId, {
          status: row.verdict === 'needs_context' || row.verdict === 'not_attempted' ? 'needs_more_evidence' : 'reviewed',
          checkId: row.id,
          frameworkKey: row.frameworkKey,
          controlId: row.controlId,
          verdict: row.verdict,
          reviewedAt: row.createdAt,
          reason: row.reason,
        });
      }
    }
    return byEvidenceId;
  }

  private validateControl(frameworkKey: ComplianceFrameworkKey, controlId: string): void {
    const framework = FRAMEWORK_REGISTRY[frameworkKey];
    if (!framework) throw new Error(`Unsupported compliance framework: ${frameworkKey}`);
    const normalizedControlId = controlId.trim().toUpperCase();
    if (!framework.controls.some((control) => control.id.toUpperCase() === normalizedControlId)) {
      throw new Error(`Control ${controlId} is not defined for ${framework.label}`);
    }
  }

  private assertDurableFileForEvidenceSource(
    sourceType: ComplianceEvidenceSourceType,
    artifact?: ComplianceEvidenceArtifact | null,
  ): void {
    if (requiresDurableEvidenceFile(sourceType) && !complianceEvidenceHasDurableFile(artifact)) {
      throw new Error('User-submitted or integration compliance evidence requires an uploaded file with stored SHA-256, filename, and size');
    }
  }

  private async ensureScopeBelongsToOrg(organizationId: string, scopeId?: string | null): Promise<void> {
    if (!scopeId) return;
    const [scope] = await this.db
      .select({ id: scopes.id })
      .from(scopes)
      .where(and(eq(scopes.organizationId, organizationId), eq(scopes.id, scopeId)))
      .limit(1);
    if (!scope) {
      throw new Error('Scope not found for organization');
    }
  }
}
