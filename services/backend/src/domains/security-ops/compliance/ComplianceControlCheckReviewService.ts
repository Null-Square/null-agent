import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import {
  auditLogs,
  complianceControlCheckReviews,
  complianceControlChecks,
  runs,
} from '@/db/schema';

import {
  ComplianceReadinessService,
  type ComplianceControlCheckReviewDecision,
  type ComplianceReadinessResponse,
} from './ComplianceReadinessService';

export const ControlCheckReviewReasonCodeSchema = z.enum([
  'proof_valid',
  'evidence_mismatch',
  'insufficient_scope',
  'unsupported_reasoning',
  'stale_or_unreproducible',
  'retest_after_remediation',
  'other',
]);

export const RecordControlCheckReviewSchema = z.object({
  decision: z.enum(['confirmed', 'rejected', 'retest_required']),
  reasonCode: ControlCheckReviewReasonCodeSchema,
  note: z.string().trim().min(8).max(2_000),
}).superRefine((value, context) => {
  if (value.decision === 'confirmed' && value.reasonCode !== 'proof_valid' && value.reasonCode !== 'other') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reasonCode'],
      message: 'Confirmed proof requires proof_valid or other',
    });
  }
  if (
    value.decision === 'retest_required' &&
    value.reasonCode !== 'retest_after_remediation' &&
    value.reasonCode !== 'stale_or_unreproducible' &&
    value.reasonCode !== 'other'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reasonCode'],
      message: 'Retest decisions require a retest or freshness reason',
    });
  }
});

export type RecordControlCheckReviewInput = z.infer<typeof RecordControlCheckReviewSchema>;

export type ComplianceRunReviewResponse = {
  readiness: ComplianceReadinessResponse;
  sessionContributions: Array<{
    sessionId: string;
    total: number;
    checkIds: string[];
    passed: number;
    failed: number;
    needsContext: number;
    notAttempted: number;
    unreviewed: number;
    confirmed: number;
    rejected: number;
    retestRequired: number;
  }>;
};

const focusRunReadiness = (
  readiness: ComplianceReadinessResponse,
  frameworkKey: string | null,
): ComplianceReadinessResponse => {
  if (!frameworkKey) {
    return readiness;
  }
  const framework = readiness.frameworks.find((item) => item.key === frameworkKey);
  if (!framework) {
    return readiness;
  }
  return {
    ...readiness,
    selectedFrameworks: readiness.selectedFrameworks.filter((item) => item.key === frameworkKey),
    supportedFrameworks: readiness.supportedFrameworks.filter((item) => item === frameworkKey),
    frameworks: [framework],
  };
};

export class ComplianceControlCheckReviewService {
  private readonly readinessService: ComplianceReadinessService;

  constructor(private readonly db: DatabaseClient) {
    this.readinessService = new ComplianceReadinessService(db);
  }

  async getRunReview(params: {
    organizationId: string;
    runId: string;
  }): Promise<ComplianceRunReviewResponse | null> {
    const [run] = await this.db
      .select({ id: runs.id, complianceFrameworkKey: runs.complianceFrameworkKey })
      .from(runs)
      .where(and(eq(runs.id, params.runId), eq(runs.organizationId, params.organizationId)))
      .limit(1);
    if (!run) return null;

    const readiness = focusRunReadiness(
      await this.readinessService.getRunReadiness(params),
      run.complianceFrameworkKey,
    );
    const checks = readiness.frameworks.flatMap((framework) =>
      framework.controls.flatMap((control) => control.controlChecks),
    );
    const bySession = new Map<string, ComplianceRunReviewResponse['sessionContributions'][number]>();
    for (const check of checks) {
      const contribution = bySession.get(check.sessionId) ?? {
        sessionId: check.sessionId,
        total: 0,
        checkIds: [],
        passed: 0,
        failed: 0,
        needsContext: 0,
        notAttempted: 0,
        unreviewed: 0,
        confirmed: 0,
        rejected: 0,
        retestRequired: 0,
      };
      contribution.total += 1;
      contribution.checkIds.push(check.id);
      if (check.verdict === 'pass') contribution.passed += 1;
      if (check.verdict === 'fail') contribution.failed += 1;
      if (check.verdict === 'needs_context') contribution.needsContext += 1;
      if (check.verdict === 'not_attempted') contribution.notAttempted += 1;
      if (check.reviewStatus === 'unreviewed') contribution.unreviewed += 1;
      if (check.reviewStatus === 'confirmed') contribution.confirmed += 1;
      if (check.reviewStatus === 'rejected') contribution.rejected += 1;
      if (check.reviewStatus === 'retest_required') contribution.retestRequired += 1;
      bySession.set(check.sessionId, contribution);
    }

    return {
      readiness,
      sessionContributions: Array.from(bySession.values()).sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId),
      ),
    };
  }

  async recordReview(params: {
    organizationId: string;
    runId: string;
    checkId: string;
    reviewerUserId: string;
    input: unknown;
  }): Promise<{
    id: string;
    checkId: string;
    runId: string;
    reviewerUserId: string | null;
    decision: ComplianceControlCheckReviewDecision;
    reasonCode: string;
    note: string;
    createdAt: string;
  } | null> {
    const input = RecordControlCheckReviewSchema.parse(params.input);
    const [check] = await this.db
      .select({ id: complianceControlChecks.id })
      .from(complianceControlChecks)
      .innerJoin(runs, eq(runs.id, complianceControlChecks.runId))
      .where(and(
        eq(complianceControlChecks.id, params.checkId),
        eq(complianceControlChecks.runId, params.runId),
        eq(complianceControlChecks.organizationId, params.organizationId),
        eq(runs.organizationId, params.organizationId),
      ))
      .limit(1);
    if (!check) return null;

    const review = await this.db.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(complianceControlCheckReviews)
        .values({
          organizationId: params.organizationId,
          checkId: params.checkId,
          runId: params.runId,
          reviewerUserId: params.reviewerUserId,
          decision: input.decision,
          reasonCode: input.reasonCode,
          note: input.note,
        })
        .returning();
      if (!created) {
        throw new Error('Failed to persist compliance control-check review');
      }
      await transaction.insert(auditLogs).values({
        organizationId: params.organizationId,
        actorId: params.reviewerUserId,
        actorType: 'user',
        action: 'compliance.control_check.reviewed',
        resourceType: 'compliance_control_check',
        resourceId: params.checkId,
        changes: {
          decision: input.decision,
          reasonCode: input.reasonCode,
        },
        metadata: {
          runId: params.runId,
          reviewId: created.id,
          note: input.note,
        },
      });
      return created;
    });
    if (!review) {
      throw new Error('Failed to persist compliance control-check review');
    }

    return {
      id: review.id,
      checkId: review.checkId,
      runId: review.runId,
      reviewerUserId: review.reviewerUserId,
      decision: review.decision,
      reasonCode: review.reasonCode,
      note: review.note,
      createdAt: review.createdAt.toISOString(),
    };
  }
}
