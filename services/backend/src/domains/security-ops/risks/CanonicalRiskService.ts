import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  findings,
  type RiskSourceKind,
  type RiskState,
} from '@/db/schema';

export type RiskDbExecutor =
  | DatabaseClient
  | Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export type UpsertCanonicalRiskInput = {
  existingRiskId?: string | null;
  organizationId: string;
  scopeId: string;
  creatorUserId?: string | null;
  assetId?: string | null;
  repositoryId?: string | null;
  sourceKind: RiskSourceKind;
  sourceKey: string;
  state: RiskState;
  title: string;
  severity: string;
  summary: string;
  businessImpact?: string | null;
  technicalAnalysis?: string | null;
  pocDescription?: string | null;
  remediation?: string | null;
  cvssVector?: string | null;
  cvssScore?: number | null;
  confidenceScore?: number | null;
  cweId?: string | null;
  cweIds?: string[] | null;
  cveId?: string | null;
  cveIds?: string[] | null;
  now?: Date;
};

/**
 * The only shared writer used when a source workflow becomes a customer Risk.
 * Source-specific proof stays on its source row; this service owns identity and
 * the one customer lifecycle.
 */
export class CanonicalRiskService {
  constructor(
    private readonly database: RiskDbExecutor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async upsert(input: UpsertCanonicalRiskInput): Promise<string> {
    const now = input.now ?? this.clock();
    if (input.existingRiskId) {
      const [updated] = await this.database
        .update(findings)
        .set({
          scopeId: input.scopeId,
          assetId: input.assetId ?? null,
          repositoryId: input.repositoryId ?? null,
          dedupeKey: input.sourceKey,
          title: input.title,
          severity: input.severity,
          summary: input.summary,
          businessImpact: input.businessImpact ?? null,
          technicalAnalysis: input.technicalAnalysis ?? null,
          pocDescription: input.pocDescription ?? null,
          remediation: input.remediation ?? null,
          cvssVector: input.cvssVector ?? null,
          cvssScore: input.cvssScore ?? null,
          confidenceScore: input.confidenceScore ?? null,
          cweId: input.cweId ?? null,
          cweIds: input.cweIds ?? null,
          cveId: input.cveId ?? null,
          cveIds: input.cveIds ?? null,
          state: sql<RiskState>`case when ${findings.state} = 'accepted' then 'accepted' else ${input.state} end`,
          lastSeenAt: now,
          updatedAt: now,
          lifecycleVersion: sql`${findings.lifecycleVersion} + 1`,
        })
        .where(and(
          eq(findings.id, input.existingRiskId),
          eq(findings.organizationId, input.organizationId),
          eq(findings.scopeId, input.scopeId),
          eq(findings.sourceKind, input.sourceKind),
          input.repositoryId
            ? or(isNull(findings.repositoryId), eq(findings.repositoryId, input.repositoryId))
            : isNull(findings.repositoryId),
        ))
        .returning({ id: findings.id });
      if (!updated) {
        throw new Error('Explicit existing Risk does not belong to this organization, scope, and source');
      }
      return updated.id;
    }

    const [risk] = await this.database
      .insert(findings)
      .values({
        organizationId: input.organizationId,
        scopeId: input.scopeId,
        userId: input.creatorUserId ?? null,
        assetId: input.assetId ?? null,
        repositoryId: input.repositoryId ?? null,
        sourceKind: input.sourceKind,
        dedupeKey: input.sourceKey,
        state: input.state,
        title: input.title,
        severity: input.severity,
        summary: input.summary,
        businessImpact: input.businessImpact ?? null,
        technicalAnalysis: input.technicalAnalysis ?? null,
        pocDescription: input.pocDescription ?? null,
        remediation: input.remediation ?? null,
        cvssVector: input.cvssVector ?? null,
        cvssScore: input.cvssScore ?? null,
        confidenceScore: input.confidenceScore ?? null,
        cweId: input.cweId ?? null,
        cweIds: input.cweIds ?? null,
        cveId: input.cveId ?? null,
        cveIds: input.cveIds ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [findings.organizationId, findings.sourceKind, findings.dedupeKey],
        set: {
          scopeId: input.scopeId,
          assetId: input.assetId ?? null,
          repositoryId: input.repositoryId ?? null,
          title: input.title,
          severity: input.severity,
          summary: input.summary,
          businessImpact: input.businessImpact ?? null,
          technicalAnalysis: input.technicalAnalysis ?? null,
          pocDescription: input.pocDescription ?? null,
          remediation: input.remediation ?? null,
          cvssVector: input.cvssVector ?? null,
          cvssScore: input.cvssScore ?? null,
          confidenceScore: input.confidenceScore ?? null,
          cweId: input.cweId ?? null,
          cweIds: input.cweIds ?? null,
          cveId: input.cveId ?? null,
          cveIds: input.cveIds ?? null,
          // An accepted Risk stays accepted while its source remains present.
          // A resolved or dismissed source that is proven again reopens.
          state: sql<RiskState>`case when ${findings.state} = 'accepted' then 'accepted' else ${input.state} end`,
          lastSeenAt: now,
          updatedAt: now,
          lifecycleVersion: sql`${findings.lifecycleVersion} + 1`,
        },
      })
      .returning({ id: findings.id });

    if (!risk) throw new Error('Canonical Risk upsert did not return a row');
    return risk.id;
  }

  async transition(params: {
    organizationId: string;
    riskId: string;
    from?: readonly RiskState[];
    to: RiskState;
    now?: Date;
  }): Promise<boolean> {
    const now = params.now ?? this.clock();
    const conditions = [
      eq(findings.id, params.riskId),
      eq(findings.organizationId, params.organizationId),
    ];
    if (params.from && params.from.length > 0) {
      conditions.push(inArray(findings.state, [...params.from]));
    }
    const [updated] = await this.database
      .update(findings)
      .set({
        state: params.to,
        updatedAt: now,
        lifecycleVersion: sql`${findings.lifecycleVersion} + 1`,
      })
      .where(and(...conditions))
      .returning({ id: findings.id });
    return Boolean(updated);
  }
}
