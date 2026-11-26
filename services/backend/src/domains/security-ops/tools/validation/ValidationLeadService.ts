import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { inventoryNotes } from '@/db/schema';
import { ntypeSchemas } from '@/domains/security-ops/tools/ntypeSchemas';

const ValidationLeadObservationSchema = z.object({
  technique: z.string().min(1),
  probe: z.string().min(1).optional(),
  result: z.enum(['confirmed', 'contradicted', 'partial', 'inconclusive']),
  evidenceRef: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

const SubmitValidationLeadOutcomeSchema = z
  .object({
    leadId: z.string().uuid(),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    outcome: z.enum(['validated', 'false_positive', 'blocked', 'deferred', 'superseded']),
    blockerCode: z.string().min(1).optional(),
    observations: z.array(ValidationLeadObservationSchema).default([]),
    nextPrerequisite: z.string().min(1).optional(),
    replacementLead: z.record(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.outcome === 'blocked' || value.outcome === 'deferred') && !value.blockerCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockerCode'],
        message: 'blockerCode is required when outcome is blocked or deferred',
      });
    }
    if ((value.outcome === 'false_positive' || value.outcome === 'deferred') && value.observations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observations'],
        message: 'at least one observation is required when outcome is false_positive or deferred',
      });
    }
  });

const VALIDATION_BLOCKER_VOCABULARY = [
  'credential_required',
  'auth_required',
  'account_state_required',
  'rate_limited',
  'target_unavailable',
  'out_of_scope',
  'waf_blocked',
  'insufficient_evidence',
  'tooling_blocked',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

const canonicalizeValidationBlockerCode = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.includes('verified_account') ||
    normalized.includes('account_state') ||
    normalized.includes('account_required') ||
    normalized.includes('no_account')
  ) {
    return 'account_state_required';
  }
  if (
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('no_valid_credentials')
  ) {
    return 'credential_required';
  }
  if (normalized.includes('auth') || normalized.includes('login') || normalized.includes('session')) {
    return 'auth_required';
  }
  if (normalized.includes('rate') || normalized.includes('throttle') || normalized.includes('429')) {
    return 'rate_limited';
  }
  if (normalized.includes('unavailable') || normalized.includes('timeout') || normalized.includes('down')) {
    return 'target_unavailable';
  }
  if (normalized.includes('scope')) {
    return 'out_of_scope';
  }
  if (normalized.includes('waf') || normalized.includes('blocked_by_firewall')) {
    return 'waf_blocked';
  }
  if (normalized.includes('evidence') || normalized.includes('inconclusive')) {
    return 'insufficient_evidence';
  }
  if (normalized.includes('tool') || normalized.includes('parser') || normalized.includes('sandbox')) {
    return 'tooling_blocked';
  }
  return normalized;
};

type EvidenceWithExcerpt = {
  path: string;
  label?: string;
  excerpt?: string;
  fileMissing?: boolean;
};

export type SubmitValidationLeadOutcomeResult = {
  leadId: string;
  outcome: 'validated' | 'false_positive' | 'blocked' | 'deferred' | 'superseded';
  requestedOutcome: 'validated' | 'false_positive' | 'blocked' | 'deferred' | 'superseded';
  blockerCode?: string;
  canonicalBlockerCode?: string;
  standardBlockerCodes?: readonly string[];
  promptSha256: string | null;
  attempts: number;
  autoDeferred: boolean;
  remainingOpenLeadIds: string[];
};

