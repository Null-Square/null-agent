import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  assets,
  assetObservations,
  agentSessions,
  complianceAcceptedRisks,
  complianceControlCheckReviews,
  complianceControlChecks,
  complianceControlRequests,
  complianceControlStates,
  findingEvidence,
  findings,
  inventoryNotes,
  inventoryServices,
  runPhases,
  runs,
  scannerObservations,
  scopes,
} from '@/db/schema';
import {
  FRAMEWORK_LABELS,
  type ComplianceFrameworkKey,
} from '@/domains/security-ops/compliance/frameworks';
import { isComplianceFrameworkKey } from '@/domains/security-ops/compliance/profile';
import { confirmedAssetClause } from '@/domains/security-ops/assets/assetConfirmation';
import {
  buildComplianceReadinessSnapshot,
  emptyComplianceFacts,
  extractSelectedComplianceFrameworks,
  getString,
  isRecord,
  normalizeText,
  READINESS_NOTE_TYPES,
  type ComplianceAcceptedRiskFact,
  type ComplianceControlCheckFact,
  type ComplianceControlRequestFact,
  type ComplianceControlStateFact,
  type ComplianceFacts,
  type ComplianceFindingFact,
  type ComplianceReadinessResponse,
  type ComplianceReportHistoryItem,
  type ComplianceServiceFact,
} from './ComplianceReadinessModel';

export * from './ComplianceReadinessModel';
export class ComplianceReadinessService {
  constructor(private readonly db: DatabaseClient) {}

