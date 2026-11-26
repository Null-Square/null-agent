import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import {
  codeReviewFindings,
  codeReviewFixRequests,
  codeReviewReports,
  runs,
  type CodeReviewContext,
  type CodeReviewFindingRow,
  type CodeReviewSourceLocation,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { validateCodeReviewContext } from '@/domains/security-ops/runs/codeReviewRunContext';
import { redactCodeReviewText } from './CodeReviewRedaction';
import {
  CODE_RISK_FINGERPRINT_VERSION,
  CodeReviewRiskPublisher,
} from './CodeReviewRiskPublisher';

/**
 * A Code Review finding id, in either shape the platform produces.
 *
 * An organization run stores findings as database rows keyed by uuid. A hosted
 * run has no database: it addresses findings by the sha256 fingerprint the
 * report tool derives from the finding's own content, which is what makes a
 * repeated candidate idempotent across runs.
 *
 * Requiring uuid here accepted only the first and silently locked hosted runs
 * out of validation entirely — a validation phase could complete its analysis
 * and still be unable to record the disposition, which is how a run reached
 * "completed" with every finding left as a candidate.
 */
export const CodeReviewFindingIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^[a-f0-9]{64}$/iu, 'expected a uuid or a sha256 fingerprint'),
]);

const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
const FixabilitySchema = z.enum(['fixable', 'not_fixable', 'uncertain']);
const ChangeAttributionSchema = z.enum([
  'repository_scope',
  'introduced',
  'exposed',
  'worsened',
  'pre_existing_context',
]);

const ExactSourceAnchorSchema = z.string()
  .min(1)
  .max(8_000)
  .refine((value) => value.trim().length > 0, {
    message: 'sourceAnchor must contain non-whitespace source text',
  });

export const CodeReviewCandidateLocationSchema = z.object({
  filePath: z.string().trim().min(1),
  commitSha: z.string().trim().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu).optional(),
  sourceAnchor: ExactSourceAnchorSchema,
  occurrence: z.number().int().min(1).optional(),
  contextBeforeLines: z.number().int().min(0).max(20).default(1),
  contextAfterLines: z.number().int().min(0).max(20).default(1),
});

export type CodeReviewCandidateLocationInput = z.infer<
  typeof CodeReviewCandidateLocationSchema
>;

export type ResolvedCodeReviewSourceAnchor = {
  startLine: number;
  endLine: number;
  sourceExcerpt: string;
};

const normalizeSourceLineEndings = (value: string): string =>
  value.replace(/\r\n?/gu, '\n');

export const resolveCodeReviewSourceAnchor = (
  content: string,
  location: CodeReviewCandidateLocationInput,
): ResolvedCodeReviewSourceAnchor => {
  const normalizedContent = normalizeSourceLineEndings(content);
  const normalizedAnchor = normalizeSourceLineEndings(location.sourceAnchor);
  const matchOffsets: number[] = [];
  let searchOffset = 0;

  while (searchOffset <= normalizedContent.length - normalizedAnchor.length) {
    const matchOffset = normalizedContent.indexOf(normalizedAnchor, searchOffset);
    if (matchOffset < 0) break;
    matchOffsets.push(matchOffset);
    searchOffset = matchOffset + Math.max(1, normalizedAnchor.length);
  }

  if (matchOffsets.length === 0) {
    throw new Error(
      `${location.filePath}: sourceAnchor was not found in the immutable file`,
    );
  }

  if (location.occurrence === undefined && matchOffsets.length > 1) {
    throw new Error(
      `${location.filePath}: sourceAnchor matched ${matchOffsets.length} locations; provide the 1-based occurrence`,
    );
  }

  const occurrence = location.occurrence ?? 1;
  const matchOffset = matchOffsets[occurrence - 1];
  if (matchOffset === undefined) {
    throw new Error(
      `${location.filePath}: sourceAnchor occurrence ${occurrence} exceeds ${matchOffsets.length} matches`,
    );
  }

  const anchorStartLine =
    normalizedContent.slice(0, matchOffset).split('\n').length;
  const anchorEndLine =
    anchorStartLine + normalizedAnchor.split('\n').length - 1;
  const lines = normalizedContent.split('\n');
  const startLine = Math.max(1, anchorStartLine - location.contextBeforeLines);
  const endLine = Math.min(
    lines.length,
    anchorEndLine + location.contextAfterLines,
  );

  if (endLine - startLine > 79) {
    throw new Error(
      `${location.filePath}: resolved source location cannot span more than 80 lines`,
    );
  }

  return {
    startLine,
    endLine,
    sourceExcerpt: lines.slice(startLine - 1, endLine).join('\n'),
  };
};

