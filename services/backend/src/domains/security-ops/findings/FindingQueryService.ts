import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { assets, findings, findingValidationAudit, type RiskState } from '@/db/schema';
import { assetTenancyClause } from '@/domains/security-ops/assets/assetScopeFilter';
import {
  extractFindingValidationProofBundle,
  type FindingValidationProofBundle,
} from '@/domains/security-ops/findings/findingContracts';
import {
  buildFindingReportCompleteness,
  type FinalReportAdvisoryField,
  type FinalReportRequiredField,
  type FindingReportCompleteness,
} from '@/domains/security-ops/findings/findingReportCompleteness';

const AssetRefSchema = z.object({
  kind: z.enum(['domain', 'ip']),
  value: z.string().min(1),
});

export const QueryFindingsSchema = z.object({
  assetRef: AssetRefSchema.optional(),
  state: z.enum(['potential', 'verifying', 'confirmed', 'not_reproduced', 'dismissed', 'resolved', 'accepted', 'all']).optional().default('all'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info', 'all']).optional().default('all'),
});

type FindingQueryContext = {
  organizationId?: string;
  scopeId?: string;
};

type FindingQueryHelpers = {
  normalizeAssetValue: (kind: z.infer<typeof AssetRefSchema>['kind'], rawValue: string) => string;
  validateIpAssetRefOrThrow: (value: string, toolName: 'query_findings') => void;
  mergeStringSet: (existing: string[] | null | undefined, incoming: string[] | null | undefined) => string[];
};

export type QueryFindingsResult = {
  findings: Array<{
    id: string;
    title: string;
    severity: string;
    state: RiskState;
    assetValue: string;
    summary: string;
    businessImpact: string | null;
    technicalAnalysis: string | null;
    pocDescription: string | null;
    assumptions: string | null;
    remediation: string | null;
    fixEffort: string | null;
    cweIds: string[];
    owaspCategory: string | null;
    cvssVector: string | null;
    cvssScore: number | null;
    reportCompleteness: FindingReportCompleteness;
    missingReportFields: FinalReportRequiredField[];
    advisoryMissingFields: FinalReportAdvisoryField[];
    revalidationHint: string;
    validationProof: FindingValidationProofBundle | null;
    lastSeenAt: string;
  }>;
  totalCount: number;
};

const isSqlClause = (clause: SQL<unknown> | undefined): clause is SQL<unknown> =>
  clause !== undefined;

export class FindingQueryService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly helpers: FindingQueryHelpers,
  ) {}

  async queryFindings(params: {
    userId: string;
    context?: FindingQueryContext;
    input: unknown;
  }): Promise<QueryFindingsResult> {
    const parsed = QueryFindingsSchema.parse(params.input);
    const context = params.context ?? {};

    let assetId: string | undefined;
    if (parsed.assetRef) {
      const normalizedValue = this.helpers.normalizeAssetValue(parsed.assetRef.kind, parsed.assetRef.value);
      if (parsed.assetRef.kind === 'ip') {
        this.helpers.validateIpAssetRefOrThrow(normalizedValue, 'query_findings');
      }
      const [asset] = await this.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            context.organizationId
              ? assetTenancyClause({
                  organizationId: context.organizationId,
                  scopeId: context.scopeId,
                })
              : undefined,
            eq(assets.kind, parsed.assetRef.kind),
            eq(assets.value, normalizedValue),
          ),
        )
        .limit(1);
      if (!asset) {
        return { findings: [], totalCount: 0 };
      }
      assetId = asset.id;
    }

    const whereClauses = [
      eq(findings.userId, params.userId),
      context.organizationId ? eq(findings.organizationId, context.organizationId) : undefined,
      eq(findings.sourceKind, 'assessment'),
      context.scopeId ? eq(findings.scopeId, context.scopeId) : undefined,
      assetId ? eq(findings.assetId, assetId) : undefined,
      parsed.state !== 'all' ? eq(findings.state, parsed.state) : undefined,
      parsed.severity !== 'all' ? eq(findings.severity, parsed.severity) : undefined,
    ].filter(isSqlClause);

    const rows = await this.db
      .select({
        id: findings.id,
        title: findings.title,
        severity: findings.severity,
        state: findings.state,
        assetValue: assets.value,
        summary: findings.summary,
        businessImpact: findings.businessImpact,
        technicalAnalysis: findings.technicalAnalysis,
        pocDescription: findings.pocDescription,
        assumptions: findings.assumptions,
        remediation: findings.remediation,
        fixEffort: findings.fixEffort,
        cweIds: findings.cweIds,
        cweId: findings.cweId,
        owaspCategory: findings.owaspCategory,
        cvssVector: findings.cvssVector,
        cvssScore: findings.cvssScore,
        lastSeenAt: findings.lastSeenAt,
      })
      .from(findings)
      .innerJoin(assets, eq(findings.assetId, assets.id))
      .where(and(...whereClauses))
      .orderBy(desc(findings.lastSeenAt))
      .limit(500);

    const validationProofsByFindingId = await this.loadLatestValidationProofs(rows.map((row) => row.id));
    const mapped = rows.map((row) => {
      const cweIds = this.helpers.mergeStringSet(row.cweIds, row.cweId ? [row.cweId] : []);
      const reportCompleteness = buildFindingReportCompleteness({
        id: row.id,
        title: row.title,
        businessImpact: row.businessImpact,
        technicalAnalysis: row.technicalAnalysis,
        pocDescription: row.pocDescription,
        assumptions: row.assumptions,
        remediation: row.remediation,
        fixEffort: row.fixEffort,
        cweId: row.cweId,
        cweIds,
        owaspCategory: row.owaspCategory,
        cvssVector: row.cvssVector,
        cvssScore: row.cvssScore,
      });
      return {
        id: row.id,
        title: row.title,
        severity: row.severity,
        state: row.state,
        assetValue: row.assetValue,
        summary: row.summary,
        businessImpact: row.businessImpact ?? null,
        technicalAnalysis: row.technicalAnalysis ?? null,
        pocDescription: row.pocDescription ?? null,
        assumptions: row.assumptions ?? null,
        remediation: row.remediation ?? null,
        fixEffort: row.fixEffort ?? null,
        cweIds,
        owaspCategory: row.owaspCategory ?? null,
        cvssVector: row.cvssVector ?? null,
        cvssScore: row.cvssScore ?? null,
        reportCompleteness,
        missingReportFields: reportCompleteness.missingReportFields,
        advisoryMissingFields: reportCompleteness.advisoryMissingFields,
        revalidationHint:
          `If you are re-verifying this finding with fresh evidence, call report_finding with validatesFindingId="${row.id}" instead of creating a new finding.`,
        validationProof: validationProofsByFindingId.get(row.id) ?? null,
        lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : String(row.lastSeenAt),
      };
    });

    return { findings: mapped, totalCount: mapped.length };
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
      .where(and(inArray(findingValidationAudit.findingId, findingIds)))
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
}