  async listReportHistory(params: {
    organizationId: string;
    scopeId?: string | null;
    framework?: ComplianceFrameworkKey;
    limit?: number;
  }): Promise<ComplianceReportHistoryItem[]> {
    const limit = Math.min(Math.max(Math.floor(params.limit ?? 8), 1), 25);
    const conditions = [
      eq(runs.organizationId, params.organizationId),
      sql`${agentSessions.metadata}->'flags'->'securityops'->'complianceReport' IS NOT NULL`,
    ];
    if (params.scopeId) {
      conditions.push(eq(runs.scopeId, params.scopeId));
    }

    const rows = await this.db
      .select({
        id: runs.id,
        displayId: runs.displayId,
        title: runs.title,
        status: runs.status,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        completedAt: runs.completedAt,
        metadata: agentSessions.metadata,
      })
      .from(runs)
      .innerJoin(agentSessions, eq(agentSessions.id, runs.sessionId))
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt))
      .limit(limit * (params.framework ? 3 : 1));

    const reports: ComplianceReportHistoryItem[] = [];
    for (const row of rows) {
      const flags = isRecord(row.metadata?.flags) ? row.metadata.flags : null;
      const securityops = isRecord(flags?.securityops) ? flags.securityops : null;
      const report = isRecord(securityops?.complianceReport) ? securityops.complianceReport : null;
      if (!report) {
        continue;
      }
      const framework = isComplianceFrameworkKey(report.framework) ? report.framework : null;
      if (!framework || (params.framework && params.framework !== framework)) {
        continue;
      }
      reports.push({
        runId: row.id,
        displayId: typeof row.displayId === 'number' ? `#r${row.displayId}` : `#r${row.id.slice(0, 4)}`,
        title: row.title ?? `${FRAMEWORK_LABELS[framework]} Report`,
        framework,
        frameworkLabel: FRAMEWORK_LABELS[framework],
        source: getString(report.source) ?? 'dashboard-readiness',
        sourceRunId: getString(report.sourceRunId) ?? null,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      });
      if (reports.length >= limit) {
        break;
      }
    }

    return reports;
  }

  async getScopeReadiness(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<ComplianceReadinessResponse> {
    const { scopeComplianceFrameworks } = await this.loadContext(params);
    const selectedFrameworks = extractSelectedComplianceFrameworks({ scopeComplianceFrameworks });
    const facts = selectedFrameworks.length > 0
      ? await this.loadScopeFacts(params)
      : emptyComplianceFacts();
    return buildComplianceReadinessSnapshot({
      generatedAt: new Date(),
      organizationId: params.organizationId,
      scopeId: params.scopeId ?? null,
      runId: null,
      selectedFrameworks,
      facts,
    });
  }

  async getRunReadiness(params: {
    organizationId: string;
    runId: string;
  }): Promise<ComplianceReadinessResponse> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.organizationId, params.organizationId), eq(runs.id, params.runId)))
      .limit(1);

    if (!run) {
      throw new Error('Run not found');
    }

    const { scopeComplianceFrameworks } = await this.loadContext({
      organizationId: params.organizationId,
      scopeId: run.scopeId,
    });
    const selectedFrameworks = extractSelectedComplianceFrameworks({ scopeComplianceFrameworks });
    const facts = selectedFrameworks.length > 0
      ? await this.loadRunFacts(run)
      : emptyComplianceFacts();
    return buildComplianceReadinessSnapshot({
      generatedAt: new Date(),
      organizationId: params.organizationId,
      scopeId: run.scopeId,
      runId: run.id,
      selectedFrameworks,
      facts,
    });
  }

  private async loadContext(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<{ scopeComplianceFrameworks: unknown }> {
    if (!params.scopeId) {
      return { scopeComplianceFrameworks: [] };
    }
    const [scope] = await this.db
      .select({ complianceFrameworks: scopes.complianceFrameworks })
      .from(scopes)
      .where(and(eq(scopes.organizationId, params.organizationId), eq(scopes.id, params.scopeId)))
      .limit(1);
    return { scopeComplianceFrameworks: scope?.complianceFrameworks ?? [] };
  }

  private async loadScopeFacts(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<ComplianceFacts> {
    const scopeWhere = params.scopeId
      ? and(eq(findings.organizationId, params.organizationId), eq(findings.scopeId, params.scopeId))
      : eq(findings.organizationId, params.organizationId);
    const assetWhere = and(
      eq(assets.organizationId, params.organizationId),
      confirmedAssetClause(params.scopeId),
    );
    const noteWhere = params.scopeId
      ? and(eq(inventoryNotes.organizationId, params.organizationId), eq(inventoryNotes.scopeId, params.scopeId))
      : eq(inventoryNotes.organizationId, params.organizationId);
    const scannerWhere = params.scopeId
      ? and(eq(scannerObservations.organizationId, params.organizationId), eq(scannerObservations.scopeId, params.scopeId))
      : eq(scannerObservations.organizationId, params.organizationId);
    const runWhere = params.scopeId
      ? and(eq(runs.organizationId, params.organizationId), eq(runs.scopeId, params.scopeId))
      : eq(runs.organizationId, params.organizationId);

    const [
      findingRows,
      noteRows,
      assetRows,
      scannerRows,
      latestRuns,
      completedRunCounts,
      acceptedRiskRows,
      controlCheckRows,
      controlStateRows,
      controlRequestRows,
    ] = await Promise.all([
      this.loadFindingsWithEvidence(scopeWhere),
      this.db
        .select({
          ntype: inventoryNotes.ntype,
          title: inventoryNotes.title,
          data: inventoryNotes.data,
          evidence: inventoryNotes.evidence,
          lastSeenAt: inventoryNotes.lastSeenAt,
        })
        .from(inventoryNotes)
        .where(and(noteWhere, inArray(inventoryNotes.ntype, READINESS_NOTE_TYPES)))
        .orderBy(desc(inventoryNotes.lastSeenAt))
        .limit(500),
      this.db
        .select({
          id: assets.id,
          kind: assets.kind,
          value: assets.value,
          lastSeenAt: assets.lastSeenAt,
        })
        .from(assets)
        .where(assetWhere)
        .orderBy(desc(assets.lastSeenAt))
        .limit(500),
      this.db
        .select({
          id: scannerObservations.id,
          parser: scannerObservations.parser,
          observationType: scannerObservations.observationType,
          title: scannerObservations.title,
          severity: scannerObservations.severity,
          artifactPath: scannerObservations.artifactPath,
          findingId: scannerObservations.findingId,
          lastSeenAt: scannerObservations.lastSeenAt,
        })
        .from(scannerObservations)
        .where(scannerWhere)
        .orderBy(desc(scannerObservations.lastSeenAt))
        .limit(300),
      this.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(runWhere, eq(runs.status, 'completed')))
        .orderBy(desc(sql`COALESCE(${runs.completedAt}, ${runs.createdAt})`))
        .limit(1),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(runs)
        .where(and(runWhere, eq(runs.status, 'completed'))),
      this.loadAcceptedRiskFacts(params.organizationId, params.scopeId ?? null),
      this.loadControlCheckFacts({
        organizationId: params.organizationId,
        scopeId: params.scopeId ?? null,
      }),
      this.loadControlStateFacts(params.organizationId, params.scopeId ?? null),
      this.loadControlRequestFacts({
        organizationId: params.organizationId,
        scopeId: params.scopeId ?? null,
      }),
    ]);

    const assetIds = assetRows.map((asset) => asset.id);
    const serviceRows = await this.loadServicesForAssets(params.organizationId, assetIds);

    return {
      findings: findingRows,
      notes: noteRows,
      scannerObservations: scannerRows,
      assets: assetRows,
      services: serviceRows,
      acceptedRisks: acceptedRiskRows,
      controlChecks: controlCheckRows,
      controlStates: controlStateRows,
      controlRequests: controlRequestRows,
      completedRunCount: Number(completedRunCounts[0]?.count ?? 0),
      latestCompletedRunId: latestRuns[0]?.id ?? null,
    };
  }

  private async loadRunFacts(run: typeof runs.$inferSelect): Promise<ComplianceFacts> {
    const sessionIds = await this.collectRunSessionIds(run);
    const [acceptedRiskRows, controlCheckRows, controlStateRows, controlRequestRows] = await Promise.all([
      this.loadAcceptedRiskFacts(run.organizationId, run.scopeId),
      this.loadControlCheckFacts({ organizationId: run.organizationId, scopeId: run.scopeId, runId: run.id }),
      this.loadControlStateFacts(run.organizationId, run.scopeId),
      this.loadControlRequestFacts({ organizationId: run.organizationId, scopeId: run.scopeId, runId: run.id }),
    ]);
    if (sessionIds.length === 0) {
      return {
        findings: [],
        notes: [],
        scannerObservations: [],
        assets: [],
        services: [],
        acceptedRisks: acceptedRiskRows,
        controlChecks: controlCheckRows,
        controlStates: controlStateRows,
        controlRequests: controlRequestRows,
        completedRunCount: run.status === 'completed' ? 1 : 0,
        latestCompletedRunId: run.status === 'completed' ? run.id : null,
      };
    }

    const findingRefRows = await this.db
      .selectDistinct({ findingId: findingEvidence.findingId })
      .from(findingEvidence)
      .where(inArray(findingEvidence.sessionId, sessionIds));
    const findingIds = findingRefRows.map((row) => row.findingId).filter(Boolean);

    const [findingRows, noteRows, assetObservationRows, scannerRows] = await Promise.all([
      findingIds.length > 0
        ? this.loadFindingsWithEvidence(inArray(findings.id, findingIds))
        : Promise.resolve([]),
      this.db
        .select({
          ntype: inventoryNotes.ntype,
          title: inventoryNotes.title,
          data: inventoryNotes.data,
          evidence: inventoryNotes.evidence,
          lastSeenAt: inventoryNotes.lastSeenAt,
        })
        .from(inventoryNotes)
        .where(
          and(
            eq(inventoryNotes.organizationId, run.organizationId),
            eq(inventoryNotes.scopeId, run.scopeId),
            inArray(inventoryNotes.sessionId, sessionIds),
            inArray(inventoryNotes.ntype, READINESS_NOTE_TYPES),
          ),
        )
        .orderBy(desc(inventoryNotes.lastSeenAt))
        .limit(500),
      this.db
        .select({
          id: assets.id,
          kind: assets.kind,
          value: assets.value,
          lastSeenAt: assets.lastSeenAt,
        })
        .from(assetObservations)
        .innerJoin(assets, eq(assets.id, assetObservations.assetId))
        .where(and(inArray(assetObservations.sessionId, sessionIds), confirmedAssetClause(run.scopeId)))
        .orderBy(desc(assets.lastSeenAt))
        .limit(500),
      this.db
        .select({
          id: scannerObservations.id,
          parser: scannerObservations.parser,
          observationType: scannerObservations.observationType,
          title: scannerObservations.title,
          severity: scannerObservations.severity,
          artifactPath: scannerObservations.artifactPath,
          findingId: scannerObservations.findingId,
          lastSeenAt: scannerObservations.lastSeenAt,
        })
        .from(scannerObservations)
        .where(eq(scannerObservations.runId, run.id))
        .orderBy(desc(scannerObservations.lastSeenAt))
        .limit(300),
    ]);

    const uniqueAssets = Array.from(new Map(assetObservationRows.map((asset) => [asset.id, asset])).values());
    const serviceRows = await this.loadServicesForAssets(run.organizationId, uniqueAssets.map((asset) => asset.id));

    return {
      findings: findingRows,
      notes: noteRows,
      scannerObservations: scannerRows,
      assets: uniqueAssets,
      services: serviceRows,
      acceptedRisks: acceptedRiskRows,
      controlChecks: controlCheckRows,
      controlStates: controlStateRows,
      controlRequests: controlRequestRows,
      completedRunCount: run.status === 'completed' ? 1 : 0,
      latestCompletedRunId: run.status === 'completed' ? run.id : null,
    };
  }

  private async loadControlStateFacts(
    organizationId: string,
    scopeId: string | null,
  ): Promise<ComplianceControlStateFact[]> {
    if (!scopeId) return [];
    const rows = await this.db
      .select()
      .from(complianceControlStates)
      .where(and(
        eq(complianceControlStates.organizationId, organizationId),
        eq(complianceControlStates.scopeId, scopeId),
      ));

    return rows
      .filter((row) => isComplianceFrameworkKey(row.frameworkKey))
      .map((row) => ({
        frameworkKey: row.frameworkKey as ComplianceFrameworkKey,
        controlId: row.controlId,
        state: row.state,
        exclusionReason: row.exclusionReason,
        assignedToUserId: row.assignedToUserId,
        assignedByUserId: row.assignedByUserId,
        assignedAt: row.assignedAt,
        updatedAt: row.updatedAt,
      }));
  }

  private async loadControlCheckFacts(params: {
    organizationId: string;
    scopeId: string | null;
    runId?: string;
  }): Promise<ComplianceControlCheckFact[]> {
    const conditions = [eq(complianceControlChecks.organizationId, params.organizationId)];
    if (params.scopeId) conditions.push(eq(complianceControlChecks.scopeId, params.scopeId));
    if (params.runId) conditions.push(eq(complianceControlChecks.runId, params.runId));
    const rows = await this.db
      .select()
      .from(complianceControlChecks)
      .where(and(...conditions))
      .orderBy(desc(complianceControlChecks.createdAt))
      .limit(1_000);
    const reviewRows = rows.length > 0
      ? await this.db
          .select()
          .from(complianceControlCheckReviews)
          .where(inArray(complianceControlCheckReviews.checkId, rows.map((row) => row.id)))
          .orderBy(
            desc(complianceControlCheckReviews.createdAt),
            desc(complianceControlCheckReviews.id),
          )
      : [];
    const reviewsByCheckId = new Map<string, ComplianceControlCheckFact['reviews']>();
    for (const review of reviewRows) {
      const reviews = reviewsByCheckId.get(review.checkId) ?? [];
      reviews.push({
        id: review.id,
        reviewerUserId: review.reviewerUserId,
        decision: review.decision,
        reasonCode: review.reasonCode,
        note: review.note,
        createdAt: review.createdAt,
      });
      reviewsByCheckId.set(review.checkId, reviews);
    }

    return rows
      .filter((row) => isComplianceFrameworkKey(row.frameworkKey))
      .map((row) => ({
        id: row.id,
        frameworkKey: row.frameworkKey as ComplianceFrameworkKey,
        controlId: row.controlId,
        basis: row.basis,
        verdict: row.verdict,
        reasonCode: row.reasonCode,
        reason: row.reason,
        proofObligationId: row.proofObligationId,
        method: row.method,
        toolName: row.toolName,
        skillSlug: row.skillSlug,
        targetRef: row.targetRef,
        evidenceRefs: row.evidenceRefs,
        findingIds: row.findingIds,
        artifactIds: row.artifactIds,
        proof: row.proof,
        limitations: row.limitations,
        freshUntil: row.freshUntil,
        runId: row.runId,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        reviews: reviewsByCheckId.get(row.id) ?? [],
      }));
  }

  private async loadControlRequestFacts(params: {
    organizationId: string;
    scopeId: string | null;
    runId?: string;
  }): Promise<ComplianceControlRequestFact[]> {
    const conditions = [eq(complianceControlRequests.organizationId, params.organizationId)];
    if (params.scopeId) conditions.push(eq(complianceControlRequests.scopeId, params.scopeId));
    if (params.runId) conditions.push(eq(complianceControlRequests.runId, params.runId));
    const rows = await this.db
      .select()
      .from(complianceControlRequests)
      .where(and(...conditions))
      .orderBy(desc(complianceControlRequests.createdAt))
      .limit(500);

    return rows
      .filter((row) => isComplianceFrameworkKey(row.frameworkKey))
      .map((row) => ({
        id: row.id,
        frameworkKey: row.frameworkKey as ComplianceFrameworkKey,
        controlId: row.controlId,
        requestType: row.requestType,
        priority: row.priority,
        status: row.status,
        title: row.title,
        reason: row.reason,
        requestedEvidence: row.requestedEvidence,
        remediationHint: row.remediationHint,
        assignedToUserId: row.assignedToUserId,
        dueAt: row.dueAt,
        fulfillmentEvidenceItemId: row.fulfillmentEvidenceItemId,
        fulfillmentNote: row.fulfillmentNote,
        fulfilledByUserId: row.fulfilledByUserId,
        fulfilledAt: row.fulfilledAt,
        reviewControlCheckId: row.reviewControlCheckId,
        reviewNote: row.reviewNote,
        reviewedByActorType: row.reviewedByActorType,
        reviewedByActorId: row.reviewedByActorId,
        reviewedAt: row.reviewedAt,
        nextReverificationAt: row.nextReverificationAt,
        runId: row.runId,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }

  private async loadAcceptedRiskFacts(
    organizationId: string,
    scopeId: string | null,
  ): Promise<ComplianceAcceptedRiskFact[]> {
    const whereClause = scopeId
      ? and(
          eq(complianceAcceptedRisks.organizationId, organizationId),
          or(eq(complianceAcceptedRisks.scopeId, scopeId), isNull(complianceAcceptedRisks.scopeId)),
          eq(complianceAcceptedRisks.status, 'active'),
        )
      : and(eq(complianceAcceptedRisks.organizationId, organizationId), eq(complianceAcceptedRisks.status, 'active'));

    const rows = await this.db
      .select()
      .from(complianceAcceptedRisks)
      .where(whereClause)
      .orderBy(desc(complianceAcceptedRisks.approvedAt))
      .limit(500);

    return rows
      .filter((row) => isComplianceFrameworkKey(row.frameworkKey))
      .map((row) => ({
        id: row.id,
        frameworkKey: row.frameworkKey as ComplianceFrameworkKey,
        controlId: row.controlId,
        evidenceItemId: row.evidenceItemId,
        owner: row.owner,
        rationale: row.rationale,
        status: row.status,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt,
        expiresAt: row.expiresAt,
      }));
  }

  private async loadFindingsWithEvidence(whereClause: ReturnType<typeof eq> | ReturnType<typeof and> | ReturnType<typeof inArray>): Promise<ComplianceFindingFact[]> {
    const rows = await this.db
      .select({
        id: findings.id,
        title: findings.title,
        severity: findings.severity,
        state: findings.state,
        summary: findings.summary,
        businessImpact: findings.businessImpact,
        technicalAnalysis: findings.technicalAnalysis,
        remediation: findings.remediation,
        cweId: findings.cweId,
        cweIds: findings.cweIds,
        owaspCategory: findings.owaspCategory,
        assetValue: assets.value,
        lastSeenAt: findings.lastSeenAt,
      })
      .from(findings)
      .leftJoin(assets, eq(assets.id, findings.assetId))
      .where(and(whereClause, sql`${findings.state} <> 'dismissed'`))
      .orderBy(desc(findings.lastSeenAt))
      .limit(500);

    if (rows.length === 0) {
      return [];
    }

    const evidenceRows = await this.db
      .select({
        findingId: findingEvidence.findingId,
        kind: findingEvidence.kind,
        path: findingEvidence.path,
        displayPath: findingEvidence.displayPath,
        label: findingEvidence.label,
        fileMissing: findingEvidence.fileMissing,
        createdAt: findingEvidence.createdAt,
        sessionId: findingEvidence.sessionId,
      })
      .from(findingEvidence)
      .where(inArray(findingEvidence.findingId, rows.map((row) => row.id)))
      .orderBy(desc(findingEvidence.createdAt));

    const evidenceSessionIds = Array.from(
      new Set(
        evidenceRows
          .map((row) => row.sessionId)
          .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
      ),
    );

    const skillSlugsBySessionId = await this.loadAssignedSkillSlugsBySessionId(evidenceSessionIds);

    const evidenceByFinding = new Map<string, ComplianceFindingFact['evidence']>();
    const skillSlugsByFinding = new Map<string, Set<string>>();
    for (const row of evidenceRows) {
      const list = evidenceByFinding.get(row.findingId) ?? [];
      list.push(row);
      evidenceByFinding.set(row.findingId, list);
      if (row.sessionId) {
        const findingSkillSlugs = skillSlugsByFinding.get(row.findingId) ?? new Set<string>();
        for (const slug of skillSlugsBySessionId.get(row.sessionId) ?? []) {
          findingSkillSlugs.add(slug);
        }
        skillSlugsByFinding.set(row.findingId, findingSkillSlugs);
      }
    }

    return rows.map((row) => ({
      ...row,
      evidence: evidenceByFinding.get(row.id) ?? [],
      skillSlugs: Array.from(skillSlugsByFinding.get(row.id) ?? []).sort(),
    }));
  }

  private async loadAssignedSkillSlugsBySessionId(sessionIds: string[]): Promise<Map<string, string[]>> {
    const output = new Map<string, Set<string>>();
    const add = (sessionId: string | null, skillSlugs: string[] | null, mode: 'append' | 'if_missing' = 'append') => {
      if (!sessionId || !skillSlugs || skillSlugs.length === 0) return;
      if (mode === 'if_missing' && output.has(sessionId)) return;
      const existing = output.get(sessionId) ?? new Set<string>();
      for (const slug of skillSlugs) {
        const normalized = normalizeText(slug);
        if (normalized) existing.add(normalized);
      }
      output.set(sessionId, existing);
    };

    if (sessionIds.length === 0) {
      return new Map();
    }

    const [phaseRows, runRows] = await Promise.all([
      this.db
        .select({
          sessionId: runPhases.sessionId,
          assignedSkillSlugs: runPhases.assignedSkillSlugs,
        })
        .from(runPhases)
        .where(inArray(runPhases.sessionId, sessionIds)),
      this.db
        .select({
          sessionId: runs.sessionId,
          plannerSessionId: runs.plannerSessionId,
          executorSessionId: runs.executorSessionId,
          assignedSkillSlugs: runs.assignedSkillSlugs,
        })
        .from(runs)
        .where(
          or(
            inArray(runs.sessionId, sessionIds),
            inArray(runs.plannerSessionId, sessionIds),
            inArray(runs.executorSessionId, sessionIds),
          ),
        ),
    ]);

    for (const row of phaseRows) {
      add(row.sessionId, row.assignedSkillSlugs);
    }
    for (const row of runRows) {
      add(row.sessionId, row.assignedSkillSlugs, 'if_missing');
      add(row.plannerSessionId, row.assignedSkillSlugs, 'if_missing');
      add(row.executorSessionId, row.assignedSkillSlugs, 'if_missing');
    }

    return new Map(Array.from(output.entries()).map(([sessionId, slugs]) => [sessionId, Array.from(slugs).sort()]));
  }

  private async loadServicesForAssets(
    organizationId: string,
    assetIds: string[],
  ): Promise<ComplianceServiceFact[]> {
    if (assetIds.length === 0) {
      return [];
    }

    return this.db
      .select({
        id: inventoryServices.id,
        protocol: inventoryServices.protocol,
        port: inventoryServices.port,
        serviceName: inventoryServices.serviceName,
        product: inventoryServices.product,
        version: inventoryServices.version,
        lastSeenAt: inventoryServices.lastSeenAt,
      })
      .from(inventoryServices)
      .innerJoin(assets, eq(assets.id, inventoryServices.assetId))
      .where(and(eq(assets.organizationId, organizationId), inArray(inventoryServices.assetId, assetIds)))
      .orderBy(desc(inventoryServices.lastSeenAt))
      .limit(500);
  }

  private async collectRunSessionIds(run: typeof runs.$inferSelect): Promise<string[]> {
    const ids = new Set<string>();
    for (const value of [run.sessionId, run.plannerSessionId, run.executorSessionId]) {
      if (typeof value === 'string' && value.length > 0) ids.add(value);
    }
    const phaseRows = await this.db
      .select({ sessionId: runPhases.sessionId })
      .from(runPhases)
      .where(eq(runPhases.runId, run.id));
    for (const row of phaseRows) {
      if (row.sessionId) ids.add(row.sessionId);
    }
    return Array.from(ids);
  }
}
