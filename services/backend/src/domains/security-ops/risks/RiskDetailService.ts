import { and, desc, eq } from 'drizzle-orm';

import { db, type DatabaseClient } from '@/db/client';
import {
  advisories,
  assets,
  codeReviewFindings,
  exposureMatches,
  findings,
  inventoryComponents,
  scopes,
  type RiskSourceKind,
  type RiskState,
} from '@/db/schema';

export type RiskCodeOccurrenceDetail = {
  id: string;
  runId: string;
  repositoryFullName: string;
  commitSha: string;
  firstSeenCommitSha: string;
  lastSeenCommitSha: string;
  supersedesFindingId: string | null;
  version: number;
  fingerprintVersion: number;
  locations: (typeof codeReviewFindings.$inferSelect)['locations'];
  changeAttribution: string;
  attributionRationale: string | null;
  validation: (typeof codeReviewFindings.$inferSelect)['validation'];
  fixability: string;
  fixabilityRationale: string | null;
};

type RiskDetailCommon = {
  id: string;
  sourceKind: RiskSourceKind;
  state: RiskState;
  title: string;
  severity: string;
  summary: string;
  businessImpact: string | null;
  technicalAnalysis: string | null;
  remediation: string | null;
  cvssVector: string | null;
  cvssScore: number | null;
  cweIds: string[];
  cveIds: string[];
  scope: { id: string; name: string };
  asset: { id: string; kind: string; value: string } | null;
  repositoryId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  codeOccurrence: RiskCodeOccurrenceDetail | null;
  exposureSource: {
    id: string;
    state: string;
    advisoryId: string;
    componentName: string;
    componentVersion: string | null;
    verifiedAt: Date | null;
  } | null;
  sourceDetailsRestricted: boolean;
};

export type CanonicalRiskDetail = RiskDetailCommon & {
  detailKind: 'canonical_risk';
  canonicalRiskId: string;
};

export type CodeOccurrenceRiskDetail = RiskDetailCommon & {
  detailKind: 'code_occurrence';
  canonicalRiskId: string | null;
};

export const codeOccurrenceRiskState = (
  state: (typeof codeReviewFindings.$inferSelect)['state'],
): RiskState => {
  if (state === 'validated') return 'confirmed';
  if (state === 'rejected') return 'dismissed';
  return 'potential';
};

export class RiskDetailService {
  constructor(private readonly database: DatabaseClient = db) {}