export const ReportCodeReviewCandidateSchema = z.object({
  existingRiskId: z.string().uuid().optional(),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  category: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(8_000),
  impact: z.string().trim().min(1).max(8_000),
  remediation: z.string().trim().min(1).max(8_000),
  changeAttribution: ChangeAttributionSchema.default('repository_scope'),
  attributionRationale: z.string().trim().min(1).max(4_000).optional(),
  locations: z.array(CodeReviewCandidateLocationSchema).min(1).max(12),
});

export const ValidateCodeReviewFindingSchema = z.object({
  findingId: CodeReviewFindingIdSchema,
  findingVersion: z.number().int().positive(),
  outcome: z.enum(['validated', 'rejected']),
  rationale: z.string().trim().min(1).max(8_000),
  severity: SeveritySchema.optional(),
  confidence: z.number().min(0).max(1),
  fixability: FixabilitySchema.default('uncertain'),
  fixabilityRationale: z.string().trim().min(1).max(4_000).optional(),
  expectedFiles: z.array(z.string().trim().min(1)).max(20).default([]),
  validationPlan: z.array(z.string().trim().min(1)).max(30).default([]),
}).superRefine((input, ctx) => {
  if (input.outcome === 'rejected' && input.fixability === 'fixable') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fixability'],
      message: 'a rejected candidate cannot be fixable',
    });
  }
  if (input.fixability === 'fixable') {
    if (!input.fixabilityRationale) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixabilityRationale'],
        message: 'fixable findings require a rationale',
      });
    }
    if (input.expectedFiles.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedFiles'],
        message: 'fixable findings require at least one expected file',
      });
    }
    if (input.validationPlan.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validationPlan'],
        message: 'fixable findings require a validation plan',
      });
    }
  }
});

export const FinalizeCodeReviewReportSchema = z.object({
  executiveSummary: z.string().trim().min(1).max(12_000),
  scopeSummary: z.string().trim().min(1).max(8_000),
  limitations: z.array(z.string().trim().min(1).max(2_000)).max(30).default([]),
  completeness: z.enum(['complete', 'partial', 'blocked']),
});

export type ReportCodeReviewCandidateInput = z.infer<typeof ReportCodeReviewCandidateSchema>;
export type ValidateCodeReviewFindingInput = z.infer<typeof ValidateCodeReviewFindingSchema>;
export type FinalizeCodeReviewReportInput = z.infer<typeof FinalizeCodeReviewReportSchema>;

export type VerifiedCodeReviewLocation = {
  filePath: string;
  commitSha: string;
  startLine: number;
  endLine: number;
  sourceExcerpt: string;
  sourceExcerptSha256: string;
  sourceOriginalSha256: string;
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const normalizeFingerprintText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/gu, ' ');

export const buildCodeReviewFindingFingerprint = (
  input: ReportCodeReviewCandidateInput,
  locations: readonly VerifiedCodeReviewLocation[],
): string => {
  const canonicalLocations = locations
    .map((location) =>
      location.filePath.toLowerCase(),
    )
    .sort()
    .join('|');
  return sha256([
    normalizeFingerprintText(input.category),
    normalizeFingerprintText(input.title),
    canonicalLocations,
  ].join(':'));
};

export const renderCodeReviewFindingMarkdown = (
  finding: CodeReviewFindingRow,
  index: number,
): string => {
  const locationLines = (finding.locations ?? []).map(
    (location) =>
      `- \`${location.filePath}:${location.startLine}-${location.endLine}\` at \`${location.commitSha}\``,
  );
  const fixability = finding.fixability === 'fixable'
    ? `Fixable — ${finding.fixabilityRationale ?? 'Agent assessed this finding as fixable.'}`
    : finding.fixability === 'not_fixable'
      ? `Not fixable — ${finding.fixabilityRationale ?? 'A safe bounded code change is not available.'}`
      : `Uncertain — ${finding.fixabilityRationale ?? 'The review did not establish a safe bounded fix.'}`;

  return [
    `## ${index}. ${finding.title}`,
    '',
    `- Severity: ${finding.severity}`,
    `- Category: ${finding.category}`,
    `- Change attribution: ${finding.changeAttribution}`,
    ...(finding.attributionRationale
      ? [`- Attribution rationale: ${finding.attributionRationale}`]
      : []),
    `- Fixability: ${fixability}`,
    '',
    finding.summary,
    '',
    '### Impact',
    '',
    finding.impact,
    '',
    '### Source attribution',
    '',
    ...locationLines,
    '',
    '### Remediation',
    '',
    finding.remediation,
  ].join('\n');
};

