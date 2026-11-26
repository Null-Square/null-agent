import { and, desc, eq, inArray } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  assets,
  findingEvidence,
  findings,
  inventoryNotes,
  inventoryServices,
  organizations,
  runValidationQueue,
  runs,
  scannerObservations,
  scopeAccessMaterials,
  scopeTestPersonas,
  scopes,
  scopeTargets,
} from '@/db/schema';
import { confirmedAssetClause } from '@/domains/security-ops/assets/assetConfirmation';
import { ComplianceEvidenceService } from '@/domains/security-ops/compliance/ComplianceEvidenceService';
import {
  ComplianceReadinessService,
  type ComplianceReadinessControl,
  type ComplianceReadinessResponse,
} from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { FRAMEWORK_REGISTRY, type ComplianceFrameworkKey } from '@/domains/security-ops/compliance/frameworks';
import { SkillLoader } from '@/domains/security-ops/skills/SkillLoader';
import { isReportableRiskState } from '@/domains/security-ops/risks/riskLifecycle';
import {
  assertProjectionOwnedPath,
  buildEndpointSurfaceGraph,
  buildScanDigest,
  compareLeadsByPriority,
  deriveCoverageProjectionDetail,
  expandScopes,
  firstString,
  getString,
  isRecord,
  makeEnvelope,
  normalizeProjectedEndpoint,
  normalizeSkillSlugs,
  redactSensitiveText,
  scoreValidationLeadPriority,
  toIso,
  truncate,
  WORKSPACE_DIRS,
} from './WorkspaceProjectionHelpers';
import { WorkspaceProjectionRenderer } from './WorkspaceProjectionRenderer';
import type {
  ContextProjection,
  CoverageProjection,
  ComplianceProjection,
  EvidenceProjection,
  FindingsProjection,
  LeadsProjection,
  ProjectRunWorkspaceInput,
  ProjectionResult,
  ReconProjection,
  SkillIndexEntry,
} from './WorkspaceProjectionTypes';

export type {
  LeadPriorityScore,
  ProjectRunWorkspaceInput,
  ProjectionResult,
  ProjectionScope,
} from './WorkspaceProjectionTypes';
export {
  buildEndpointSurfaceGraph,
  buildScanDigest,
  deriveCoverageProjectionDetail,
  normalizeProjectedEndpoint,
  scoreValidationLeadPriority,
} from './WorkspaceProjectionHelpers';
export class WorkspaceProjectionService {
  private readonly renderer = new WorkspaceProjectionRenderer();
  constructor(
    private readonly db: DatabaseClient,
    private readonly deps: { skillLoader?: SkillLoader; now?: () => Date } = {},
  ) {}

