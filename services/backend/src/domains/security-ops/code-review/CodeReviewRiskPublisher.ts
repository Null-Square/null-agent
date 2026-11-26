import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import {
  codeReviewFindings,
  findings,
  type CodeReviewContext,
  type CodeReviewFindingRow,
} from '@/db/schema';
import {
  CanonicalRiskService,
  type RiskDbExecutor,
} from '@/domains/security-ops/risks/CanonicalRiskService';

export const CODE_RISK_FINGERPRINT_VERSION = 1;

export const codeReviewCanPublishRisks = (params: {
  context: CodeReviewContext;
  reportCompleteness: string;
}): boolean => {
  const { context } = params;
  return context.operation === 'repository_review'
    && params.reportCompleteness === 'complete'
    && context.reviewScope.completeness === 'complete'
    && context.repository.requestedRef?.trim()
      === context.repository.defaultBranch.trim();
};

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '');

const pathInside = (path: string, boundary: string): boolean =>
  path === boundary || path.startsWith(`${boundary}/`);

export const codeLocationCovered = (
  filePath: string,
  reviewScope: CodeReviewContext['reviewScope'],
): boolean => {
  const path = normalizePath(filePath);
  const excluded = reviewScope.excludedPaths.map(normalizePath).filter(Boolean);
  if (excluded.some((boundary) => pathInside(path, boundary))) return false;
  const allowed = reviewScope.allowedPaths.map(normalizePath).filter(Boolean);
  return allowed.length === 0 || allowed.some((boundary) => pathInside(path, boundary));
};

/** Publishes complete default-branch occurrences and resolves proven absence. */
export class CodeReviewRiskPublisher {
  constructor(
    private readonly database: RiskDbExecutor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async publish(params: {
    organizationId: string;
    scopeId: string;
    context: CodeReviewContext;
    reportCompleteness: string;
    occurrences: CodeReviewFindingRow[];
    now?: Date;
  }): Promise<{ published: number; resolved: number }> {
    if (!codeReviewCanPublishRisks(params)) return { published: 0, resolved: 0 };

    const now = params.now ?? this.clock();
    const currentRiskIds = new Set<string>();
    const riskWriter = new CanonicalRiskService(this.database, () => now);

    for (const occurrence of params.occurrences) {
      if (occurrence.state !== 'validated') continue;
      const riskId = await riskWriter.upsert({
        existingRiskId: occurrence.riskId,
        organizationId: params.organizationId,
        scopeId: params.scopeId,
        repositoryId: params.context.repository.repositoryId,
        sourceKind: 'code_review',
        sourceKey: [
          'code-review',
          `v${occurrence.fingerprintVersion}`,
          params.scopeId,
          params.context.repository.repositoryId,
          occurrence.fingerprint,
        ].join(':'),
        state: 'confirmed',
        title: occurrence.title,
        severity: occurrence.severity,
        summary: occurrence.summary,
        businessImpact: occurrence.impact,
        technicalAnalysis: occurrence.category,
        remediation: occurrence.remediation,
        confidenceScore: occurrence.confidence,
        now,
      });
      currentRiskIds.add(riskId);
      if (occurrence.riskId !== riskId) {
        await this.database
          .update(codeReviewFindings)
          .set({ riskId, updatedAt: now })
          .where(and(
            eq(codeReviewFindings.id, occurrence.id),
            eq(codeReviewFindings.organizationId, params.organizationId),
          ));
      }
    }

    const previous = await this.database
      .select({
        riskId: codeReviewFindings.riskId,
        locations: codeReviewFindings.locations,
      })
      .from(codeReviewFindings)
      .where(and(
        eq(codeReviewFindings.organizationId, params.organizationId),
        eq(codeReviewFindings.scopeId, params.scopeId),
        eq(codeReviewFindings.repositoryId, params.context.repository.repositoryId),
        isNotNull(codeReviewFindings.riskId),
      ));

    const priorLocationsByRisk = new Map<string, CodeReviewFindingRow['locations']>();
    for (const row of previous) {
      if (!row.riskId || currentRiskIds.has(row.riskId)) continue;
      const knownLocations = priorLocationsByRisk.get(row.riskId) ?? [];
      priorLocationsByRisk.set(row.riskId, [...knownLocations, ...(row.locations ?? [])]);
    }

    const absentRiskIds = new Set<string>();
    for (const [riskId, locations] of priorLocationsByRisk) {
      if (locations.length > 0
        && locations.every((location) => codeLocationCovered(location.filePath, params.context.reviewScope))) {
        absentRiskIds.add(riskId);
      }
    }

    if (absentRiskIds.size === 0) {
      return { published: currentRiskIds.size, resolved: 0 };
    }

    const resolved = await this.database
      .update(findings)
      .set({
        state: 'resolved',
        updatedAt: now,
        lifecycleVersion: sql`${findings.lifecycleVersion} + 1`,
      })
      .where(and(
        eq(findings.organizationId, params.organizationId),
        eq(findings.sourceKind, 'code_review'),
        inArray(findings.id, [...absentRiskIds]),
        inArray(findings.state, ['potential', 'verifying', 'confirmed', 'not_reproduced', 'accepted']),
      ))
      .returning({ id: findings.id });

    return { published: currentRiskIds.size, resolved: resolved.length };
  }
}
