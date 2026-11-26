import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { findingEvidence, findings, findingValidationAudit, inventoryNotes, runPhases } from '@/db/schema';
import {
  extractFindingValidationProofBundle,
  type FindingValidationProofBundle,
} from '@/domains/security-ops/findings/findingContracts';
import {
  RunReportRenderer,
  type ReportRendererCoverageSummary,
  type ReportRendererFindingEvidenceRow,
  type ReportRendererFindingRow,
  type ReportRendererNoteRow,
  type ReportRendererPlanStep,
  type ReportRendererRunCompletion,
  type ReportRendererRunPhaseRow,
  type ReportRendererState,
} from '@/domains/security-ops/tools/reporting/RunReportRenderer';
import { mergeRunFindingIds } from '@/domains/security-ops/tools/reporting/RunReportAuthority';

export type RunCompletion = ReportRendererRunCompletion;
export type FinalizerPlanStep = ReportRendererPlanStep;
export type FinalizerRunPhaseRow = ReportRendererRunPhaseRow;
export type FinalizerFindingRow = ReportRendererFindingRow;
export type FinalizerFindingEvidenceRow = ReportRendererFindingEvidenceRow;
export type FinalizerNoteRow = ReportRendererNoteRow;
export type FinalizerCoverageSummary = ReportRendererCoverageSummary;
export type FinalizerReportState = ReportRendererState;

const uniqueNonEmptyStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0),
    ),
  );

export class RunReportStateLoader {
  constructor(
    private readonly db: DatabaseClient,
    private readonly renderer: RunReportRenderer = new RunReportRenderer(),
  ) {}

  async buildReportState(params: {
    userId: string;
    organizationId: string;
    scopeId: string;
    sessionId?: string;
    runId?: string;
    complianceSourceRunId?: string;
    plan?: FinalizerPlanStep[];
    reportedFindingIds?: string[];
    shellJobs?: Record<string, unknown>;
    alreadyFinalized?: boolean;
  }): Promise<FinalizerReportState> {
    const reportSourceRunId = params.complianceSourceRunId ?? params.runId;
    const runPhaseRows = reportSourceRunId
      ? await this.loadRunPhases(reportSourceRunId)
      : [];
    const findingRows = await this.loadFindings({
      userId: params.userId,
      organizationId: params.organizationId,
      scopeId: params.scopeId,
      findingIds: params.reportedFindingIds ?? [],
      sessionId: params.sessionId,
      runId: reportSourceRunId,
      runPhaseRows,
    });
    const noteRows = await this.loadNotes({
      userId: params.userId,
      organizationId: params.organizationId,
      scopeId: params.scopeId,
      sessionId: params.sessionId,
      runId: reportSourceRunId,
      runPhaseRows,
    });
    const evidenceRows = await this.loadFindingEvidence(findingRows.map((row) => row.id));
    const validationProofsByFindingId = await this.loadLatestValidationProofs(findingRows.map((row) => row.id));
    const evidenceByFindingId = new Map<string, FinalizerFindingEvidenceRow[]>();
    for (const row of evidenceRows) {
      const list = evidenceByFindingId.get(row.findingId) ?? [];
      list.push(row);
      evidenceByFindingId.set(row.findingId, list);
    }
    const findingsWithEvidence = findingRows.map((row) => ({
      ...row,
      evidence: evidenceByFindingId.get(row.id) ?? [],
      validationProof: validationProofsByFindingId.get(row.id) ?? null,
    }));
    const durableEvidenceFindingIds = this.buildDurableEvidenceFindingIds(evidenceRows);
    const runCompletion = this.renderer.buildRunCompletion({
      plan: params.plan ?? [],
      findings: findingsWithEvidence,
      durableEvidenceFindingIds,
      finalized: params.alreadyFinalized === true,
      runPhaseRows,
    });
    const coverage = this.renderer.buildFinalizerCoverageSummary({
      plan: params.plan ?? [],
      findings: findingsWithEvidence,
      notes: noteRows,
      runCompletion,
      shellJobs: params.shellJobs,
    });

    return {
      organizationId: params.organizationId,
      scopeId: params.scopeId,
      findings: findingsWithEvidence,
      notes: noteRows,
      runCompletion,
      coverage,
    };
  }

  finalizerFindingHasDurableEvidence(finding: FinalizerFindingRow): boolean {
    return (finding.evidence ?? []).some((row) => row.kind === 'http_exchange' || row.fileMissing !== true);
  }

