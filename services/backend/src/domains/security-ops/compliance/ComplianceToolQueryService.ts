import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import {
  agentArtifacts,
  complianceEvidenceItems,
  type RiskState,
} from '@/db/schema';
import {
  extractComplianceEvidenceText,
  parseComplianceEvidenceArtifact,
  readComplianceEvidenceArtifact,
} from '@/domains/security-ops/compliance/ComplianceEvidenceFileResolver';
import {
  ComplianceReadinessService,
  type ComplianceReadinessResponse,
  type ComplianceReadinessStatus,
} from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { ComplianceEvidenceService } from '@/domains/security-ops/compliance/ComplianceEvidenceService';
import {
  COMPLIANCE_FRAMEWORK_KEYS,
  type ComplianceFrameworkKey,
} from '@/domains/security-ops/compliance/frameworks';
import {
  COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
  GDPR_READINESS_BOUNDARY_SENTENCE,
} from '@/domains/security-ops/tools/reporting/constants';

const ComplianceFrameworkKeySchema = z.enum(
  [...COMPLIANCE_FRAMEWORK_KEYS] as [ComplianceFrameworkKey, ...ComplianceFrameworkKey[]],
);
const ComplianceReadinessStatusSchema = z.enum([
  'missing',
  'partial',
  'passing',
  'failing',
  'stale',
  'accepted_risk',
  'not_applicable',
  'not_supported',
]);
const ComplianceEvidenceStatusSchema = z.enum([
  'unreviewed',
  'expired',
]);
const ComplianceEvidenceSourceTypeSchema = z.enum([
  'user_upload',
  'user_attestation',
  'agent_finding',
  'integration',
]);
const ComplianceEvidenceSupportLevelSchema = z.enum([
  'automated_testable',
  'manual_evidence_required',
  'integration_required',
  'out_of_selected_scope',
]);

export const QueryComplianceReadinessSchema = z.object({
  framework: ComplianceFrameworkKeySchema.optional(),
  controlId: z.string().min(1).optional(),
  status: ComplianceReadinessStatusSchema.optional(),
  supportLevel: ComplianceEvidenceSupportLevelSchema.optional(),
  includeEvidence: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(200).optional().default(100),
});