  async projectRunWorkspace(input: ProjectRunWorkspaceInput): Promise<ProjectionResult> {
    const scopesToProject = expandScopes(input.scopes);
    const generatedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const written: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const warnings: string[] = [];

    const writeText = async (relativePath: string, content: string): Promise<void> => {
      const normalized = assertProjectionOwnedPath(relativePath);
      await input.workspace.filePort.writeFileAtomic(normalized, content);
      written.push(normalized);
    };

    const writeJson = async <T>(relativePath: string, projection: string, data: T): Promise<void> => {
      const normalized = assertProjectionOwnedPath(relativePath);
      const envelope = makeEnvelope(input, projection, generatedAt, data);
      await input.workspace.filePort.writeFileAtomic(normalized, `${JSON.stringify(envelope, null, 2)}\n`);
      written.push(normalized);
    };

    for (const directory of WORKSPACE_DIRS) {
      await input.workspace.filePort.ensureDir(directory);
    }

    if (scopesToProject.has('contract')) {
      await writeText('AGENTS.md', this.renderer.renderAgentsContract(input, generatedAt));
      await writeText('.artifacts/README.md', this.renderer.renderArtifactsReadme());
    }

    let contextProjection: ContextProjection | null = null;
    if (scopesToProject.has('context')) {
      contextProjection = await this.buildContextProjection(input);
      await writeJson('context/scope.json', 'context.scope', contextProjection);
      await writeText(
        'context/organization.md',
        this.renderer.withMarker('context.organization', generatedAt, this.renderer.renderOrganizationMarkdown(contextProjection)),
      );
      await writeText('context/scope.md', this.renderer.withMarker('context.scope', generatedAt, this.renderer.renderScopeMarkdown(contextProjection)));
      await writeText('context/roe.md', this.renderer.withMarker('context.roe', generatedAt, this.renderer.renderRoeMarkdown(contextProjection)));
      await writeText(
        'context/execution.md',
        this.renderer.withMarker('context.execution', generatedAt, this.renderer.renderExecutionMarkdown(contextProjection)),
      );
      await writeText('context/access.md', this.renderer.withMarker('context.access', generatedAt, this.renderer.renderAccessMarkdown(contextProjection)));
      await writeText(
        'context/access-materials.md',
        this.renderer.withMarker('context.access-materials', generatedAt, this.renderer.renderAccessMarkdown(contextProjection)),
      );
      await writeText(
        'context/prior-runs.md',
        this.renderer.withMarker('context.prior-runs', generatedAt, this.renderer.renderPriorRunsMarkdown(contextProjection)),
      );
    }

    let reconProjection: ReconProjection | null = null;
    if (scopesToProject.has('recon')) {
      reconProjection = await this.buildReconProjection(input);
      await writeJson('recon/assets.json', 'recon.assets', reconProjection.assets);
      await writeJson('recon/services.json', 'recon.services', reconProjection.services);
      await writeJson('recon/endpoints.json', 'recon.endpoints', reconProjection.endpoints);
      await writeJson('recon/technologies.json', 'recon.technologies', reconProjection.technologies);
      await writeJson('recon/graph.json', 'recon.graph', reconProjection.graph);
      await writeText('recon/surface.md', this.renderer.withMarker('recon.surface', generatedAt, this.renderer.renderSurfaceMarkdown(reconProjection)));
    }

    let coverageProjection: CoverageProjection | null = null;
    if (scopesToProject.has('coverage')) {
      coverageProjection = await this.buildCoverageProjection(input);
      await writeJson('journal/coverage.json', 'journal.coverage', coverageProjection);
      await writeText(
        'journal/coverage.md',
        this.renderer.withMarker('journal.coverage', generatedAt, this.renderer.renderCoverageMarkdown(coverageProjection)),
      );
    }

    let leadsProjection: LeadsProjection | null = null;
    if (scopesToProject.has('leads')) {
      leadsProjection = await this.buildLeadsProjection(input);
      await writeJson('journal/leads.json', 'journal.leads', leadsProjection);
      await writeText('journal/leads.md', this.renderer.withMarker('journal.leads', generatedAt, this.renderer.renderLeadsMarkdown(leadsProjection)));
    }

    let findingsProjection: FindingsProjection | null = null;
    if (scopesToProject.has('findings')) {
      findingsProjection = await this.buildFindingsProjection(input);
      await writeJson('findings/index.json', 'findings.index', findingsProjection.findings);
      await writeJson('findings/candidates.json', 'findings.candidates', findingsProjection.candidates);
      await writeJson('findings/reportable.json', 'findings.reportable', findingsProjection.reportable);
      await writeText(
        'findings/index.md',
        this.renderer.withMarker('findings.index', generatedAt, this.renderer.renderFindingsMarkdown(findingsProjection)),
      );
    }

    let evidenceProjection: EvidenceProjection | null = null;
    if (scopesToProject.has('evidence')) {
      evidenceProjection = await this.buildEvidenceProjection(input);
      await writeJson('evidence/manifest.json', 'evidence.manifest', evidenceProjection);
    }

    let complianceProjection: ComplianceProjection | null = null;
    if (scopesToProject.has('compliance')) {
      if (await this.shouldProjectCompliance(input)) {
        complianceProjection = await this.buildComplianceProjection(input, warnings);
        await writeJson('.compliance/framework.json', 'compliance.framework', complianceProjection.frameworks);
        await writeJson('.compliance/monitored-controls.json', 'compliance.monitored-controls', complianceProjection.monitoredControls);
        await writeJson('.compliance/readiness-current.json', 'compliance.readiness-current', complianceProjection.readinessControls);
        await writeJson('.compliance/open-requests.json', 'compliance.open-requests', complianceProjection.openRequests);
        await writeJson('.compliance/evidence-index.json', 'compliance.evidence-index', complianceProjection.evidenceItems);
        await writeJson('.compliance/previous-runs.json', 'compliance.previous-runs', complianceProjection.previousRuns);
        await writeText(
          '.compliance/methodology.md',
          this.renderer.withMarker(
            'compliance.methodology',
            generatedAt,
            await this.renderComplianceMethodology(input, complianceProjection),
          ),
        );
      } else {
        skipped.push({ path: '.compliance/*', reason: 'run is not compliance-scoped' });
      }
    }

    if (scopesToProject.has('skills')) {
      const skillsProjection = await this.buildSkillsProjection(input, warnings);
      await writeJson('skills/index.json', 'skills.index', skillsProjection.catalog);
      await writeText('skills/index.md', this.renderer.withMarker('skills.index', generatedAt, this.renderer.renderSkillsMarkdown(skillsProjection.catalog)));
      await writeText(
        'skills/active.md',
        this.renderer.withMarker('skills.active', generatedAt, this.renderer.renderActiveSkillsMarkdown(skillsProjection.activeSkillSlugs)),
      );
    }

    if (scopesToProject.has('scanDigest')) {
      const scanDigest = await this.buildScanDigestProjection(input, {
        recon: reconProjection,
        coverage: coverageProjection,
      });
      await writeJson('scans/digest.json', 'scans.digest', scanDigest);
      await writeText('scans/digest.md', this.renderer.withMarker('scans.digest', generatedAt, this.renderer.renderScanDigestMarkdown(scanDigest)));
    }

    if (scopesToProject.has('model')) {
      const modelProjection = await this.buildModelProjection(input, {
        context: contextProjection,
        recon: reconProjection,
        coverage: coverageProjection,
        leads: leadsProjection,
        findings: findingsProjection,
      });
      await writeJson('journal/model.json', 'journal.model', modelProjection);
      await writeText('journal/model.md', this.renderer.withMarker('journal.model', generatedAt, this.renderer.renderModelMarkdown(modelProjection)));
    }

    return {
      success: true,
      written,
      skipped,
      warnings,
      modelSummaryPath: written.includes('journal/model.md') ? 'journal/model.md' : undefined,
    };
  }