  async read(params: {
    organizationId: string;
    riskId: string;
    includeCodeSource: boolean;
    includeExposureSource: boolean;
  }): Promise<CanonicalRiskDetail | null> {
    const [risk] = await this.database
      .select({
        id: findings.id,
        sourceKind: findings.sourceKind,
        state: findings.state,
        title: findings.title,
        severity: findings.severity,
        summary: findings.summary,
        businessImpact: findings.businessImpact,
        technicalAnalysis: findings.technicalAnalysis,
        remediation: findings.remediation,
        cvssVector: findings.cvssVector,
        cvssScore: findings.cvssScore,
        cweId: findings.cweId,
        cweIds: findings.cweIds,
        cveId: findings.cveId,
        cveIds: findings.cveIds,
        scopeId: findings.scopeId,
        scopeName: scopes.name,
        assetId: assets.id,
        assetKind: assets.kind,
        assetValue: assets.value,
        repositoryId: findings.repositoryId,
        firstSeenAt: findings.firstSeenAt,
        lastSeenAt: findings.lastSeenAt,
      })
      .from(findings)
      .innerJoin(scopes, eq(scopes.id, findings.scopeId))
      .leftJoin(assets, eq(assets.id, findings.assetId))
      .where(and(
        eq(findings.id, params.riskId),
        eq(findings.organizationId, params.organizationId),
      ))
      .limit(1);
    if (!risk) return null;

    const codeOccurrence = risk.sourceKind === 'code_review' && params.includeCodeSource
      ? await this.database
          .select({
            id: codeReviewFindings.id,
            runId: codeReviewFindings.runId,
            repositoryFullName: codeReviewFindings.repositoryFullName,
            commitSha: codeReviewFindings.commitSha,
            firstSeenCommitSha: codeReviewFindings.firstSeenCommitSha,
            lastSeenCommitSha: codeReviewFindings.lastSeenCommitSha,
            supersedesFindingId: codeReviewFindings.supersedesFindingId,
            version: codeReviewFindings.version,
            fingerprintVersion: codeReviewFindings.fingerprintVersion,
            locations: codeReviewFindings.locations,
            changeAttribution: codeReviewFindings.changeAttribution,
            attributionRationale: codeReviewFindings.attributionRationale,
            validation: codeReviewFindings.validation,
            fixability: codeReviewFindings.fixability,
            fixabilityRationale: codeReviewFindings.fixabilityRationale,
          })
          .from(codeReviewFindings)
          .where(and(
            eq(codeReviewFindings.organizationId, params.organizationId),
            eq(codeReviewFindings.riskId, risk.id),
            eq(codeReviewFindings.state, 'validated'),
          ))
          .orderBy(desc(codeReviewFindings.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;

    const exposureSource = risk.sourceKind === 'advisory_verification' && params.includeExposureSource
      ? await this.database
          .select({
            id: exposureMatches.id,
            state: exposureMatches.state,
            advisoryId: advisories.canonicalId,
            componentName: inventoryComponents.displayName,
            componentVersion: inventoryComponents.resolvedVersion,
            verifiedAt: exposureMatches.verifiedAt,
          })
          .from(exposureMatches)
          .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
          .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
          .where(and(
            eq(exposureMatches.organizationId, params.organizationId),
            eq(exposureMatches.riskId, risk.id),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;

    return {
      detailKind: 'canonical_risk',
      canonicalRiskId: risk.id,
      id: risk.id,
      sourceKind: risk.sourceKind,
      state: risk.state,
      title: risk.title,
      severity: risk.severity,
      summary: risk.summary,
      businessImpact: risk.businessImpact,
      technicalAnalysis: risk.technicalAnalysis,
      remediation: risk.remediation,
      cvssVector: risk.cvssVector,
      cvssScore: risk.cvssScore,
      cweIds: Array.from(new Set([risk.cweId, ...(risk.cweIds ?? [])].filter((id): id is string => Boolean(id)))),
      cveIds: Array.from(new Set([risk.cveId, ...(risk.cveIds ?? [])].filter((id): id is string => Boolean(id)))),
      scope: { id: risk.scopeId, name: risk.scopeName },
      asset: risk.assetId && risk.assetKind && risk.assetValue
        ? { id: risk.assetId, kind: risk.assetKind, value: risk.assetValue }
        : null,
      repositoryId: risk.repositoryId,
      firstSeenAt: risk.firstSeenAt,
      lastSeenAt: risk.lastSeenAt,
      codeOccurrence,
      exposureSource,
      sourceDetailsRestricted:
        (risk.sourceKind === 'code_review' && !params.includeCodeSource)
        || (risk.sourceKind === 'advisory_verification' && !params.includeExposureSource),
    };
  }

  async readCodeOccurrence(params: {
    organizationId: string;
    occurrenceId: string;
  }): Promise<CodeOccurrenceRiskDetail | null> {
    const [occurrence] = await this.database
      .select({
        id: codeReviewFindings.id,
        riskId: codeReviewFindings.riskId,
        scopeId: codeReviewFindings.scopeId,
        scopeName: scopes.name,
        state: codeReviewFindings.state,
        title: codeReviewFindings.title,
        severity: codeReviewFindings.severity,
        summary: codeReviewFindings.summary,
        impact: codeReviewFindings.impact,
        category: codeReviewFindings.category,
        remediation: codeReviewFindings.remediation,
        repositoryId: codeReviewFindings.repositoryId,
        runId: codeReviewFindings.runId,
        repositoryFullName: codeReviewFindings.repositoryFullName,
        commitSha: codeReviewFindings.commitSha,
        firstSeenCommitSha: codeReviewFindings.firstSeenCommitSha,
        lastSeenCommitSha: codeReviewFindings.lastSeenCommitSha,
        supersedesFindingId: codeReviewFindings.supersedesFindingId,
        version: codeReviewFindings.version,
        fingerprintVersion: codeReviewFindings.fingerprintVersion,
        locations: codeReviewFindings.locations,
        changeAttribution: codeReviewFindings.changeAttribution,
        attributionRationale: codeReviewFindings.attributionRationale,
        validation: codeReviewFindings.validation,
        fixability: codeReviewFindings.fixability,
        fixabilityRationale: codeReviewFindings.fixabilityRationale,
        createdAt: codeReviewFindings.createdAt,
        updatedAt: codeReviewFindings.updatedAt,
      })
      .from(codeReviewFindings)
      .innerJoin(scopes, eq(scopes.id, codeReviewFindings.scopeId))
      .where(and(
        eq(codeReviewFindings.id, params.occurrenceId),
        eq(codeReviewFindings.organizationId, params.organizationId),
      ))
      .limit(1);
    if (!occurrence) return null;

    return {
      detailKind: 'code_occurrence',
      canonicalRiskId: occurrence.riskId,
      id: occurrence.id,
      sourceKind: 'code_review',
      state: codeOccurrenceRiskState(occurrence.state),
      title: occurrence.title,
      severity: occurrence.severity,
      summary: occurrence.summary,
      businessImpact: occurrence.impact,
      technicalAnalysis: occurrence.category,
      remediation: occurrence.remediation,
      cvssVector: null,
      cvssScore: null,
      cweIds: [],
      cveIds: [],
      scope: { id: occurrence.scopeId, name: occurrence.scopeName },
      asset: null,
      repositoryId: occurrence.repositoryId,
      firstSeenAt: occurrence.createdAt,
      lastSeenAt: occurrence.updatedAt,
      codeOccurrence: {
        id: occurrence.id,
        runId: occurrence.runId,
        repositoryFullName: occurrence.repositoryFullName,
        commitSha: occurrence.commitSha,
        firstSeenCommitSha: occurrence.firstSeenCommitSha,
        lastSeenCommitSha: occurrence.lastSeenCommitSha,
        supersedesFindingId: occurrence.supersedesFindingId,
        version: occurrence.version,
        fingerprintVersion: occurrence.fingerprintVersion,
        locations: occurrence.locations,
        changeAttribution: occurrence.changeAttribution,
        attributionRationale: occurrence.attributionRationale,
        validation: occurrence.validation,
        fixability: occurrence.fixability,
        fixabilityRationale: occurrence.fixabilityRationale,
      },
      exposureSource: null,
      sourceDetailsRestricted: false,
    };
  }
}