export class CodeReviewFindingService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async requireRun(params: {
    organizationId: string;
    runId: string;
  }): Promise<{
    id: string;
    scopeId: string;
    codeReviewContext: CodeReviewContext;
  }> {
    const [run] = await this.db
      .select({
        id: runs.id,
        scopeId: runs.scopeId,
        workflowDiscipline: runs.workflowDiscipline,
        codeReviewContext: runs.codeReviewContext,
      })
      .from(runs)
      .where(and(eq(runs.id, params.runId), eq(runs.organizationId, params.organizationId)))
      .limit(1);

    if (!run) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Code Review run not found');
    }
    if (run.workflowDiscipline !== 'code_review' || !run.codeReviewContext) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'This operation requires a standalone Code Review run',
      );
    }
    const validation = validateCodeReviewContext(run.codeReviewContext);
    if (!validation.ok) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Code Review run context is invalid: ${validation.issues.join('; ')}`,
      );
    }
    return {
      id: run.id,
      scopeId: run.scopeId,
      codeReviewContext: run.codeReviewContext,
    };
  }

  async reportCandidate(params: {
    organizationId: string;
    runId: string;
    sessionId: string;
    input: unknown;
    verifiedLocations: VerifiedCodeReviewLocation[];
  }): Promise<{ finding: CodeReviewFindingRow; created: boolean }> {
    const parsedInput = ReportCodeReviewCandidateSchema.parse(params.input);
    const input: ReportCodeReviewCandidateInput = {
      ...parsedInput,
      category: redactCodeReviewText(parsedInput.category),
      title: redactCodeReviewText(parsedInput.title),
      summary: redactCodeReviewText(parsedInput.summary),
      impact: redactCodeReviewText(parsedInput.impact),
      remediation: redactCodeReviewText(parsedInput.remediation),
      attributionRationale: parsedInput.attributionRationale
        ? redactCodeReviewText(parsedInput.attributionRationale)
        : undefined,
    };
    if (params.verifiedLocations.length !== input.locations.length) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Every Code Review location must be verified against the immutable repository commit',
      );
    }
    const run = await this.requireRun(params);
    const context = run.codeReviewContext;
    if (context.operation === 'pull_request_review') {
      if (input.changeAttribution === 'repository_scope' || !input.attributionRationale) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'Pull-request candidates require introduced, exposed, worsened, or pre_existing_context attribution with a rationale',
        );
      }
    } else if (input.changeAttribution !== 'repository_scope') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Repository review candidates must use repository_scope attribution',
      );
    }
    const locations: CodeReviewSourceLocation[] = params.verifiedLocations.map((location) => ({
      repositoryId: context.repository.repositoryId,
      repositoryFullName: context.repository.fullName,
      commitSha: location.commitSha,
      filePath: location.filePath,
      startLine: location.startLine,
      endLine: location.endLine,
      sourceExcerpt: location.sourceExcerpt,
      sourceExcerptSha256: location.sourceExcerptSha256,
      sourceOriginalSha256: location.sourceOriginalSha256,
    }));
    const fingerprint = buildCodeReviewFindingFingerprint(input, params.verifiedLocations);
    const now = this.now();
    let matchedPriorFindingId: string | null = null;

    const result = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(codeReviewFindings)
        .where(
          and(
            eq(codeReviewFindings.runId, run.id),
            eq(codeReviewFindings.fingerprint, fingerprint),
          ),
        )
        .limit(1);

      if (existing) {
        const [updated] = await tx
          .update(codeReviewFindings)
          .set({
            state: 'candidate',
            severity: input.severity,
            confidence: input.confidence,
            category: input.category,
            title: input.title,
            summary: input.summary,
            impact: input.impact,
            remediation: input.remediation,
            locations,
            changeAttribution: input.changeAttribution,
            attributionRationale: input.attributionRationale ?? null,
            validation: null,
            fixability: 'uncertain',
            fixabilityRationale: null,
            expectedFiles: [],
            validationPlan: [],
            riskId: input.existingRiskId ?? existing.riskId,
            fingerprintVersion: CODE_RISK_FINGERPRINT_VERSION,
            lastSeenCommitSha: context.repository.immutableCommitSha,
            version: existing.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(codeReviewFindings.id, existing.id),
              eq(codeReviewFindings.version, existing.version),
            ),
          )
          .returning();
        if (!updated) {
          throw new AppError(
            ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
            'The Code Review candidate changed while it was being refreshed; retry against the latest version',
          );
        }
        return { finding: updated, created: false };
      }

      const [priorRevision] = await tx
        .select({
          id: codeReviewFindings.id,
          firstSeenCommitSha: codeReviewFindings.firstSeenCommitSha,
          commitSha: codeReviewFindings.commitSha,
          riskId: codeReviewFindings.riskId,
        })
        .from(codeReviewFindings)
        .where(
          and(
            eq(codeReviewFindings.organizationId, params.organizationId),
            eq(codeReviewFindings.repositoryId, context.repository.repositoryId),
            eq(codeReviewFindings.fingerprint, fingerprint),
          ),
        )
        .orderBy(desc(codeReviewFindings.createdAt))
        .limit(1);

      const [created] = await tx
        .insert(codeReviewFindings)
        .values({
          organizationId: params.organizationId,
          scopeId: run.scopeId,
          runId: run.id,
          createdBySessionId: params.sessionId,
          repositoryId: context.repository.repositoryId,
          repositoryFullName: context.repository.fullName,
          commitSha: context.repository.immutableCommitSha,
          firstSeenCommitSha:
            priorRevision?.firstSeenCommitSha
            ?? priorRevision?.commitSha
            ?? context.repository.immutableCommitSha,
          lastSeenCommitSha: context.repository.immutableCommitSha,
          supersedesFindingId: priorRevision?.id ?? null,
          riskId: input.existingRiskId ?? priorRevision?.riskId ?? null,
          fingerprint,
          fingerprintVersion: CODE_RISK_FINGERPRINT_VERSION,
          severity: input.severity,
          confidence: input.confidence,
          category: input.category,
          title: input.title,
          summary: input.summary,
          impact: input.impact,
          remediation: input.remediation,
          locations,
          changeAttribution: input.changeAttribution,
          attributionRationale: input.attributionRationale ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) {
        throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to create Code Review candidate');
      }
      matchedPriorFindingId = priorRevision?.id ?? null;
      return { finding: created, created: true };
    });
    if (matchedPriorFindingId) {
      logger.info(
        {
          organizationId: params.organizationId,
          repositoryId: context.repository.repositoryId,
          runId: run.id,
          findingId: result.finding.id,
          supersedesFindingId: matchedPriorFindingId,
          fingerprint,
        },
        '[code-review] Matched finding to prior-revision lineage',
      );
    }
    const validated = await this.listFindings({
      organizationId: params.organizationId,
      runId: run.id,
      state: 'validated',
    });
    await this.db
      .update(runs)
      .set({ findingsCount: validated.length, updatedAt: now })
      .where(eq(runs.id, run.id));
    return result;
  }

  async validateFinding(params: {
    organizationId: string;
    runId: string;
    sessionId: string;
    input: unknown;
  }): Promise<CodeReviewFindingRow> {
    const input = ValidateCodeReviewFindingSchema.parse(params.input);
    const run = await this.requireRun(params);
    const [finding] = await this.db
      .select()
      .from(codeReviewFindings)
      .where(
        and(
          eq(codeReviewFindings.id, input.findingId),
          eq(codeReviewFindings.runId, run.id),
          eq(codeReviewFindings.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    if (!finding) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Code Review candidate not found in this run');
    }
    if (finding.state !== 'candidate') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Only a current Code Review candidate can be validated or rejected',
      );
    }
    if (finding.version !== input.findingVersion) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Code Review candidate version is stale; expected ${finding.version}`,
      );
    }
    if (
      run.codeReviewContext.operation === 'pull_request_review'
      && finding.changeAttribution === 'pre_existing_context'
      && input.outcome === 'validated'
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'A pre-existing contextual issue cannot become a validated pull-request finding',
      );
    }

    const now = this.now();
    const state = input.outcome;
    const [updated] = await this.db
      .update(codeReviewFindings)
      .set({
        state,
        severity: input.severity ?? finding.severity,
        confidence: input.confidence,
        validation: {
          outcome: input.outcome,
          rationale: redactCodeReviewText(input.rationale),
          validatedBySessionId: params.sessionId,
          validatedAt: now.toISOString(),
        },
        fixability: state === 'validated' ? input.fixability : 'uncertain',
        fixabilityRationale: input.fixabilityRationale
          ? redactCodeReviewText(input.fixabilityRationale)
          : null,
        expectedFiles: state === 'validated' ? input.expectedFiles : [],
        validationPlan: state === 'validated' ? input.validationPlan : [],
        version: finding.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(codeReviewFindings.id, finding.id),
          eq(codeReviewFindings.state, 'candidate'),
          eq(codeReviewFindings.version, input.findingVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'The Code Review candidate changed during validation; reload and validate the latest version',
      );
    }

    const validated = await this.listFindings({
      organizationId: params.organizationId,
      runId: run.id,
      state: 'validated',
    });
    await this.db
      .update(runs)
      .set({ findingsCount: validated.length, updatedAt: now })
      .where(eq(runs.id, run.id));

    return updated;
  }

  async listFindings(params: {
    organizationId: string;
    runId: string;
    state?: 'candidate' | 'validated' | 'rejected';
  }): Promise<CodeReviewFindingRow[]> {
    await this.requireRun(params);
    const filters = [
      eq(codeReviewFindings.organizationId, params.organizationId),
      eq(codeReviewFindings.runId, params.runId),
      ...(params.state ? [eq(codeReviewFindings.state, params.state)] : []),
    ];
    return this.db
      .select()
      .from(codeReviewFindings)
      .where(and(...filters))
      .orderBy(asc(codeReviewFindings.createdAt));
  }

  async finalizeReport(params: {
    organizationId: string;
    runId: string;
    sessionId: string;
    input: unknown;
  }) {
    const parsedInput = FinalizeCodeReviewReportSchema.parse(params.input);
    const input: FinalizeCodeReviewReportInput = {
      executiveSummary: redactCodeReviewText(parsedInput.executiveSummary),
      scopeSummary: redactCodeReviewText(parsedInput.scopeSummary),
      limitations: parsedInput.limitations.map(redactCodeReviewText),
      completeness: parsedInput.completeness,
    };
    const run = await this.requireRun(params);
    const findings = await this.listFindings({
      organizationId: params.organizationId,
      runId: params.runId,
      state: 'validated',
    });
    const context = run.codeReviewContext;
    const limitations = [...input.limitations];
    if (context.reviewScope.completeness !== 'complete') {
      limitations.unshift(
        `The immutable repository manifest was ${context.reviewScope.completeness}; the review could not claim complete repository coverage.`,
      );
    }
    const completeness =
      context.reviewScope.completeness === 'complete'
        ? input.completeness
        : context.reviewScope.completeness;
    const markdown = [
      '# Code Review Report',
      '',
      `Repository: \`${context.repository.fullName}\``,
      `Commit: \`${context.repository.immutableCommitSha}\``,
      `Review mode: ${context.reviewScope.mode}`,
      `Manifest retrieval: ${context.reviewScope.completeness}`,
      `Review completeness: ${completeness}`,
      '',
      '## Executive summary',
      '',
      input.executiveSummary,
      '',
      '## Scope',
      '',
      input.scopeSummary,
      '',
      `## Validated findings (${findings.length})`,
      '',
      findings.length > 0
        ? findings
          .map((finding, index) => renderCodeReviewFindingMarkdown(finding, index + 1))
          .join('\n\n')
        : 'No validated findings were recorded.',
      '',
      '## Limitations',
      '',
      limitations.length > 0
        ? limitations.map((limitation) => `- ${limitation}`).join('\n')
        : '- None recorded.',
    ].join('\n');
    const now = this.now();
    const contentSha256 = sha256(markdown);

    const values = {
      executiveSummary: input.executiveSummary,
      scopeSummary: input.scopeSummary,
      markdown,
      findingIds: findings.map((finding) => finding.id),
      limitations,
      completeness,
      contentSha256,
      finalizedBySessionId: params.sessionId,
      updatedAt: now,
    };
    const report = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: codeReviewReports.id })
        .from(codeReviewReports)
        .where(eq(codeReviewReports.runId, run.id))
        .limit(1);
      const [saved] = existing
        ? await tx
            .update(codeReviewReports)
            .set(values)
            .where(eq(codeReviewReports.id, existing.id))
            .returning()
        : await tx
            .insert(codeReviewReports)
            .values({
              ...values,
              organizationId: params.organizationId,
              scopeId: run.scopeId,
              runId: run.id,
              createdAt: now,
            })
            .returning();

      if (saved) {
        await new CodeReviewRiskPublisher(tx, () => now).publish({
          organizationId: params.organizationId,
          scopeId: run.scopeId,
          context,
          reportCompleteness: completeness,
          occurrences: findings,
          now,
        });
      }
      return saved;
    });

    return report;
  }

  async getBundle(params: {
    organizationId: string;
    runId: string;
  }) {
    const run = await this.requireRun(params);
    const findings = await this.listFindings(params);
    const [report] = await this.db
      .select()
      .from(codeReviewReports)
      .where(
        and(
          eq(codeReviewReports.organizationId, params.organizationId),
          eq(codeReviewReports.runId, params.runId),
        ),
      )
      .limit(1);
    const findingIds = findings.map((finding) => finding.id);
    const fixRequests = findingIds.length > 0
      ? await this.db
          .select()
          .from(codeReviewFixRequests)
          .where(
            and(
              eq(codeReviewFixRequests.organizationId, params.organizationId),
              inArray(codeReviewFixRequests.findingId, findingIds),
            ),
          )
          .orderBy(asc(codeReviewFixRequests.createdAt))
      : [];
    return {
      context: run.codeReviewContext,
      findings,
      report: report ?? null,
      fixRequests,
      // Nothing is published to GitHub from Null AI.
      publication: null,
    };
  }

  async requestFix(params: {
    organizationId: string;
    runId: string;
    findingId: string;
    findingVersion: number;
    vulnerableCommitSha: string;
    requestedByUserId: string;
  }) {
    const run = await this.requireRun(params);
    const [finding] = await this.db
      .select()
      .from(codeReviewFindings)
      .where(
        and(
          eq(codeReviewFindings.id, params.findingId),
          eq(codeReviewFindings.runId, run.id),
          eq(codeReviewFindings.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    if (!finding) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Code Review finding not found');
    }
    if (finding.state !== 'validated' || finding.fixability !== 'fixable') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Fix generation is available only for a currently validated finding the agent marked fixable',
      );
    }
    if (
      finding.version !== params.findingVersion
      || finding.commitSha.toLowerCase() !== params.vulnerableCommitSha.toLowerCase()
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'The Code Review finding changed after this Fix action was rendered; reload before retrying',
      );
    }
    if (
      finding.commitSha.toLowerCase()
      !== run.codeReviewContext.repository.immutableCommitSha.toLowerCase()
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'The finding no longer matches the immutable vulnerable commit',
      );
    }

    const [existing] = await this.db
      .select()
      .from(codeReviewFixRequests)
      .where(
        and(
          eq(codeReviewFixRequests.findingId, finding.id),
          eq(codeReviewFixRequests.findingVersion, finding.version),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.status === 'failed' || existing.status === 'cancelled') {
        const now = this.now();
        const [retried] = await this.db
          .update(codeReviewFixRequests)
          .set({
            requestedByUserId: params.requestedByUserId,
            vulnerableCommitSha: finding.commitSha,
            status: 'requested',
            updatedAt: now,
          })
          .where(eq(codeReviewFixRequests.id, existing.id))
          .returning();
        if (!retried) {
          throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to retry Code Review fix request');
        }
        return retried;
      }
      return existing;
    }

    const now = this.now();
    const [created] = await this.db
      .insert(codeReviewFixRequests)
      .values({
        organizationId: params.organizationId,
        findingId: finding.id,
        requestedByUserId: params.requestedByUserId,
        findingVersion: finding.version,
        vulnerableCommitSha: finding.commitSha,
        status: 'requested',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          codeReviewFixRequests.findingId,
          codeReviewFixRequests.findingVersion,
        ],
      })
      .returning();
    if (created) {
      return created;
    }
    const [concurrent] = await this.db
      .select()
      .from(codeReviewFixRequests)
      .where(
        and(
          eq(codeReviewFixRequests.findingId, finding.id),
          eq(codeReviewFixRequests.findingVersion, finding.version),
        ),
      )
      .limit(1);
    if (!concurrent) {
      throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to request Code Review fix');
    }
    return concurrent;
  }
}