  private async buildContextProjection(input: ProjectRunWorkspaceInput): Promise<ContextProjection> {
    const [org] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        operationalContext: organizations.operationalContext,
      })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .limit(1);

    const [scope] = await this.db
      .select({
        id: scopes.id,
        name: scopes.name,
        mission: scopes.mission,
        executionNetwork: scopes.executionNetwork,
        impactTolerance: scopes.impactTolerance,
        complianceFrameworks: scopes.complianceFrameworks,
      })
      .from(scopes)
      .where(and(eq(scopes.id, input.scopeId), eq(scopes.organizationId, input.orgId)))
      .limit(1);

    const [run] = await this.db
      .select({
        id: runs.id,
        title: runs.title,
        goal: runs.goal,
        status: runs.status,
        executionTarget: runs.executionTarget,
        runnerId: runs.runnerId,
        modelCategory: runs.modelCategory,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.organizationId, input.orgId), eq(runs.scopeId, input.scopeId)))
      .limit(1);

    const targetRows = await this.db
      .select({
        id: scopeTargets.id,
        type: scopeTargets.type,
        value: scopeTargets.value,
        verified: scopeTargets.verified,
        verificationMethod: scopeTargets.verificationMethod,
      })
      .from(scopeTargets)
      .where(eq(scopeTargets.scopeId, input.scopeId))
      .orderBy(scopeTargets.type, scopeTargets.value);

    const accessRows = await this.db
      .select({
        id: scopeAccessMaterials.id,
        kind: scopeAccessMaterials.kind,
        label: scopeAccessMaterials.label,
        username: scopeAccessMaterials.username,
        headerName: scopeAccessMaterials.headerName,
        appliesToHosts: scopeAccessMaterials.appliesToHosts,
        notes: scopeAccessMaterials.notes,
        lastUsedAt: scopeAccessMaterials.lastUsedAt,
      })
      .from(scopeAccessMaterials)
      .where(and(eq(scopeAccessMaterials.organizationId, input.orgId), eq(scopeAccessMaterials.scopeId, input.scopeId)))
      .orderBy(scopeAccessMaterials.label);

    const personaRows = await this.db
      .select({
        id: scopeTestPersonas.id,
        label: scopeTestPersonas.label,
        roleLabel: scopeTestPersonas.roleLabel,
        kind: scopeTestPersonas.kind,
        username: scopeTestPersonas.username,
        headerName: scopeTestPersonas.headerName,
        appliesToHosts: scopeTestPersonas.appliesToHosts,
        refreshProcedure: scopeTestPersonas.refreshProcedure,
        lastUsedAt: scopeTestPersonas.lastUsedAt,
        refreshedAt: scopeTestPersonas.refreshedAt,
      })
      .from(scopeTestPersonas)
      .where(and(eq(scopeTestPersonas.organizationId, input.orgId), eq(scopeTestPersonas.scopeId, input.scopeId)))
      .orderBy(scopeTestPersonas.label);

    const priorRunRows = await this.db
      .select({
        id: inventoryNotes.id,
        assetId: inventoryNotes.assetId,
        sessionId: inventoryNotes.sessionId,
        ntype: inventoryNotes.ntype,
        title: inventoryNotes.title,
        data: inventoryNotes.data,
        confidence: inventoryNotes.confidence,
        evidence: inventoryNotes.evidence,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.organizationId, input.orgId),
          eq(inventoryNotes.scopeId, input.scopeId),
          inArray(inventoryNotes.ntype, ['run.digest', 'approach.tried', 'approach.blocker']),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(100);

    return {
      organization: org ?? null,
      scope: scope ?? null,
      run: run ? { ...run, startedAt: toIso(run.startedAt) } : null,
      targets: targetRows,
      accessMaterials: accessRows.map((row) => ({ ...row, lastUsedAt: toIso(row.lastUsedAt) })),
      personas: personaRows.map((row) => ({
        id: row.id,
        label: row.label,
        roleLabel: row.roleLabel ?? null,
        kind: row.kind,
        username: row.username ?? null,
        headerName: row.headerName ?? null,
        appliesToHosts: row.appliesToHosts ?? [],
        refreshConfigured: Object.keys(row.refreshProcedure ?? {}).length > 0,
        lastUsedAt: toIso(row.lastUsedAt),
        refreshedAt: toIso(row.refreshedAt),
      })),
      priorRunNotes: priorRunRows.map((row) => this.projectNote(row)),
    };
  }

  private async buildReconProjection(input: ProjectRunWorkspaceInput): Promise<ReconProjection> {
    const assetRows = await this.db
      .select({
        asset: assets,
      })
      .from(assets)
      // Membership, not the originating scope: an asset a second scope has
      // since observed would otherwise be invisible to that scope's workspace.
      .where(and(eq(assets.organizationId, input.orgId), confirmedAssetClause(input.scopeId)))
      .orderBy(desc(assets.lastSeenAt))
      .limit(500);

    const serviceRows = await this.db
      .select({
        service: inventoryServices,
        assetValue: assets.value,
        assetKind: assets.kind,
      })
      .from(inventoryServices)
      .leftJoin(assets, eq(assets.id, inventoryServices.assetId))
      .where(and(eq(inventoryServices.organizationId, input.orgId), eq(assets.scopeId, input.scopeId)))
      .orderBy(desc(inventoryServices.lastSeenAt))
      .limit(500);

    const noteRows = await this.db
      .select({
        id: inventoryNotes.id,
        assetId: inventoryNotes.assetId,
        sessionId: inventoryNotes.sessionId,
        ntype: inventoryNotes.ntype,
        title: inventoryNotes.title,
        data: inventoryNotes.data,
        confidence: inventoryNotes.confidence,
        evidence: inventoryNotes.evidence,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.organizationId, input.orgId),
          eq(inventoryNotes.scopeId, input.scopeId),
          inArray(inventoryNotes.ntype, ['http.endpoint', 'tech.fingerprint']),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(1000);

    const projectedAssets = assetRows.map(({ asset }) => ({
      id: asset.id,
      kind: asset.kind,
      value: asset.value,
      tags: asset.tags ?? [],
      parentAssetId: asset.parentAssetId,
      lastScannedAt: toIso(asset.lastScannedAt),
      lastSeenAt: toIso(asset.lastSeenAt),
      evidence: asset.evidence,
    }));

    const projectedServices = serviceRows.map(({ service, assetValue, assetKind }) => ({
      id: service.id,
      assetId: service.assetId,
      assetValue,
      assetKind,
      protocol: service.protocol,
      port: service.port,
      serviceName: service.serviceName,
      product: service.product,
      version: service.version,
      evidence: service.evidence,
      lastSeenAt: toIso(service.lastSeenAt),
    }));

    const endpoints = noteRows
      .filter((row) => row.ntype === 'http.endpoint')
      .map((row) => normalizeProjectedEndpoint(this.projectNote(row)));
    const technologies = noteRows
      .filter((row) => row.ntype === 'tech.fingerprint')
      .map((row) => this.projectNote(row));
    const graph = buildEndpointSurfaceGraph({
      assets: projectedAssets,
      services: projectedServices,
      endpoints,
    });

    return {
      assets: projectedAssets,
      services: projectedServices,
      endpoints,
      technologies,
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
      },
      endpointSummary: graph.endpointSummary,
    };
  }

  private async buildCoverageProjection(input: ProjectRunWorkspaceInput): Promise<CoverageProjection> {
    const coverageNotes = await this.db
      .select({
        id: inventoryNotes.id,
        title: inventoryNotes.title,
        data: inventoryNotes.data,
        confidence: inventoryNotes.confidence,
        evidence: inventoryNotes.evidence,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.organizationId, input.orgId),
          eq(inventoryNotes.scopeId, input.scopeId),
          eq(inventoryNotes.ntype, 'scan.coverage'),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(200);

    const scannerRows = await this.db
      .select({
        id: scannerObservations.id,
        parser: scannerObservations.parser,
        sourceTool: scannerObservations.sourceTool,
        observationType: scannerObservations.observationType,
        title: scannerObservations.title,
        severity: scannerObservations.severity,
        artifactPath: scannerObservations.artifactPath,
        lastSeenAt: scannerObservations.lastSeenAt,
      })
      .from(scannerObservations)
      .where(and(eq(scannerObservations.organizationId, input.orgId), eq(scannerObservations.scopeId, input.scopeId)))
      .orderBy(desc(scannerObservations.lastSeenAt))
      .limit(300);

    const projectedNotes = coverageNotes.map((row) => this.projectNote({ ...row, ntype: 'scan.coverage', assetId: null, sessionId: null }));
    const projectedScannerRows = scannerRows.map((row) => ({ ...row, lastSeenAt: toIso(row.lastSeenAt) }));
    const detail = deriveCoverageProjectionDetail({
      coverageNotes: projectedNotes,
      scannerRows: projectedScannerRows,
    });

    return {
      notes: projectedNotes,
      scannerObservations: projectedScannerRows,
      gaps: detail.gaps,
      matrix: detail.matrix,
      blockers: detail.blockers,
    };
  }

  private async buildLeadsProjection(input: ProjectRunWorkspaceInput): Promise<LeadsProjection> {
    const leadRows = await this.db
      .select({
        id: inventoryNotes.id,
        assetId: inventoryNotes.assetId,
        sessionId: inventoryNotes.sessionId,
        ntype: inventoryNotes.ntype,
        title: inventoryNotes.title,
        data: inventoryNotes.data,
        confidence: inventoryNotes.confidence,
        evidence: inventoryNotes.evidence,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.organizationId, input.orgId),
          eq(inventoryNotes.scopeId, input.scopeId),
          eq(inventoryNotes.ntype, 'validation.lead'),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(300);

    const queueRows = await this.db
      .select({
        id: runValidationQueue.id,
        findingId: runValidationQueue.findingId,
        phaseId: runValidationQueue.phaseId,
        status: runValidationQueue.status,
        rationale: runValidationQueue.rationale,
        outcome: runValidationQueue.outcome,
        resultRef: runValidationQueue.resultRef,
        attempt: runValidationQueue.attempt,
        updatedAt: runValidationQueue.updatedAt,
      })
      .from(runValidationQueue)
      .where(eq(runValidationQueue.runId, input.runId))
      .orderBy(desc(runValidationQueue.updatedAt))
      .limit(200);

    const validationLeads = leadRows
      .map((row) => {
        const projected = this.projectNote(row);
        return {
          ...projected,
          leadPriority: scoreValidationLeadPriority(projected),
        };
      })
      .sort(compareLeadsByPriority);

    return {
      validationLeads,
      validationQueue: queueRows.map((row) => ({ ...row, updatedAt: toIso(row.updatedAt) })),
    };
  }

  private async buildFindingsProjection(input: ProjectRunWorkspaceInput): Promise<FindingsProjection> {
    const rows = await this.db
      .select({
        id: findings.id,
        assetId: findings.assetId,
        endpointId: findings.endpointId,
        serviceId: findings.serviceId,
        title: findings.title,
        severity: findings.severity,
        state: findings.state,
        summary: findings.summary,
        cweId: findings.cweId,
        cweIds: findings.cweIds,
        cvssScore: findings.cvssScore,
        confidenceScore: findings.confidenceScore,
        lastSeenAt: findings.lastSeenAt,
        businessImpact: findings.businessImpact,
        technicalAnalysis: findings.technicalAnalysis,
        pocDescription: findings.pocDescription,
        assumptions: findings.assumptions,
        remediation: findings.remediation,
      })
      .from(findings)
      .where(and(
        eq(findings.organizationId, input.orgId),
        eq(findings.scopeId, input.scopeId),
        eq(findings.sourceKind, 'assessment'),
      ))
      .orderBy(desc(findings.lastSeenAt))
      .limit(500);

    const projected = rows.map((row) => ({
      ...row,
      lastSeenAt: toIso(row.lastSeenAt),
      missingReportFields: ['businessImpact', 'technicalAnalysis', 'pocDescription', 'assumptions', 'remediation'].filter(
        (field) => !getString(row[field as keyof typeof row]),
      ),
    }));

    return {
      findings: projected,
      candidates: projected.filter((row) => row.state !== 'dismissed' && !isReportableRiskState(row.state)),
      reportable: projected.filter((row) => isReportableRiskState(row.state)),
    };
  }

  private async buildEvidenceProjection(input: ProjectRunWorkspaceInput): Promise<EvidenceProjection> {
    const evidenceRows = await this.db
      .select({
        id: findingEvidence.id,
        findingId: findingEvidence.findingId,
        sessionId: findingEvidence.sessionId,
        kind: findingEvidence.kind,
        path: findingEvidence.path,
        displayPath: findingEvidence.displayPath,
        label: findingEvidence.label,
        excerpt: findingEvidence.excerpt,
        fileMissing: findingEvidence.fileMissing,
        createdAt: findingEvidence.createdAt,
      })
      .from(findingEvidence)
      .innerJoin(findings, eq(findings.id, findingEvidence.findingId))
      .where(and(eq(findingEvidence.organizationId, input.orgId), eq(findings.scopeId, input.scopeId)))
      .orderBy(desc(findingEvidence.createdAt))
      .limit(500);

    const scannerRows = await this.db
      .select({
        id: scannerObservations.id,
        findingId: scannerObservations.findingId,
        parser: scannerObservations.parser,
        title: scannerObservations.title,
        artifactPath: scannerObservations.artifactPath,
        evidence: scannerObservations.evidence,
        lastSeenAt: scannerObservations.lastSeenAt,
      })
      .from(scannerObservations)
      .where(and(eq(scannerObservations.organizationId, input.orgId), eq(scannerObservations.scopeId, input.scopeId)))
      .orderBy(desc(scannerObservations.lastSeenAt))
      .limit(500);

    return {
      evidence: evidenceRows.map((row) => ({ ...row, createdAt: toIso(row.createdAt) })),
      scannerEvidence: scannerRows.map((row) => ({ ...row, lastSeenAt: toIso(row.lastSeenAt) })),
    };
  }

  private async shouldProjectCompliance(input: ProjectRunWorkspaceInput): Promise<boolean> {
    const activeSkillSlugs = normalizeSkillSlugs(input.assignedSkillSlugs);
    if (activeSkillSlugs.some((slug) => slug.startsWith('compliance-'))) {
      return true;
    }

    const [run] = await this.db
      .select({ workflowDiscipline: runs.workflowDiscipline })
      .from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.organizationId, input.orgId), eq(runs.scopeId, input.scopeId)))
      .limit(1);
    return run?.workflowDiscipline === 'compliance';
  }

  private async buildComplianceProjection(
    input: ProjectRunWorkspaceInput,
    warnings: string[],
  ): Promise<ComplianceProjection> {
    const activeFrameworkKey = await this.resolveActiveComplianceFramework(input);
    const [readiness, evidenceItems, previousRuns] = await Promise.all([
      new ComplianceReadinessService(this.db).getScopeReadiness({
        organizationId: input.orgId,
        scopeId: input.scopeId,
      }),
      new ComplianceEvidenceService(this.db).listEvidenceItems({
        organizationId: input.orgId,
        scopeId: input.scopeId,
        limit: 500,
      }),
      this.buildCompliancePreviousRunsProjection(input, warnings, activeFrameworkKey),
    ]);

    const activeFrameworks = readiness.frameworks.filter((framework) =>
      !activeFrameworkKey || framework.key === activeFrameworkKey,
    );
    const controls = activeFrameworks.flatMap((framework) =>
      framework.controls.map((control) => ({ framework, control })),
    );

    return {
      frameworks: activeFrameworks.map((framework) => {
        const registry = FRAMEWORK_REGISTRY[framework.key];
        return {
          key: framework.key,
          label: framework.label,
          selected: framework.selected,
          supported: framework.supported,
          score: framework.score,
          statusCounts: framework.statusCounts,
          outcomeCounts: framework.outcomeCounts,
          verdictCounts: framework.verdictCounts,
          totalControls: framework.controls.length,
          monitoredControls: framework.controls.filter((control) => control.monitoring.state === 'monitored').length,
          excludedControls: framework.controls.filter((control) => control.monitoring.state === 'excluded').length,
          proofObligations: framework.controls.filter((control) => control.proofObligation).length,
          reportTitle: registry?.reportTitle ?? framework.label,
          controls: framework.controls.map((control) => {
            const definition = registry?.controls.find((candidate) => candidate.id === control.id);
            return {
              id: control.id,
              title: control.title,
              theme: control.theme,
              supportLevel: control.supportLevel,
              catalogRef: control.catalogRef,
              proofObligation: control.proofObligation,
              requiredEvidence: control.requiredEvidence,
              testSkillSlugs: definition?.testSkillSlugs ?? [],
              deterministicTools: definition?.deterministicTools ?? [],
            };
          }),
        };
      }),
      monitoredControls: controls.map(({ framework, control }) => ({
        frameworkKey: framework.key,
        frameworkLabel: framework.label,
        controlId: control.id,
        title: control.title,
        theme: control.theme,
        supportLevel: control.supportLevel,
        monitoring: control.monitoring,
        assignment: control.assignment,
        proofObligation: control.proofObligation,
        requiredEvidence: control.requiredEvidence,
      })),
      readinessControls: controls.map(({ framework, control }) => this.projectComplianceReadinessControl(framework, control)),
      openRequests: controls
        .flatMap(({ framework, control }) =>
          control.actionRequests
            .filter((request) => ['open', 'fulfilled', 'insufficient', 'contradicted'].includes(request.status))
            .map((request) => ({
              frameworkKey: framework.key,
              frameworkLabel: framework.label,
              controlId: control.id,
              controlTitle: control.title,
              request: this.projectComplianceActionRequest(request),
            })),
        )
        .sort((left, right) => right.request.updatedAt.localeCompare(left.request.updatedAt)),
      evidenceItems: evidenceItems.map((item) => {
        const artifact = isRecord(item.artifact) ? item.artifact : {};
        return {
          id: item.id,
          handle: `compliance-evidence:${item.id}`,
          scopeId: item.scopeId,
          title: item.title,
          description: redactSensitiveText(item.description, 500),
          sourceType: item.sourceType,
          evidenceType: item.evidenceType,
          status: item.status,
          owner: item.owner,
          observationStartedAt: toIso(item.observationStartedAt),
          observationEndedAt: toIso(item.observationEndedAt),
          validUntil: toIso(item.validUntil),
          createdAt: toIso(item.createdAt),
          updatedAt: toIso(item.updatedAt),
          artifact: {
            fileName: firstString(artifact.fileName),
            mimeType: firstString(artifact.mimeType),
            sizeBytes: typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : null,
            sha256: firstString(artifact.sha256),
            sourceRef: firstString(artifact.sourceRef),
            storageHandleAvailable: typeof artifact.storageRef === 'string' && artifact.storageRef.trim().length > 0,
          },
          mappings: item.mappings
            .filter((mapping) => !activeFrameworkKey || mapping.frameworkKey === activeFrameworkKey)
            .map((mapping) => ({
              frameworkKey: mapping.frameworkKey,
              controlId: mapping.controlId,
              mappingSource: mapping.mappingSource,
              confidence: mapping.confidence,
              rationale: redactSensitiveText(mapping.rationale, 500),
            })),
          agentReview: item.agentReview
            ? {
                status: item.agentReview.status,
                checkId: item.agentReview.checkId,
                frameworkKey: item.agentReview.frameworkKey,
                controlId: item.agentReview.controlId,
                verdict: item.agentReview.verdict,
                reviewedAt: toIso(item.agentReview.reviewedAt),
                reason: redactSensitiveText(item.agentReview.reason, 500),
              }
            : null,
        };
      }),
      previousRuns,
    };
  }

  private async resolveActiveComplianceFramework(
    input: ProjectRunWorkspaceInput,
  ): Promise<ComplianceFrameworkKey | null> {
    if (input.activeComplianceFrameworkKey) {
      return input.activeComplianceFrameworkKey;
    }
    const [run] = await this.db
      .select({ complianceFrameworkKey: runs.complianceFrameworkKey })
      .from(runs)
      .where(and(
        eq(runs.id, input.runId),
        eq(runs.organizationId, input.orgId),
        eq(runs.scopeId, input.scopeId),
      ))
      .limit(1);
    return run?.complianceFrameworkKey ?? null;
  }

  private projectComplianceReadinessControl(
    framework: ComplianceReadinessResponse['frameworks'][number],
    control: ComplianceReadinessControl,
  ): Record<string, unknown> {
    return {
      frameworkKey: framework.key,
      frameworkLabel: framework.label,
      controlId: control.id,
      title: control.title,
      status: control.status,
      verdict: control.verdict,
      outcome: control.outcome,
      reasonCode: control.reasonCode,
      verdictReason: redactSensitiveText(control.verdictReason, 800),
      nextAction: redactSensitiveText(control.nextAction, 800),
      gaps: control.gaps.slice(0, 10).map((gap) => redactSensitiveText(gap, 500)),
      coverageLimitations: control.coverageLimitations.slice(0, 10).map((limitation) => redactSensitiveText(limitation, 500)),
      evidenceFreshness: control.evidenceFreshness,
      monitoring: control.monitoring,
      assignment: control.assignment,
      actionRequests: control.actionRequests.map((request) => this.projectComplianceActionRequest(request)),
      controlChecks: control.controlChecks.slice(0, 10).map((check) => ({
        id: check.id,
        basis: check.basis,
        verdict: check.verdict,
        reasonCode: check.reasonCode,
        reason: redactSensitiveText(check.reason, 800),
        proofObligationId: check.proofObligationId,
        method: redactSensitiveText(check.method, 300),
        targetRef: redactSensitiveText(check.targetRef, 500),
        limitations: check.limitations.map((limitation) => redactSensitiveText(limitation, 500)),
        freshUntil: check.freshUntil,
        createdAt: check.createdAt,
        fresh: check.fresh,
        eligible: check.eligible,
        reviewStatus: check.reviewStatus,
        evidenceRefs: check.evidenceRefs.slice(0, 20),
        artifactIds: check.artifactIds.slice(0, 20),
      })),
      evidence: control.evidence.slice(0, 20).map((evidence) => ({
        id: evidence.id,
        kind: evidence.kind,
        title: evidence.title,
        source: evidence.source,
        sourceRef: evidence.sourceRef,
        lastSeenAt: evidence.lastSeenAt,
        mappingSource: evidence.mappingSource,
        mappingConfidence: evidence.mappingConfidence,
        controlCheckVerdict: evidence.controlCheckVerdict,
      })),
    };
  }

  private projectComplianceActionRequest(
    request: ComplianceReadinessControl['actionRequests'][number],
  ) {
    return {
      id: request.id,
      requestType: request.requestType,
      priority: request.priority,
      status: request.status,
      title: redactSensitiveText(request.title, 300),
      reason: redactSensitiveText(request.reason, 500),
      requestedEvidence: request.requestedEvidence.map((item) => redactSensitiveText(item, 500)),
      dueAt: request.dueAt,
      updatedAt: request.updatedAt,
    };
  }

  private async buildCompliancePreviousRunsProjection(
    input: ProjectRunWorkspaceInput,
    warnings: string[],
    activeFrameworkKey?: ComplianceFrameworkKey | null,
  ): Promise<unknown[]> {
    try {
      const whereClauses = [
        eq(runs.organizationId, input.orgId),
        eq(runs.scopeId, input.scopeId),
        eq(runs.workflowDiscipline, 'compliance'),
        activeFrameworkKey ? eq(runs.complianceFrameworkKey, activeFrameworkKey) : undefined,
      ].filter((clause): clause is Exclude<typeof clause, undefined> => clause !== undefined);
      const rows = await this.db
        .select({
          id: runs.id,
          title: runs.title,
          goal: runs.goal,
          status: runs.status,
          createdAt: runs.createdAt,
          updatedAt: runs.updatedAt,
          completedAt: runs.completedAt,
        })
        .from(runs)
        .where(and(...whereClauses))
        .orderBy(desc(runs.createdAt))
        .limit(10);
      return rows.map((run) => ({
        id: run.id,
        title: run.title,
        goal: redactSensitiveText(run.goal, 500),
        status: run.status,
        createdAt: toIso(run.createdAt),
        updatedAt: toIso(run.updatedAt),
        completedAt: toIso(run.completedAt),
      }));
    } catch (error) {
      warnings.push(`compliance previous-runs projection failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async renderComplianceMethodology(
    input: ProjectRunWorkspaceInput,
    projection: ComplianceProjection,
  ): Promise<string> {
    const skillLoader = this.deps.skillLoader ?? new SkillLoader();
    const activeComplianceSkillSlugs = normalizeSkillSlugs(input.assignedSkillSlugs)
      .filter((slug) => slug.startsWith('compliance-'));
    const loadedSkills = await Promise.all(
      activeComplianceSkillSlugs.map((slug) => skillLoader.loadSkillBySlug(slug)),
    );
    const skills = loadedSkills.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
    const frameworkKeys = projection.frameworks
      .filter(isRecord)
      .map((framework) => firstString(framework.key))
      .filter((key): key is string => Boolean(key));

    const lines = [
      '# Compliance Methodology Workspace Pack',
      '',
      'Use this directory as a bounded read-only orientation pack. Backend compliance tools remain authoritative.',
      '',
      '## Required Rules',
      '',
      '- Do not put credentials, tokens, private keys, or raw customer secrets in prompts, notes, run.digest, control checks, or reports.',
      '- Reference access material by approved handle only.',
      '- Use `record_control_check` for tested or reviewed controls.',
      '- Use `record_control_request` when evidence, access, context, or remediation is missing.',
      '- Suggested evidence mappings never create readiness credit; only an agent-authored control check can change readiness.',
      '',
      '## Frameworks',
      '',
      ...(frameworkKeys.length > 0 ? frameworkKeys.map((key) => `- ${key}`) : ['- none selected']),
      '',
      '## Workspace Files',
      '',
      '- `.compliance/framework.json` - selected framework and control catalog context.',
      '- `.compliance/monitored-controls.json` - included/excluded controls and assignment context.',
      '- `.compliance/readiness-current.json` - latest verdicts, checks, limitations, and next actions.',
      '- `.compliance/open-requests.json` - active action requests to refresh instead of duplicating.',
      '- `.compliance/evidence-index.json` - evidence handles, status, mappings, and safe artifact metadata.',
      '- `.compliance/previous-runs.json` - recent compliance run summaries for continuity.',
      '',
      '## Active Compliance Skills',
      '',
    ];

    if (skills.length === 0) {
      lines.push('- No compliance skill is active in this phase.');
    } else {
      for (const skill of skills) {
        lines.push(`### ${skill.slug}`);
        lines.push('');
        lines.push(`- Name: ${skill.name}`);
        lines.push(`- Phase: ${skill.phase ?? 'unspecified'}`);
        lines.push(`- Local path: ${skill.localPath}/SKILL.md`);
        if (skill.requiredTools?.length) {
          lines.push(`- Required tools: ${skill.requiredTools.join(', ')}`);
        }
        if (skill.expectedOutputs.length > 0) {
          lines.push(`- Expected outputs: ${skill.expectedOutputs.join('; ')}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private async buildSkillsProjection(
    input: ProjectRunWorkspaceInput,
    warnings: string[],
  ): Promise<{ catalog: SkillIndexEntry[]; activeSkillSlugs: string[] }> {
    const skillLoader = this.deps.skillLoader ?? new SkillLoader();
    const catalog = await skillLoader.loadSkillCatalog();
    const activeSkillSlugs = normalizeSkillSlugs(input.assignedSkillSlugs);
    const codeReviewWorkspace =
      activeSkillSlugs.includes('code-review-planning')
      || input.phaseKey?.startsWith('review_') === true;
    const planningSkillSlug = codeReviewWorkspace
      ? 'code-review-planning'
      : activeSkillSlugs.includes('compliance-planning')
        ? 'compliance-planning'
        : activeSkillSlugs.includes('securityops-planning')
          ? 'securityops-planning'
          : null;
    if (planningSkillSlug && !catalog.some((skill) => skill.slug === planningSkillSlug)) {
      warnings.push(`configured planning skill slug ${planningSkillSlug} was not found`);
    }
    const visibleCatalog = codeReviewWorkspace
      ? catalog.filter((skill) => skill.category === 'code_review')
      : catalog;
    return {
      catalog: visibleCatalog
        .map((skill) => ({
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          phase: skill.phase,
          compatiblePhases: skill.compatiblePhases,
          category: skill.category,
          requiredTools: skill.requiredTools,
          riskTier: skill.riskTier,
          versionHash: skill.versionHash,
          catalogVersion: skill.catalogVersion,
          useWhen: skill.useWhen,
          strongTerms: skill.strongTerms,
          techTriggers: skill.techTriggers,
          ntypeTriggers: skill.ntypeTriggers,
        }))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
      activeSkillSlugs,
    };
  }

  private async buildScanDigestProjection(
    input: ProjectRunWorkspaceInput,
    cached: { recon?: ReconProjection | null; coverage?: CoverageProjection | null } = {},
  ): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select({
        parser: scannerObservations.parser,
        sourceTool: scannerObservations.sourceTool,
        observationType: scannerObservations.observationType,
        severity: scannerObservations.severity,
        title: scannerObservations.title,
        artifactPath: scannerObservations.artifactPath,
        data: scannerObservations.data,
        lastSeenAt: scannerObservations.lastSeenAt,
      })
      .from(scannerObservations)
      .where(and(eq(scannerObservations.organizationId, input.orgId), eq(scannerObservations.scopeId, input.scopeId)))
      .orderBy(desc(scannerObservations.lastSeenAt))
      .limit(500);

    const recon = cached.recon ?? (await this.buildReconProjection(input));
    const coverage = cached.coverage ?? (await this.buildCoverageProjection(input));
    return buildScanDigest(rows, { recon, coverage });
  }

  private async buildModelProjection(
    input: ProjectRunWorkspaceInput,
    cached: {
      context: ContextProjection | null;
      recon: ReconProjection | null;
      coverage: CoverageProjection | null;
      leads: LeadsProjection | null;
      findings: FindingsProjection | null;
    },
  ): Promise<Record<string, unknown>> {
    const context = cached.context ?? (await this.buildContextProjection(input));
    const recon = cached.recon ?? (await this.buildReconProjection(input));
    const coverage = cached.coverage ?? (await this.buildCoverageProjection(input));
    const leads = cached.leads ?? (await this.buildLeadsProjection(input));
    const findingProjection = cached.findings ?? (await this.buildFindingsProjection(input));
    const attempts = await this.buildAttemptProjection(input);

    return {
      run: context.run,
      scope: context.scope
        ? {
            name: context.scope.name,
            executionNetwork: context.scope.executionNetwork,
            impactTolerance: context.scope.impactTolerance,
          }
        : null,
      surface: {
        assetCount: recon.assets.length,
        serviceCount: recon.services.length,
        endpointCount: recon.endpoints.length,
        technologyCount: recon.technologies.length,
        highValueAssets: recon.assets.slice(0, 10),
        recentEndpoints: recon.endpoints.slice(0, 15),
        technologies: recon.technologies.slice(0, 15),
        endpointSummary: recon.endpointSummary,
      },
      coverage: {
        noteCount: coverage.notes.length,
        scannerObservationCount: coverage.scannerObservations.length,
        gaps: coverage.gaps,
        matrix: coverage.matrix.slice(0, 20),
        blockers: coverage.blockers.slice(0, 20),
      },
      leads: {
        open: leads.validationLeads
          .filter((lead) => {
            const data = isRecord((lead as { data?: unknown }).data) ? (lead as { data: Record<string, unknown> }).data : {};
            const status = firstString(data.status);
            return !status || ['open', 'deferred', 'blocked'].includes(status);
          })
          .sort(compareLeadsByPriority)
          .slice(0, 20),
        queue: leads.validationQueue.slice(0, 20),
      },
      findings: {
        total: findingProjection.findings.length,
        candidates: findingProjection.candidates.slice(0, 20),
        reportable: findingProjection.reportable.slice(0, 20),
      },
      doNotRetry: attempts.doNotRetry,
      recentAttempts: attempts.recentAttempts,
      detailFiles: [
        'context/organization.md',
        'context/scope.md',
        'context/prior-runs.md',
        'context/access-materials.md',
        'recon/surface.md',
        'journal/coverage.md',
        'journal/leads.md',
        'findings/index.md',
        'scans/digest.md',
        'skills/active.md',
      ],
    };
  }

  private async buildAttemptProjection(input: ProjectRunWorkspaceInput): Promise<{
    recentAttempts: unknown[];
    doNotRetry: string[];
  }> {
    const rows = await this.db
      .select({
        id: inventoryNotes.id,
        ntype: inventoryNotes.ntype,
        title: inventoryNotes.title,
        data: inventoryNotes.data,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.organizationId, input.orgId),
          eq(inventoryNotes.scopeId, input.scopeId),
          inArray(inventoryNotes.ntype, ['approach.tried', 'approach.blocker']),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(100);

    const recentAttempts = rows.map((row) => ({
      id: row.id,
      ntype: row.ntype,
      title: row.title,
      data: row.data,
      lastSeenAt: toIso(row.lastSeenAt),
    }));

    const doNotRetry = rows
      .filter((row) => row.ntype === 'approach.blocker' || JSON.stringify(row.data).toLowerCase().includes('failed'))
      .slice(0, 20)
      .map((row) => truncate(firstString(row.title, isRecord(row.data) ? row.data.reason : null, JSON.stringify(row.data)), 180));

    return { recentAttempts, doNotRetry };
  }

  private projectNote(row: {
    id: string;
    assetId?: string | null;
    sessionId?: string | null;
    ntype: string;
    title?: string | null;
    data: Record<string, unknown>;
    confidence?: number | null;
    evidence?: unknown;
    lastSeenAt?: Date | string | null;
  }): Record<string, unknown> {
    return {
      id: row.id,
      assetId: row.assetId ?? null,
      sessionId: row.sessionId ?? null,
      ntype: row.ntype,
      title: row.title ?? null,
      data: row.data,
      confidence: row.confidence ?? null,
      evidence: row.evidence ?? [],
      lastSeenAt: toIso(row.lastSeenAt ?? null),
    };
  }

}