export class ValidationLeadService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options: {
      now?: () => Date;
      normalizeToolText: (value: string) => string;
      buildReportNoteValidationError: (detail: string, ntype?: string) => Error;
      mergeEvidenceWithExcerptsByPath: (
        existing: EvidenceWithExcerpt[] | null | undefined,
        incoming: EvidenceWithExcerpt[],
      ) => EvidenceWithExcerpt[];
    },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async updatePromptMetadata(params: {
    userId: string;
    organizationId: string;
    scopeId: string;
    leadId: string;
    promptSha256: string;
    promptPath: string;
    normalizedLead: Record<string, unknown>;
  }): Promise<{
    leadId: string;
    promptSha256: string;
    promptPath: string;
    status: string;
  }> {
    const now = this.now();

    const [row] = await this.db
      .select({
        id: inventoryNotes.id,
        data: inventoryNotes.data,
        evidence: inventoryNotes.evidence,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.id, params.leadId),
          eq(inventoryNotes.userId, params.userId),
          eq(inventoryNotes.organizationId, params.organizationId),
          eq(inventoryNotes.scopeId, params.scopeId),
          eq(inventoryNotes.ntype, 'validation.lead'),
        ),
      )
      .limit(1);

    if (!row) {
      throw new Error(`validation.lead ${params.leadId} was not found in this scope`);
    }

    const mergedData = {
      ...(isRecord(row.data) ? row.data : {}),
      ...params.normalizedLead,
      id: params.leadId,
      promptSha256: params.promptSha256,
      promptPath: params.promptPath,
      promptRenderedAt: now.toISOString(),
    };
    const validation = ntypeSchemas['validation.lead']?.safeParse(mergedData);
    if (validation && !validation.success) {
      throw this.options.buildReportNoteValidationError(formatZodIssues(validation.error), 'validation.lead');
    }
    const normalizedData = validation ? validation.data as Record<string, unknown> : mergedData;
    const evidence = this.options.mergeEvidenceWithExcerptsByPath(row.evidence, [
      { path: params.promptPath, label: 'validation lead prompt' },
    ]);

    await this.db
      .update(inventoryNotes)
      .set({
        data: normalizedData,
        evidence,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(inventoryNotes.id, params.leadId));

    return {
      leadId: params.leadId,
      promptSha256: params.promptSha256,
      promptPath: params.promptPath,
      status: getString((normalizedData as Record<string, unknown>).status) ?? 'open',
    };
  }

  async submitOutcome(params: {
    userId: string;
    organizationId: string;
    scopeId: string;
    input: unknown;
  }): Promise<SubmitValidationLeadOutcomeResult> {
    const parsed = SubmitValidationLeadOutcomeSchema.parse(params.input);
    const now = this.now();

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: inventoryNotes.id,
          data: inventoryNotes.data,
        })
        .from(inventoryNotes)
        .where(
          and(
            eq(inventoryNotes.id, parsed.leadId),
            eq(inventoryNotes.userId, params.userId),
            eq(inventoryNotes.organizationId, params.organizationId),
            eq(inventoryNotes.scopeId, params.scopeId),
            eq(inventoryNotes.ntype, 'validation.lead'),
          ),
        )
        .limit(1);

      if (!row) {
        throw new Error(`submit_validation_lead_outcome blocked: leadId ${parsed.leadId} was not found in this scope.`);
      }

      const data = isRecord(row.data) ? row.data : {};
      const storedPromptSha = getString(data.promptSha256);
      if (parsed.promptSha256 && storedPromptSha !== parsed.promptSha256) {
        throw new Error(
          `submit_validation_lead_outcome blocked: promptSha256 does not match rendered lead prompt. Expected ${storedPromptSha ?? 'none'}.`,
        );
      }

      const previousAttempts =
        typeof data.attempts === 'number' && Number.isFinite(data.attempts) ? Math.max(0, Math.floor(data.attempts)) : 0;
      const previousBlockerCode = getString(data.lastBlockerCode);
      const previousCanonicalBlockerCode =
        getString(data.lastCanonicalBlockerCode) ?? canonicalizeValidationBlockerCode(previousBlockerCode);
      const canonicalBlockerCode = canonicalizeValidationBlockerCode(parsed.blockerCode);
      const previousRepeat =
        typeof data.blockerRepeatCount === 'number' && Number.isFinite(data.blockerRepeatCount)
          ? Math.max(0, Math.floor(data.blockerRepeatCount))
          : 0;
      const blockedLike = parsed.outcome === 'blocked' || parsed.outcome === 'deferred';
      const attempts = blockedLike ? previousAttempts + 1 : previousAttempts;
      const blockerRepeatCount =
        parsed.outcome === 'blocked'
          ? previousCanonicalBlockerCode === canonicalBlockerCode
            ? previousRepeat + 1
            : 1
          : previousRepeat;
      const autoDeferred =
        parsed.outcome === 'blocked' &&
        attempts >= 3 &&
        blockerRepeatCount >= 3 &&
        previousCanonicalBlockerCode === canonicalBlockerCode;
      const nextOutcome = autoDeferred ? 'deferred' : parsed.outcome;
      const existingObservations = Array.isArray(data.observations)
        ? data.observations.filter((entry): entry is Record<string, unknown> => isRecord(entry))
        : [];
      const outcomeObservations =
        parsed.observations.length > 0
          ? parsed.observations
          : autoDeferred
            ? [{
                technique: 'blocked_prerequisite',
                result: 'inconclusive' as const,
                note: `Auto-deferred after repeated blocker: ${canonicalBlockerCode ?? parsed.blockerCode ?? 'unknown'}.`,
              }]
            : [];
      const mergedData = {
        ...data,
        id: parsed.leadId,
        status: nextOutcome,
        attempts,
        observations: [...existingObservations, ...outcomeObservations],
        ...(parsed.blockerCode ? { lastBlockerCode: parsed.blockerCode } : {}),
        ...(canonicalBlockerCode ? { lastCanonicalBlockerCode: canonicalBlockerCode } : {}),
        ...(parsed.outcome === 'blocked' ? { blockerRepeatCount } : {}),
        ...(parsed.nextPrerequisite ? { nextPrerequisite: this.options.normalizeToolText(parsed.nextPrerequisite) } : {}),
        ...(parsed.replacementLead ? { replacementLead: parsed.replacementLead } : {}),
      };
      const validation = ntypeSchemas['validation.lead']?.safeParse(mergedData);
      if (validation && !validation.success) {
        throw this.options.buildReportNoteValidationError(formatZodIssues(validation.error), 'validation.lead');
      }
      const normalizedData = validation ? validation.data as Record<string, unknown> : mergedData;

      await tx
        .update(inventoryNotes)
        .set({
          data: normalizedData,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(inventoryNotes.id, parsed.leadId));

      const rows = await tx
        .select({
          id: inventoryNotes.id,
          data: inventoryNotes.data,
        })
        .from(inventoryNotes)
        .where(
          and(
            eq(inventoryNotes.userId, params.userId),
            eq(inventoryNotes.organizationId, params.organizationId),
            eq(inventoryNotes.scopeId, params.scopeId),
            eq(inventoryNotes.ntype, 'validation.lead'),
          ),
        )
        .limit(500);
      const remainingOpenLeadIds = rows
        .filter((note) => {
          const noteData = isRecord(note.data) ? note.data : {};
          const status = getString(noteData.status)?.toLowerCase() ?? 'open';
          return status === 'open';
        })
        .map((note) => note.id);

      return {
        leadId: parsed.leadId,
        outcome: nextOutcome,
        requestedOutcome: parsed.outcome,
        ...(parsed.blockerCode ? { blockerCode: parsed.blockerCode } : {}),
        ...(canonicalBlockerCode ? { canonicalBlockerCode } : {}),
        standardBlockerCodes: VALIDATION_BLOCKER_VOCABULARY,
        promptSha256: storedPromptSha ?? parsed.promptSha256 ?? null,
        attempts,
        autoDeferred,
        remainingOpenLeadIds,
      };
    });
  }
}