export const QueryComplianceEvidenceSchema = z.object({
  framework: ComplianceFrameworkKeySchema.optional(),
  controlId: z.string().min(1).optional(),
  status: ComplianceEvidenceStatusSchema.optional(),
  sourceType: ComplianceEvidenceSourceTypeSchema.optional(),
  includeMetadata: z.boolean().optional().default(false),
  includeContent: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export const QueryComplianceProofPackageSchema = z.object({
  framework: ComplianceFrameworkKeySchema,
  controlId: z.string().min(1).max(128),
  maxChecks: z.number().int().min(1).max(25).optional().default(10),
});

export const QueryComplianceMissingEvidenceSchema = z.object({
  framework: ComplianceFrameworkKeySchema.optional(),
  supportLevel: ComplianceEvidenceSupportLevelSchema.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export type QueryComplianceReadinessResult = {
  generatedAt: string;
  organizationId: string;
  scopeId: string | null;
  boundary: string;
  frameworkBoundaries: Partial<Record<ComplianceFrameworkKey, string>>;
  selectedFrameworks: ComplianceReadinessResponse['selectedFrameworks'];
  supportedFrameworks: ComplianceReadinessResponse['supportedFrameworks'];
  latestCompletedRunId: string | null;
  reportRequest: ComplianceReadinessResponse['reportRequest'];
  scorecards: ComplianceReadinessResponse['scorecards'];
  frameworks: Array<{
    key: ComplianceFrameworkKey;
    label: string;
    selected: boolean;
    supported: boolean;
    score: number;
    statusCounts: Record<ComplianceReadinessStatus, number>;
    outcomeCounts: ComplianceReadinessResponse['frameworks'][number]['outcomeCounts'];
    verdictCounts: ComplianceReadinessResponse['frameworks'][number]['verdictCounts'];
    gaps: string[];
    coverageLimitations: string[];
    totalControls: number;
    returnedControls: number;
    controls: Array<{
      id: string;
      title: string;
      theme: string;
      supportLevel: string;
      implementationSpec: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['implementationSpec'];
      pciDssRequirement: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssRequirement'];
      pciDssGoal: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssGoal'];
      pciDssApproach: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssApproach'];
      pciDssSaqTypes: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssSaqTypes'];
      pciDssCdeScope: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssCdeScope'];
      pciDssAccountData: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssAccountData'];
      status: ComplianceReadinessStatus;
      verdict: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['verdict'];
      outcome: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['outcome'];
      reasonCode: string;
      verdictReason: string;
      score: number;
      rationale: string;
      gaps: string[];
      coverageLimitations: string[];
      evidenceCount: number;
      catalogRef: string;
      proofObligation: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['proofObligation'];
      requiredEvidence: string[];
      nextAction: string;
      evidenceFreshness: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['evidenceFreshness'];
      controlChecks: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['controlChecks'];
      actionRequests: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['actionRequests'];
      evidence?: Array<{
        id: string;
        kind: string;
        title: string;
        source: string;
        sourceRef: string;
        lastSeenAt: string | null;
        findingId?: string;
        severity?: string | null;
        state?: RiskState | null;
        negative?: boolean;
        mappingSource?: string;
        mappingConfidence?: string;
        quality: Record<string, unknown>;
      }>;
    }>;
  }>;
};

export type QueryComplianceEvidenceResult = {
  evidence: Array<Record<string, unknown>>;
  totalCount: number;
};

export type QueryComplianceProofPackageResult = {
  generatedAt: string;
  organizationId: string;
  scopeId: string | null;
  boundary: string;
  frameworkBoundaries: Partial<Record<ComplianceFrameworkKey, string>>;
  framework: {
    key: ComplianceFrameworkKey;
    label: string;
    selected: boolean;
  };
  control: {
    id: string;
    title: string;
    theme: string;
    implementationSpec: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['implementationSpec'];
    pciDssRequirement: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssRequirement'];
    pciDssGoal: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssGoal'];
    pciDssApproach: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssApproach'];
    pciDssSaqTypes: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssSaqTypes'];
    pciDssCdeScope: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssCdeScope'];
    pciDssAccountData: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['pciDssAccountData'];
    verdict: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['verdict'];
    outcome: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['outcome'];
    basis: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['basis'];
    reasonCode: string;
    verdictReason: string;
    proofObligation: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['proofObligation'];
    limitations: string[];
    nextAction: string;
    actionRequests: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['actionRequests'];
  };
  checks: Array<{
    id: string;
    basis: string;
    verdict: string;
    reason: string;
    proofObligationId: string;
    method: string;
    targetRef: string;
    limitations: string[];
    freshUntil: string;
    createdAt: string;
    evidenceRefs: string[];
    artifactIds: string[];
    proof: ComplianceReadinessResponse['frameworks'][number]['controls'][number]['controlChecks'][number]['proof'];
    artifacts: Array<{
      id: string;
      filePath: string;
      originalName: string;
      fileType: string | null;
      sizeBytes: number;
      createdAt: string;
      sha256: string | null;
      integrity: 'computed' | 'path_prefix' | 'not_available';
    }>;
    userEvidence: Array<{
      id: string;
      title: string;
      sourceType: string;
      evidenceType: string;
      status: string;
      artifact: {
        fileName: string | null;
        mimeType: string | null;
        sizeBytes: number | null;
        sha256: string | null;
        sourceRef: string | null;
        hasFile: boolean;
      };
    }>;
  }>;
};

export type QueryComplianceMissingEvidenceResult = {
  missing: Array<Record<string, unknown>>;
  totalCount: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toIsoString = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/iu;
const COMPLIANCE_EVIDENCE_REF_PREFIX = 'compliance-evidence:';

const defaultArtifactStorageRoot = (): string =>
  path.resolve(process.cwd(), process.env.WORKSPACE_ARTIFACTS_ROOT ?? 'storage/artifacts');

const parseComplianceEvidenceId = (value: string): string | null => {
  const trimmed = value.trim();
  const candidate = trimmed.toLowerCase().startsWith(COMPLIANCE_EVIDENCE_REF_PREFIX)
    ? trimmed.slice(COMPLIANCE_EVIDENCE_REF_PREFIX.length).trim()
    : trimmed;
  return UUID_PATTERN.test(candidate) ? candidate : null;
};

const sha256ForStoredArtifact = async (filePath: string): Promise<{ sha256: string | null; integrity: 'computed' | 'path_prefix' | 'not_available' }> => {
  const root = defaultArtifactStorageRoot();
  const absolutePath = path.resolve(root, filePath);
  const relative = path.relative(root, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    const content = await fs.readFile(absolutePath).catch(() => null);
    if (content) {
      return { sha256: createHash('sha256').update(content).digest('hex'), integrity: 'computed' };
    }
  }
  const match = path.basename(filePath).match(/^([a-f0-9]{16})-/iu);
  if (match?.[1]) {
    return { sha256: match[1], integrity: 'path_prefix' };
  }
  return { sha256: null, integrity: 'not_available' };
};

const emptyOutcomeCounts = (): ComplianceReadinessResponse['scorecards']['outcomes'] => ({
  passed: 0,
  failed: 0,
  needs_action: 0,
  not_checked: 0,
  excluded: 0,
});

const scorecardsForFrameworks = (
  frameworks: ComplianceReadinessResponse['frameworks'],
): ComplianceReadinessResponse['scorecards'] => {
  const controls = frameworks.flatMap((framework) => framework.controls);
  const monitoredControls = controls.filter((control) => !control.monitoring || control.monitoring.state === 'monitored');
  const technicalControls = monitoredControls.filter((control) => control.supportLevel === 'automated_testable');
  const customerControls = monitoredControls.filter(
    (control) => control.supportLevel === 'manual_evidence_required' || control.supportLevel === 'integration_required',
  );
  const outcomes = emptyOutcomeCounts();
  for (const control of controls) {
    if (control.outcome && Object.prototype.hasOwnProperty.call(outcomes, control.outcome)) {
      outcomes[control.outcome] += 1;
    }
  }

  return {
    agentProvenTechnical: {
      total: technicalControls.length,
      passed: technicalControls.filter((control) => control.verdict === 'pass').length,
      failed: technicalControls.filter((control) => control.verdict === 'fail').length,
      needsContext: technicalControls.filter((control) => control.verdict === 'needs_context').length,
      notAttempted: technicalControls.filter((control) => control.verdict === 'not_attempted').length,
      stale: technicalControls.filter((control) => control.status === 'stale').length,
    },
    customerEvidence: {
      total: customerControls.length,
      approved: customerControls.filter((control) => control.verdict === 'pass').length,
      missing: customerControls.filter(
        (control) => control.verdict === 'needs_evidence' || control.verdict === 'not_attempted',
      ).length,
      stale: customerControls.filter((control) => control.status === 'stale').length,
      integrationRequired: customerControls.filter(
        (control) => control.supportLevel === 'integration_required' && control.verdict !== 'pass',
      ).length,
      acceptedRisk: customerControls.filter((control) => control.verdict === 'accepted_risk').length,
    },
    outcomes,
  };
};

export class ComplianceToolQueryService {
  constructor(private readonly db: DatabaseClient) {}

  private resolveFrameworkForActiveRun(params: {
    requestedFramework?: ComplianceFrameworkKey;
    activeFrameworkKey?: ComplianceFrameworkKey;
    toolName: string;
  }): ComplianceFrameworkKey | undefined {
    if (!params.activeFrameworkKey) {
      return params.requestedFramework;
    }
    if (params.requestedFramework && params.requestedFramework !== params.activeFrameworkKey) {
      throw new Error(
        `${params.toolName} is scoped to ${params.activeFrameworkKey} for this compliance run; ` +
          `requested ${params.requestedFramework} is outside the active framework`,
      );
    }
    return params.activeFrameworkKey;
  }

  async queryComplianceReadiness(params: {
    organizationId: string;
    scopeId?: string | null;
    activeFrameworkKey?: ComplianceFrameworkKey;
    input: unknown;
  }): Promise<QueryComplianceReadinessResult> {
    const parsed = QueryComplianceReadinessSchema.parse(params.input);
    const frameworkFilter = this.resolveFrameworkForActiveRun({
      requestedFramework: parsed.framework,
      activeFrameworkKey: params.activeFrameworkKey,
      toolName: 'query_compliance_readiness',
    });
    const readiness = await new ComplianceReadinessService(this.db).getScopeReadiness({
      organizationId: params.organizationId,
      scopeId: params.scopeId ?? null,
    });

    const scopedReadinessFrameworks = readiness.frameworks
      .filter((framework) => !frameworkFilter || framework.key === frameworkFilter);
    const frameworks = scopedReadinessFrameworks
      .map((framework) => {
        const filteredControls = framework.controls
          .filter((control) => !parsed.controlId || control.id === parsed.controlId)
          .filter((control) => !parsed.status || control.status === parsed.status)
          .filter((control) => !parsed.supportLevel || control.supportLevel === parsed.supportLevel);
        const controls = filteredControls.slice(0, parsed.limit).map((control) => ({
          id: control.id,
          title: control.title,
          theme: control.theme,
          supportLevel: control.supportLevel,
          implementationSpec: control.implementationSpec,
          pciDssRequirement: control.pciDssRequirement,
          pciDssGoal: control.pciDssGoal,
          pciDssApproach: control.pciDssApproach,
          pciDssSaqTypes: control.pciDssSaqTypes,
          pciDssCdeScope: control.pciDssCdeScope,
          pciDssAccountData: control.pciDssAccountData,
          status: control.status,
          verdict: control.verdict,
          outcome: control.outcome,
          reasonCode: control.reasonCode,
          verdictReason: control.verdictReason,
          score: control.score,
          rationale: control.rationale,
          gaps: control.gaps,
          coverageLimitations: control.coverageLimitations,
          evidenceCount: control.evidence.length,
          catalogRef: control.catalogRef,
          proofObligation: control.proofObligation,
          requiredEvidence: control.requiredEvidence,
          nextAction: control.nextAction,
          evidenceFreshness: control.evidenceFreshness,
          controlChecks: control.controlChecks,
          actionRequests: control.actionRequests ?? [],
          ...(parsed.includeEvidence
            ? {
                evidence: control.evidence.slice(0, 10).map((evidence) => ({
                  id: evidence.id,
                  kind: evidence.kind,
                  title: evidence.title,
                  source: evidence.source,
                  sourceRef: evidence.sourceRef,
                  lastSeenAt: evidence.lastSeenAt,
                  ...(evidence.findingId ? { findingId: evidence.findingId } : {}),
                  ...(evidence.severity !== undefined ? { severity: evidence.severity } : {}),
                  ...(evidence.state !== undefined ? { state: evidence.state } : {}),
                  ...(evidence.negative !== undefined ? { negative: evidence.negative } : {}),
                  ...(evidence.mappingSource ? { mappingSource: evidence.mappingSource } : {}),
                  ...(evidence.mappingConfidence ? { mappingConfidence: evidence.mappingConfidence } : {}),
                  ...(evidence.controlCheckVerdict ? { controlCheckVerdict: evidence.controlCheckVerdict } : {}),
                  quality: evidence.quality as unknown as Record<string, unknown>,
                })),
              }
            : {}),
        }));

        return {
          key: framework.key,
          label: framework.label,
          selected: framework.selected,
          supported: framework.supported,
          score: framework.score,
          statusCounts: framework.statusCounts,
          outcomeCounts: framework.outcomeCounts,
          verdictCounts: framework.verdictCounts,
          gaps: framework.gaps,
          coverageLimitations: framework.coverageLimitations,
          totalControls: filteredControls.length,
          returnedControls: controls.length,
          controls,
        };
      });

    return {
      generatedAt: readiness.generatedAt,
      organizationId: readiness.organizationId,
      scopeId: readiness.scopeId,
      boundary: COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
      frameworkBoundaries: frameworkFilter === 'gdpr' || scopedReadinessFrameworks.some((framework) => framework.key === 'gdpr')
        ? { gdpr: GDPR_READINESS_BOUNDARY_SENTENCE }
        : {},
      selectedFrameworks: frameworkFilter
        ? readiness.selectedFrameworks.filter((framework) => framework.key === frameworkFilter)
        : readiness.selectedFrameworks,
      supportedFrameworks: frameworkFilter
        ? readiness.supportedFrameworks.filter((framework) => framework === frameworkFilter)
        : readiness.supportedFrameworks,
      latestCompletedRunId: readiness.latestCompletedRunId,
      reportRequest: readiness.reportRequest,
      scorecards: frameworkFilter ? scorecardsForFrameworks(scopedReadinessFrameworks) : readiness.scorecards,
      frameworks,
    };
  }

  async queryComplianceEvidence(params: {
    organizationId: string;
    scopeId?: string | null;
    activeFrameworkKey?: ComplianceFrameworkKey;
    input: unknown;
  }): Promise<QueryComplianceEvidenceResult> {
    const parsed = QueryComplianceEvidenceSchema.parse(params.input);
    const frameworkFilter = this.resolveFrameworkForActiveRun({
      requestedFramework: parsed.framework,
      activeFrameworkKey: params.activeFrameworkKey,
      toolName: 'query_compliance_evidence',
    });
    const evidenceItems = await new ComplianceEvidenceService(this.db).listEvidenceItems({
      organizationId: params.organizationId,
      scopeId: params.scopeId ?? null,
      framework: frameworkFilter ?? null,
      status: parsed.status ?? null,
      sourceType: parsed.sourceType ?? null,
      limit: parsed.limit,
    });

    const filtered = evidenceItems
      .map((item) => {
        const mappings = item.mappings.filter((mapping) =>
          (!frameworkFilter || mapping.frameworkKey === frameworkFilter) &&
          (!parsed.controlId || mapping.controlId === parsed.controlId),
        );
        return { item, mappings };
      })
      .filter(({ mappings }) => !parsed.controlId || mappings.length > 0);

    const evidence = await Promise.all(filtered.map(async ({ item, mappings }) => {
      const artifact = parseComplianceEvidenceArtifact(item.artifact);
      const contentResult = parsed.includeContent
        ? await readComplianceEvidenceArtifact(item.artifact)
        : null;
      const extractedText = contentResult
        ? extractComplianceEvidenceText(contentResult, { requested: true })
        : extractComplianceEvidenceText(
            { status: 'not_available', artifact, warning: 'content was not requested' },
            { requested: false },
          );
      const metadata = isRecord(item.metadata) ? item.metadata : {};
      return {
        id: item.id,
        scopeId: item.scopeId,
        title: item.title,
        description: item.description,
        sourceType: item.sourceType,
        evidenceType: item.evidenceType,
        status: item.status,
        owner: item.owner,
        reviewNote: item.reviewNote,
        uploadedBy: item.uploadedBy,
        observationStartedAt: toIsoString(item.observationStartedAt) ?? null,
        observationEndedAt: toIsoString(item.observationEndedAt) ?? null,
        validUntil: toIsoString(item.validUntil) ?? null,
        createdAt: toIsoString(item.createdAt) ?? null,
        updatedAt: toIsoString(item.updatedAt) ?? null,
        artifact: {
          fileName: artifact.fileName,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          sourceRef: artifact.sourceRef,
          hasFile: Boolean(
            artifact.fileName &&
              artifact.sha256 &&
              artifact.storageRef &&
              artifact.sizeBytes &&
              artifact.sizeBytes > 0,
          ),
          ...(parsed.includeContent
            ? {
                content: {
                  extractionStatus: extractedText.extractionStatus,
                  textPreview: extractedText.textPreview,
                  textTruncated: extractedText.textTruncated,
                  textRedacted: extractedText.textRedacted,
                  integrityStatus: contentResult?.status ?? 'not_available',
                  warning: contentResult && contentResult.status !== 'resolved' ? contentResult.warning : null,
                },
              }
            : {}),
        },
        mappings: mappings.map((mapping) => ({
          id: mapping.id,
          frameworkKey: mapping.frameworkKey,
          controlId: mapping.controlId,
          mappingSource: mapping.mappingSource,
          confidence: mapping.confidence,
          rationale: mapping.rationale,
          citationAnchors: mapping.citationAnchors ?? [],
        })),
        ...(parsed.includeMetadata ? { metadata } : {}),
      };
    }));

    return { evidence, totalCount: evidence.length };
  }

  async queryComplianceProofPackage(params: {
    organizationId: string;
    scopeId?: string | null;
    activeFrameworkKey?: ComplianceFrameworkKey;
    input: unknown;
  }): Promise<QueryComplianceProofPackageResult> {
    const parsed = QueryComplianceProofPackageSchema.parse(params.input);
    this.resolveFrameworkForActiveRun({
      requestedFramework: parsed.framework,
      activeFrameworkKey: params.activeFrameworkKey,
      toolName: 'query_compliance_proof_package',
    });
    const readiness = await new ComplianceReadinessService(this.db).getScopeReadiness({
      organizationId: params.organizationId,
      scopeId: params.scopeId ?? null,
    });
    const framework = readiness.frameworks.find((item) => item.key === parsed.framework);
    if (!framework) {
      throw new Error(`Compliance framework ${parsed.framework} is not available for this scope`);
    }
    const control = framework.controls.find((item) =>
      item.id.trim().toUpperCase() === parsed.controlId.trim().toUpperCase(),
    );
    if (!control) {
      throw new Error(`Compliance control ${parsed.framework}/${parsed.controlId} was not found`);
    }

    const checks = control.controlChecks.slice(0, parsed.maxChecks);
    const artifactIds = Array.from(new Set(checks.flatMap((check) => check.artifactIds)));
    const evidenceIds = Array.from(new Set(checks
      .flatMap((check) => [...check.evidenceRefs, ...check.proof.evidenceIds])
      .map(parseComplianceEvidenceId)
      .filter((id): id is string => Boolean(id))));

    const artifactRows = artifactIds.length > 0
      ? await this.db.select().from(agentArtifacts).where(inArray(agentArtifacts.id, artifactIds))
      : [];
    const artifactsById = new Map(artifactRows.map((row) => [row.id, row]));

    const evidenceRows = evidenceIds.length > 0
      ? await this.db.select().from(complianceEvidenceItems).where(inArray(complianceEvidenceItems.id, evidenceIds))
      : [];
    const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));

    const checksWithProof = await Promise.all(checks.map(async (check) => {
      const artifacts = await Promise.all(check.artifactIds.map(async (artifactId) => {
        const row = artifactsById.get(artifactId);
        if (!row) return null;
        const hash = await sha256ForStoredArtifact(row.filePath);
        return {
          id: row.id,
          filePath: row.filePath,
          originalName: row.originalName,
          fileType: row.fileType,
          sizeBytes: row.sizeBytes,
          createdAt: row.createdAt.toISOString(),
          sha256: hash.sha256,
          integrity: hash.integrity,
        };
      }));
      const userEvidence = Array.from(new Set([...check.evidenceRefs, ...check.proof.evidenceIds]))
        .map(parseComplianceEvidenceId)
        .filter((id): id is string => Boolean(id))
        .map((id) => evidenceById.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .map((row) => {
          const artifact = isRecord(row.artifact) ? row.artifact : {};
          const fileName = typeof artifact.fileName === 'string' ? artifact.fileName : null;
          const sha256 = typeof artifact.sha256 === 'string' ? artifact.sha256 : null;
          const storageRef = typeof artifact.storageRef === 'string' ? artifact.storageRef : null;
          const sizeBytes = typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : null;
          return {
            id: row.id,
            title: row.title,
            sourceType: row.sourceType,
            evidenceType: row.evidenceType,
            status: row.status,
            artifact: {
              fileName,
              mimeType: typeof artifact.mimeType === 'string' ? artifact.mimeType : null,
              sizeBytes,
              sha256,
              sourceRef: typeof artifact.sourceRef === 'string' ? artifact.sourceRef : null,
              hasFile: Boolean(fileName && sha256 && storageRef && sizeBytes && sizeBytes > 0),
            },
          };
        });
      return {
        id: check.id,
        basis: check.basis,
        verdict: check.verdict,
        reason: check.reason,
        proofObligationId: check.proofObligationId,
        method: check.method,
        targetRef: check.targetRef,
        limitations: check.limitations,
        freshUntil: check.freshUntil,
        createdAt: check.createdAt,
        evidenceRefs: check.evidenceRefs,
        artifactIds: check.artifactIds,
        proof: check.proof,
        artifacts: artifacts.filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact)),
        userEvidence,
      };
    }));

    return {
      generatedAt: readiness.generatedAt,
      organizationId: readiness.organizationId,
      scopeId: readiness.scopeId,
      boundary: COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
      frameworkBoundaries: framework.key === 'gdpr' ? { gdpr: GDPR_READINESS_BOUNDARY_SENTENCE } : {},
      framework: {
        key: framework.key,
        label: framework.label,
        selected: framework.selected,
      },
      control: {
        id: control.id,
        title: control.title,
        theme: control.theme,
        implementationSpec: control.implementationSpec,
        pciDssRequirement: control.pciDssRequirement,
        pciDssGoal: control.pciDssGoal,
        pciDssApproach: control.pciDssApproach,
        pciDssSaqTypes: control.pciDssSaqTypes,
        pciDssCdeScope: control.pciDssCdeScope,
        pciDssAccountData: control.pciDssAccountData,
        verdict: control.verdict,
        outcome: control.outcome,
        basis: control.basis,
        reasonCode: control.reasonCode,
        verdictReason: control.verdictReason,
        proofObligation: control.proofObligation,
        limitations: control.coverageLimitations,
        nextAction: control.nextAction,
        actionRequests: control.actionRequests,
      },
      checks: checksWithProof,
    };
  }

  async queryComplianceMissingEvidence(params: {
    organizationId: string;
    scopeId?: string | null;
    activeFrameworkKey?: ComplianceFrameworkKey;
    input: unknown;
  }): Promise<QueryComplianceMissingEvidenceResult> {
    const parsed = QueryComplianceMissingEvidenceSchema.parse(params.input);
    const frameworkFilter = this.resolveFrameworkForActiveRun({
      requestedFramework: parsed.framework,
      activeFrameworkKey: params.activeFrameworkKey,
      toolName: 'query_compliance_missing_evidence',
    });
    const missing = await new ComplianceEvidenceService(this.db).listMissingEvidence({
      organizationId: params.organizationId,
      scopeId: params.scopeId ?? null,
      framework: frameworkFilter ?? null,
    });
    const filtered = missing
      .filter((item) => !parsed.supportLevel || item.supportLevel === parsed.supportLevel)
      .slice(0, parsed.limit)
      .map((item) => ({ ...item }));

    return { missing: filtered, totalCount: filtered.length };
  }
}