  private async loadFindings(params: {
    userId: string;
    organizationId: string;
    scopeId: string;
    findingIds: string[];
    sessionId?: string;
    runId?: string;
    runPhaseRows?: FinalizerRunPhaseRow[];
  }): Promise<FinalizerFindingRow[]> {
    const explicitFindingIds = uniqueNonEmptyStrings(params.findingIds);
    const shouldDiscoverRunFindingIds = Boolean(params.runId) || explicitFindingIds.length === 0;
    const sessionIds = new Set<string>();
    if (shouldDiscoverRunFindingIds) {
      if (params.sessionId) {
        sessionIds.add(params.sessionId);
      }
      if (params.runPhaseRows) {
        for (const row of params.runPhaseRows) {
          if (row.sessionId) {
            sessionIds.add(row.sessionId);
          }
        }
      } else if (params.runId) {
        const phaseRows = await this.db
          .select({ sessionId: runPhases.sessionId })
          .from(runPhases)
          .where(eq(runPhases.runId, params.runId));
        for (const row of phaseRows) {
          if (row.sessionId) {
            sessionIds.add(row.sessionId);
          }
        }
      }
    }

    let discoveredFindingIds: string[] = [];
    const sessionIdList = Array.from(sessionIds);
    if (sessionIdList.length > 0) {
      const evidenceFindingRows = await this.db
        .select({ findingId: findingEvidence.findingId })
        .from(findingEvidence)
        .where(inArray(findingEvidence.sessionId, sessionIdList));
      discoveredFindingIds = evidenceFindingRows.map((row) => row.findingId);
    }

    const findingIds = mergeRunFindingIds(explicitFindingIds, discoveredFindingIds);
    if (findingIds.length === 0) {
      return [];
    }

    return this.db
      .select({
        id: findings.id,
        assetId: sql<string>`${findings.assetId}`,
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
        cvssVector: findings.cvssVector,
        cvssScore: findings.cvssScore,
        confidenceScore: findings.confidenceScore,
        cweId: findings.cweId,
        cveId: findings.cveId,
        cweIds: findings.cweIds,
        cveIds: findings.cveIds,
        owaspCategory: findings.owaspCategory,
        endpointId: findings.endpointId,
        serviceId: findings.serviceId,
        codeLocations: findings.codeLocations,
        firstSeenAt: findings.firstSeenAt,
        lastSeenAt: findings.lastSeenAt,
        dedupeKey: findings.dedupeKey,
      })
      .from(findings)
      .where(
        and(
          eq(findings.userId, params.userId),
          eq(findings.organizationId, params.organizationId),
          eq(findings.scopeId, params.scopeId),
          eq(findings.sourceKind, 'assessment'),
          sql`${findings.assetId} is not null`,
          inArray(findings.id, findingIds),
          sql`${findings.state} <> 'dismissed'`,
        ),
      )
      .orderBy(desc(findings.lastSeenAt));
  }

  private async loadNotes(params: {
    userId: string;
    organizationId: string;
    scopeId: string;
    sessionId?: string;
    runId?: string;
    runPhaseRows?: FinalizerRunPhaseRow[];
  }): Promise<FinalizerNoteRow[]> {
    const sessionIds = new Set<string>();
    if (params.sessionId) {
      sessionIds.add(params.sessionId);
    }
    if (params.runPhaseRows) {
      for (const row of params.runPhaseRows) {
        if (row.sessionId) {
          sessionIds.add(row.sessionId);
        }
      }
    } else if (params.runId) {
      const phaseRows = await this.db
        .select({ sessionId: runPhases.sessionId })
        .from(runPhases)
        .where(eq(runPhases.runId, params.runId));
      for (const row of phaseRows) {
        if (row.sessionId) {
          sessionIds.add(row.sessionId);
        }
      }
    }

    const sessionIdList = Array.from(sessionIds);
    if (sessionIdList.length === 0) {
      return [];
    }

    return this.db
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
          eq(inventoryNotes.userId, params.userId),
          eq(inventoryNotes.organizationId, params.organizationId),
          eq(inventoryNotes.scopeId, params.scopeId),
          inArray(inventoryNotes.sessionId, sessionIdList),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(500);
  }

  private async loadRunPhases(runId: string): Promise<FinalizerRunPhaseRow[]> {
    return this.db
      .select({
        id: runPhases.id,
        phaseKey: runPhases.phaseKey,
        status: runPhases.status,
        sessionId: runPhases.sessionId,
        lastError: runPhases.lastError,
      })
      .from(runPhases)
      .where(eq(runPhases.runId, runId))
      .orderBy(runPhases.ordinal);
  }

  private async loadFindingEvidence(findingIds: string[]): Promise<FinalizerFindingEvidenceRow[]> {
    if (findingIds.length === 0) {
      return [];
    }

    return this.db
      .select({
        findingId: findingEvidence.findingId,
        kind: findingEvidence.kind,
        path: findingEvidence.path,
        displayPath: findingEvidence.displayPath,
        label: findingEvidence.label,
        excerpt: findingEvidence.excerpt,
        fileMissing: findingEvidence.fileMissing,
        data: findingEvidence.data,
        createdAt: findingEvidence.createdAt,
      })
      .from(findingEvidence)
      .where(inArray(findingEvidence.findingId, findingIds))
      .orderBy(desc(findingEvidence.createdAt));
  }

  private async loadLatestValidationProofs(findingIds: string[]): Promise<Map<string, FindingValidationProofBundle>> {
    const proofByFindingId = new Map<string, FindingValidationProofBundle>();
    if (findingIds.length === 0) {
      return proofByFindingId;
    }

    const rows = await this.db
      .select({
        findingId: findingValidationAudit.findingId,
        evidenceRefs: findingValidationAudit.evidenceRefs,
      })
      .from(findingValidationAudit)
      .where(inArray(findingValidationAudit.findingId, findingIds))
      .orderBy(desc(findingValidationAudit.completedAt));

    for (const row of rows) {
      if (proofByFindingId.has(row.findingId)) {
        continue;
      }
      const proof = extractFindingValidationProofBundle(row.evidenceRefs);
      if (proof) {
        proofByFindingId.set(row.findingId, proof);
      }
    }
    return proofByFindingId;
  }

  private buildDurableEvidenceFindingIds(evidenceRows: FinalizerFindingEvidenceRow[]): Set<string> {
    const durable = new Set<string>();
    for (const row of evidenceRows) {
      if (row.kind === 'http_exchange' || row.fileMissing !== true) {
        durable.add(row.findingId);
      }
    }
    return durable;
  }
}
