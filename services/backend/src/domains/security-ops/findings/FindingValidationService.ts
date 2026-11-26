import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { findingEvents, findingEvidence, findingValidationAudit, findings, type RiskState } from '@/db/schema';
import type {
  FindingAdvisoryTriage,
  FindingAdvisoryTriageFlag,
  FindingHttpExchange,
  FindingProofObligation,
  FindingProofObligationStatus,
  FindingValidationEvidenceRef,
  FindingValidationProof,
  FindingValidationProofBundle,
  FindingValidationReplayEscapeReason,
} from '@/domains/security-ops/findings/findingContracts';
import {
  buildFindingReportCompleteness,
  type FindingReportCompleteness,
} from '@/domains/security-ops/findings/findingReportCompleteness';
import { assertProofEvidenceIdsResolvable, normalizeProofEvidenceId } from './ProofEvidenceReferenceResolver';
import { REPORTABLE_RISK_STATES } from '@/domains/security-ops/risks/riskLifecycle';
import type { StructuredHttpEvidenceInput } from '@/domains/security-ops/tools/evidence/EvidenceResolver';

const EvidenceRefSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1).optional(),
});

const NotReplayedReasonSchema = z.enum([
  'blind_oob',
  'race',
  'one_time_token',
  'non_idempotent',
  'unsafe_to_replay',
  'target_drift',
  'other',
]);

const ProofObligationStatusSchema = z.enum(['proven', 'unproven', 'needs_context']);
const AdvisoryTriageVerdictSchema = z.enum(['agree', 'disagree', 'needs_context']);
const AdvisoryTriageFlagSchema = z.enum(['duplicate', 'weak_evidence', 'risky_to_replay']);

const ValidationProofSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    return {
      claim: record.claim,
      evidenceIds: record.evidenceIds ?? record.evidence_ids,
      replayAttempted: record.replayAttempted ?? record.replay_attempted,
      replayArtifact: record.replayArtifact ?? record.replay_artifact,
      replayReproduced: record.replayReproduced ?? record.replay_reproduced,
      notReplayedReason: record.notReplayedReason ?? record.not_replayed_reason,
    };
  },
  z
    .object({
      claim: z.string().min(1),
      evidenceIds: z.array(z.string().min(1)).default([]),
      replayAttempted: z.boolean().optional().default(false),
      replayArtifact: z.string().min(1).optional(),
      replayReproduced: z.boolean().optional(),
      notReplayedReason: NotReplayedReasonSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (value.evidenceIds.length === 0 && !value.notReplayedReason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidenceIds'],
          message:
            'proof.evidenceIds must include at least one bound evidence ID/path, or proof.notReplayedReason must explain why replay/evidence binding is not applicable',
        });
      }
      if (value.replayReproduced === true && !value.replayArtifact) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['replayArtifact'],
          message: 'proof.replayArtifact is required when proof.replayReproduced is true',
        });
      }
    }),
);

const ProofObligationSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    return {
      id: record.id,
      observable: record.observable,
      status: record.status,
      evidenceIds: record.evidenceIds ?? record.evidence_ids,
      note: record.note,
    };
  },
  z.object({
    id: z.string().min(1).optional(),
    observable: z.string().min(1),
    status: ProofObligationStatusSchema,
    evidenceIds: z.array(z.string().min(1)).optional().default([]),
    note: z.string().min(1).optional(),
  }),
);

const AdvisoryTriageSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    return {
      verdict: record.verdict,
      reason: record.reason,
      triagedBy: record.triagedBy ?? record.triaged_by,
      evidenceIds: record.evidenceIds ?? record.evidence_ids,
      duplicateOf: record.duplicateOf ?? record.duplicate_of,
      flags: record.flags,
    };
  },
  z.object({
    verdict: AdvisoryTriageVerdictSchema,
    reason: z.string().min(1),
    triagedBy: z.string().min(1).optional(),
    evidenceIds: z.array(z.string().min(1)).optional().default([]),
    duplicateOf: z.string().min(1).optional(),
    flags: z.array(AdvisoryTriageFlagSchema).optional().default([]),
  }),
);

export const PromoteFindingSchema = z.object({
  findingId: z.string().uuid(),
  to: z.enum(['reportable']).optional().default('reportable'),
  rationale: z.string().min(1).optional(),
});

export const SubmitValidationOutcomeSchema = z.object({
  findingId: z.string().uuid(),
  outcome: z.enum(['validated', 'false_positive', 'inconclusive']),
  reason: z.string().min(1),
  evidence: z.array(EvidenceRefSchema).optional(),
  proof: ValidationProofSchema,
  proofObligations: z.array(ProofObligationSchema).optional().default([]),
  advisoryTriage: AdvisoryTriageSchema.optional(),
});

type ResolvedArtifactFindingEvidence = {
  kind: 'artifact';
  path: string;
  displayPath: string;
  label?: string;
  excerpt?: string;
  fileMissing?: boolean;
};

type ResolvedStructuredHttpFindingEvidence = {
  kind: 'http_exchange';
  path: string;
  displayPath: string;
  label?: string;
  data: FindingHttpExchange;
};

type ResolvedFindingEvidence = ResolvedArtifactFindingEvidence | ResolvedStructuredHttpFindingEvidence;

type FindingValidationProofInput = z.infer<typeof ValidationProofSchema>;
type FindingProofObligationInput = z.infer<typeof ProofObligationSchema>;
type AdvisoryTriageInput = z.infer<typeof AdvisoryTriageSchema>;

export type PromoteFindingResult =
  | {
      findingId: string;
      promoted: boolean;
      alreadyReportable: boolean;
      state: RiskState;
      lifecycleStage: 'reportable';
      dedupeKey: string;
      durableEvidenceCount: number;
      action: 'already_validated';
      nextAction: 'none';
      reportCompleteness: FindingReportCompleteness;
    }
  | {
      findingId: string;
      promoted: false;
      alreadyReportable: false;
      state: 'verifying';
      lifecycleStage: 'candidate';
      dedupeKey: string;
      durableEvidenceCount: number;
      validationPending: true;
      action: 'queued' | 'already_queued';
      nextAction: 'submit_validation_outcome';
      reportCompleteness: FindingReportCompleteness;
    };

export type SubmitValidationOutcomeResult =
  | {
      findingId: string;
      outcome: 'validated';
      promoted: boolean;
      alreadyReportable: boolean;
      state: RiskState;
      lifecycleStage: 'reportable';
      dedupeKey: string;
      durableEvidenceCount: number;
      workerEvidenceCount: number;
      reportCompleteness: FindingReportCompleteness;
      validationProof: FindingValidationProofBundle;
    }
  | {
      findingId: string;
      outcome: 'false_positive' | 'inconclusive';
      promoted: false;
      alreadyReportable: false;
      state: 'dismissed' | 'verifying';
      lifecycleStage: 'candidate';
      dedupeKey: string;
      durableEvidenceCount: number;
      workerEvidenceCount: number;
      reportCompleteness: FindingReportCompleteness;
      validationProof: FindingValidationProofBundle;
    };

const REPLAY_RISKY_ESCAPE_REASONS = new Set<FindingValidationReplayEscapeReason>([
  'race',
  'one_time_token',
  'non_idempotent',
  'unsafe_to_replay',
]);

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const CORS_FINDING_PATTERN = /\b(?:cors|cross-origin|access-control-allow-origin)\b/iu;
const PROTECTED_DATA_PATTERN = /\b(?:private|protected|sensitive|authenticated|account(?:-specific)?|evaluator data)\b/iu;
const AMBIENT_AUTHORITY_PATTERN = /\b(?:ambient credential|cookie|client certificate|http authentication)\b/iu;

const headerValue = (
  headers: FindingHttpExchange['request']['headers'] | FindingHttpExchange['response']['headers'],
  name: string,
): string | undefined =>
  headers?.find((header) => header.name.trim().toLowerCase() === name)?.value.trim();

const asFindingHttpExchange = (value: unknown): FindingHttpExchange | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Partial<FindingHttpExchange>;
  if (!record.request || !record.response) return null;
  if (typeof record.request !== 'object' || typeof record.response !== 'object') return null;
  return record as FindingHttpExchange;
};

const normalizedOrigin = (value: string): string => value.trim().replace(/\/$/u, '').toLowerCase();

/**
 * CORS is a browser-read boundary. Header reflection or a raw HTTP response is
 * not enough to promote a canonical Risk. This gate is intentionally narrow:
 * it runs only for CORS findings at the final validated transition.
 */
export const corsValidationBlockers = (params: {
  title: string;
  summary?: string | null;
  proofBundle: FindingValidationProofBundle;
  evidence: ReadonlyArray<{ kind: string; data?: unknown }>;
}): string[] => {
  if (!CORS_FINDING_PATTERN.test(`${params.title} ${params.summary ?? ''}`)) return [];

  const protectedReadProven = params.proofBundle.obligations.some((obligation) =>
    obligation.status === 'proven' &&
    PROTECTED_DATA_PATTERN.test(`${obligation.observable} ${obligation.note ?? ''}`),
  );
  const ambientAuthorityProven = params.proofBundle.obligations.some((obligation) =>
    obligation.status === 'proven' &&
    AMBIENT_AUTHORITY_PATTERN.test(`${obligation.observable} ${obligation.note ?? ''}`),
  );
  const browserReads = params.evidence
    .filter((entry) => entry.kind === 'http_exchange')
    .map((entry) => asFindingHttpExchange(entry.data))
    .filter((entry): entry is FindingHttpExchange => entry !== null && entry.source === 'browser');
  const readableProtectedExchange = browserReads.find((exchange) => {
    const origin = headerValue(exchange.request.headers, 'origin');
    const allowedOrigin = headerValue(exchange.response.headers, 'access-control-allow-origin');
    const allowsCredentials = headerValue(exchange.response.headers, 'access-control-allow-credentials');
    const responseBody = exchange.response.body?.text?.trim() ?? '';
    return Boolean(
      origin &&
      allowedOrigin &&
      allowedOrigin !== '*' &&
      normalizedOrigin(origin) === normalizedOrigin(allowedOrigin) &&
      allowsCredentials?.toLowerCase() === 'true' &&
      exchange.response.statusCode >= 200 &&
      exchange.response.statusCode < 300 &&
      responseBody.length > 0,
    );
  });
  const hasAmbientAuthority = browserReads.some((exchange) =>
    Boolean(headerValue(exchange.request.headers, 'cookie')),
  ) || ambientAuthorityProven;

  const blockers: string[] = [];
  if (
    params.proofBundle.proof.replayAttempted !== true ||
    params.proofBundle.proof.replayReproduced !== true
  ) {
    blockers.push('a reproduced browser replay');
  }
  if (!readableProtectedExchange) {
    blockers.push('a browser HTTP exchange with matching Origin/Access-Control-Allow-Origin, Access-Control-Allow-Credentials: true, and a readable successful response body');
  }
  if (!protectedReadProven) {
    blockers.push('a proven obligation that the readable response contains protected evaluator data');
  }
  if (!hasAmbientAuthority) {
    blockers.push('evidence of ambient browser authority such as an attached Cookie header or an explicit ambient-credential proof claim');
  }
  return blockers;
};

export class FindingValidationService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options: {
      now?: () => Date;
      normalizeSessionId: (raw: string | undefined) => string | undefined;
      normalizeToolText: (value: string) => string;
      resolveFindingEvidenceEntries: (
        workspaceDir: string,
        evidence: Array<z.infer<typeof EvidenceRefSchema> | StructuredHttpEvidenceInput>,
      ) => Promise<ResolvedFindingEvidence[]>;
      hasDurableFindingEvidence: (evidence: ResolvedFindingEvidence[]) => boolean;
      emitRunSystemEvent: (runId: string | undefined, note: string) => Promise<void>;
    },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async validateProofEvidenceIds(params: {
    workspaceDir: string;
    proof: FindingValidationProofInput;
    knownEvidenceIds: Set<string>;
  }): Promise<void> {
    await assertProofEvidenceIdsResolvable({
      workspaceDir: params.workspaceDir,
      evidenceIds: params.proof.evidenceIds,
      knownEvidenceIds: params.knownEvidenceIds,
      errorPrefix: 'submit_validation_outcome blocked',
    });
  }

  private defaultProofObligation(params: {
    findingTitle: string;
    findingSummary?: string | null;
    proof: FindingValidationProofInput;
  }): FindingProofObligation {
    const text = `${params.findingTitle} ${params.findingSummary ?? ''}`.toLowerCase();
    let observable = 'Evidence directly demonstrates the validated security claim.';
    if (CORS_FINDING_PATTERN.test(text)) {
      observable = 'A foreign browser origin reads protected evaluator data using ambient browser authority.';
    } else if (/\b(idor|bola|authorization|authz|tenant|object reference|cross-tenant)\b/u.test(text)) {
      observable = 'Response demonstrates access to another principal, tenant, or object beyond the authorized boundary.';
    } else if (/\b(xss|cross-site scripting|script)\b/u.test(text)) {
      observable = 'Response or rendered page reflects executable attacker-controlled script in the vulnerable context.';
    } else if (/\b(sql|injection|command injection|rce|remote code)\b/u.test(text)) {
      observable = 'Payload changes server-side execution behavior or returns a response proving injection impact.';
    } else if (/\b(ssrf|xxe|blind|oob|out-of-band)\b/u.test(text)) {
      observable = 'Out-of-band interaction or equivalent callback proves target-side execution of the injected request.';
    } else if (/\b(secret|token|credential|sensitive)\b/u.test(text)) {
      observable = 'Evidence exposes sensitive material that should not be available to the tested principal.';
    }

    const status: FindingProofObligationStatus =
      params.proof.notReplayedReason ? 'needs_context' : params.proof.evidenceIds.length > 0 ? 'proven' : 'unproven';
    return {
      id: 'primary-observable',
      observable,
      status,
      evidenceIds: params.proof.evidenceIds,
      ...(params.proof.notReplayedReason
        ? { note: `Replay not applicable or pending: ${params.proof.notReplayedReason}` }
        : {}),
    };
  }

  private buildProofObligations(params: {
    findingTitle: string;
    findingSummary?: string | null;
    proof: FindingValidationProofInput;
    inputs: FindingProofObligationInput[];
  }): FindingProofObligation[] {
    const source =
      params.inputs.length > 0
        ? params.inputs
        : [this.defaultProofObligation({
            findingTitle: params.findingTitle,
            findingSummary: params.findingSummary,
            proof: params.proof,
          })];
    return source.map((entry, index) => ({
      id: entry.id ?? `obligation-${index + 1}`,
      observable: this.options.normalizeToolText(entry.observable),
      status: entry.status,
      evidenceIds: uniqueStrings(entry.evidenceIds),
      ...(entry.note ? { note: this.options.normalizeToolText(entry.note) } : {}),
    }));
  }

  private buildAdvisoryTriage(params: {
    outcome: 'validated' | 'false_positive' | 'inconclusive';
    proof: FindingValidationProof;
    obligations: FindingProofObligation[];
    input?: AdvisoryTriageInput;
  }): FindingAdvisoryTriage {
    const flags = new Set<FindingAdvisoryTriageFlag>(params.input?.flags ?? []);
    if (params.obligations.some((entry) => entry.status === 'unproven')) {
      flags.add('weak_evidence');
    }
    if (params.proof.notReplayedReason && REPLAY_RISKY_ESCAPE_REASONS.has(params.proof.notReplayedReason)) {
      flags.add('risky_to_replay');
    }
    if (params.input?.duplicateOf) {
      flags.add('duplicate');
    }

    const defaultVerdict =
      params.outcome === 'validated'
        ? params.proof.notReplayedReason || params.obligations.some((entry) => entry.status !== 'proven')
          ? 'needs_context'
          : 'agree'
        : 'needs_context';

    return {
      verdict: params.input?.verdict ?? defaultVerdict,
      reason: this.options.normalizeToolText(
        params.input?.reason ??
          (defaultVerdict === 'agree'
            ? 'Passive proof-shape check agrees: claim, bound evidence, and proof obligation are present.'
            : 'Passive proof-shape check recorded reviewer context without changing canonical Risk state.'),
      ),
      triagedBy: params.input?.triagedBy ?? 'inline_validation_advisory',
      evidenceIds: uniqueStrings(params.input?.evidenceIds.length ? params.input.evidenceIds : params.proof.evidenceIds),
      ...(params.input?.duplicateOf ? { duplicateOf: params.input.duplicateOf } : {}),
      flags: Array.from(flags).sort(),
    };
  }

  private buildValidationProofBundle(params: {
    findingTitle: string;
    findingSummary?: string | null;
    outcome: 'validated' | 'false_positive' | 'inconclusive';
    proof: FindingValidationProofInput;
    obligations: FindingProofObligationInput[];
    triage?: AdvisoryTriageInput;
  }): FindingValidationProofBundle {
    const proof: FindingValidationProof = {
      claim: this.options.normalizeToolText(params.proof.claim),
      evidenceIds: uniqueStrings(params.proof.evidenceIds),
      replayAttempted: params.proof.replayAttempted,
      ...(params.proof.replayArtifact ? { replayArtifact: params.proof.replayArtifact.trim() } : {}),
      ...(params.proof.replayReproduced !== undefined ? { replayReproduced: params.proof.replayReproduced } : {}),
      ...(params.proof.notReplayedReason ? { notReplayedReason: params.proof.notReplayedReason } : {}),
    };
    const obligations = this.buildProofObligations({
      findingTitle: params.findingTitle,
      findingSummary: params.findingSummary,
      proof: params.proof,
      inputs: params.obligations,
    });
    return {
      schemaVersion: 1,
      proof,
      obligations,
      advisoryTriage: this.buildAdvisoryTriage({
        outcome: params.outcome,
        proof,
        obligations,
        input: params.triage,
      }),
    };
  }

  private buildAuditEvidenceRefs(params: {
    findingId: string;
    completedAt: Date;
    evidenceRefs: Array<{ path: string; label?: string }>;
    validationProof: FindingValidationProofBundle;
  }): FindingValidationEvidenceRef[] {
    return [
      ...params.evidenceRefs,
      {
        kind: 'validation_proof',
        path: `validation-proof:${params.findingId}:${params.completedAt.toISOString()}`,
        label: 'Validation proof trail',
        ...params.validationProof,
      },
    ];
  }

  async promoteFinding(params: {
    userId: string;
    organizationId: string;
    input: unknown;
  }): Promise<PromoteFindingResult> {
    const parsed = PromoteFindingSchema.parse(params.input);
    const now = this.now();

    return this.db.transaction(async (tx) => {
      const [findingRow] = await tx
        .select({
          id: findings.id,
          title: findings.title,
          severity: findings.severity,
          summary: findings.summary,
          dedupeKey: findings.dedupeKey,
          state: findings.state,
          lifecycleVersion: findings.lifecycleVersion,
          organizationId: findings.organizationId,
          businessImpact: findings.businessImpact,
          technicalAnalysis: findings.technicalAnalysis,
          pocDescription: findings.pocDescription,
          assumptions: findings.assumptions,
          remediation: findings.remediation,
          fixEffort: findings.fixEffort,
          cweId: findings.cweId,
          cweIds: findings.cweIds,
          owaspCategory: findings.owaspCategory,
          cvssVector: findings.cvssVector,
          cvssScore: findings.cvssScore,
        })
        .from(findings)
        .where(
          and(
            eq(findings.id, parsed.findingId),
            eq(findings.userId, params.userId),
            eq(findings.organizationId, params.organizationId),
            eq(findings.sourceKind, 'assessment'),
          ),
        )
        .limit(1);

      if (!findingRow) {
        throw new Error(
          `promote_finding blocked: findingId ${parsed.findingId} was not found in this organization, or this user does not own it. ` +
            'Verify the ID with query_findings({ status: "all", severity: "all" }) and confirm you are calling under the same organization context.',
        );
      }
      if (findingRow.state === 'dismissed') {
        throw new Error(
          `promote_finding blocked: finding ${parsed.findingId} ("${findingRow.title}") is marked false_positive and cannot be promoted. ` +
            'If fresh evidence contradicts that determination, record a new candidate with report_finding and durable evidence instead of promoting the false-positive row.',
        );
      }
      const reportCompleteness = buildFindingReportCompleteness(findingRow);

      const evidenceRows = await tx
        .select({
          kind: findingEvidence.kind,
          path: findingEvidence.path,
          displayPath: findingEvidence.displayPath,
          label: findingEvidence.label,
          fileMissing: findingEvidence.fileMissing,
        })
        .from(findingEvidence)
        .where(eq(findingEvidence.findingId, parsed.findingId));

      const durableEvidence = evidenceRows.filter(
        (entry) => entry.kind === 'http_exchange' || entry.fileMissing !== true,
      );
      if (durableEvidence.length === 0) {
        const total = evidenceRows.length;
        const missingArtifacts = evidenceRows.filter((entry) => entry.fileMissing === true).length;
        const evidenceSummary =
          total === 0
            ? 'No evidence references are attached.'
            : `${total} evidence reference(s) are attached (${missingArtifacts} have fileMissing=true); none satisfy the durable-evidence floor.`;
        throw new Error(
          `promote_finding blocked: finding ${parsed.findingId} ("${findingRow.title}") has no durable evidence. ${evidenceSummary} ` +
            'Durable evidence means at least one http_exchange entry, or a non-missing artifact (file/screenshot/log/code_location). ' +
            `Call report_finding with validatesFindingId="${parsed.findingId}" and attach an HTTP exchange or persisted artifact, then retry promote_finding with a rationale that names the new proof.`,
        );
      }

      const [duplicateReportable] = await tx
        .select({ id: findings.id, title: findings.title, severity: findings.severity })
        .from(findings)
        .where(
          and(
            eq(findings.organizationId, params.organizationId),
            eq(findings.sourceKind, 'assessment'),
            eq(findings.dedupeKey, findingRow.dedupeKey),
            inArray(findings.state, [...REPORTABLE_RISK_STATES]),
            sql`${findings.id} <> ${parsed.findingId}`,
          ),
        )
        .limit(1);

      if (duplicateReportable) {
        throw new Error(
          `promote_finding blocked: finding ${parsed.findingId} duplicates an already-reportable finding. ` +
            `Existing reportable: ${duplicateReportable.id} ("${duplicateReportable.title}", ${duplicateReportable.severity}) covers the same scope, surface, and proof class (dedupeKey="${findingRow.dedupeKey}"). ` +
            `Do not promote a duplicate. If your evidence is new or stronger, call report_finding with validatesFindingId="${duplicateReportable.id}" to merge it into the existing reportable row.`,
        );
      }

      if (findingRow.state === 'verifying') {
        return {
          findingId: parsed.findingId,
          promoted: false,
          alreadyReportable: false,
          state: 'verifying' as const,
          lifecycleStage: 'candidate' as const,
          dedupeKey: findingRow.dedupeKey,
          durableEvidenceCount: durableEvidence.length,
          validationPending: true as const,
          action: 'already_queued' as const,
          nextAction: 'submit_validation_outcome' as const,
          reportCompleteness,
        };
      }

      if (REPORTABLE_RISK_STATES.includes(
        findingRow.state as (typeof REPORTABLE_RISK_STATES)[number],
      )) {
        return {
          findingId: parsed.findingId,
          promoted: false,
          alreadyReportable: true,
          state: findingRow.state,
          lifecycleStage: 'reportable' as const,
          dedupeKey: findingRow.dedupeKey,
          durableEvidenceCount: durableEvidence.length,
          action: 'already_validated' as const,
          nextAction: 'none' as const,
          reportCompleteness,
        };
      }

      await tx
        .update(findings)
        .set({
          state: 'verifying',
          lifecycleVersion: findingRow.lifecycleVersion + 1,
          updatedAt: now,
        })
        .where(eq(findings.id, parsed.findingId));

      await tx.insert(findingEvents).values({
        organizationId: params.organizationId,
        userId: params.userId,
        findingId: parsed.findingId,
        type: 'state_changed',
        fromState: findingRow.state,
        toState: 'verifying',
        note: parsed.rationale
          ? `Validation requested via promote_finding: ${parsed.rationale.trim()}`
          : 'Validation requested via promote_finding',
        createdAt: now,
      });

      return {
        findingId: parsed.findingId,
        promoted: false,
        alreadyReportable: false,
        state: 'verifying' as const,
        lifecycleStage: 'candidate' as const,
        dedupeKey: findingRow.dedupeKey,
        durableEvidenceCount: durableEvidence.length,
        validationPending: true as const,
        action: 'queued' as const,
        nextAction: 'submit_validation_outcome' as const,
        reportCompleteness,
      };
    });
  }

  async submitValidationOutcome(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    organizationId: string;
    runId?: string;
    input: unknown;
    /**
     * Durable browser-captured exchanges resolved by the caller from workspace
     * artifacts (browser-network:<id> references in proof.evidenceIds). Merged
     * into the evidence persisted for this finding before the CORS gate runs.
     */
    structuredEvidence?: StructuredHttpEvidenceInput[];
  }): Promise<SubmitValidationOutcomeResult> {
    const parsed = SubmitValidationOutcomeSchema.parse(params.input);
    const sessionId = this.options.normalizeSessionId(params.sessionId);
    const now = this.now();
    const resolvedEvidence = await this.options.resolveFindingEvidenceEntries(
      params.workspaceDir,
      [...(parsed.evidence ?? []), ...(params.structuredEvidence ?? [])],
    );
    const auditEvidenceRefs = resolvedEvidence.map((entry) => ({
      path: entry.displayPath,
      ...(entry.label ? { label: entry.label } : {}),
    }));

    return this.db.transaction(async (tx) => {
      const [findingRow] = await tx
        .select({
          id: findings.id,
          title: findings.title,
          severity: findings.severity,
          summary: findings.summary,
          dedupeKey: findings.dedupeKey,
          state: findings.state,
          lifecycleVersion: findings.lifecycleVersion,
          businessImpact: findings.businessImpact,
          technicalAnalysis: findings.technicalAnalysis,
          pocDescription: findings.pocDescription,
          assumptions: findings.assumptions,
          remediation: findings.remediation,
          fixEffort: findings.fixEffort,
          cweId: findings.cweId,
          cweIds: findings.cweIds,
          owaspCategory: findings.owaspCategory,
          cvssVector: findings.cvssVector,
          cvssScore: findings.cvssScore,
        })
        .from(findings)
        .where(
          and(
            eq(findings.id, parsed.findingId),
            eq(findings.userId, params.userId),
            eq(findings.organizationId, params.organizationId),
            eq(findings.sourceKind, 'assessment'),
          ),
        )
        .limit(1);

      if (!findingRow) {
        throw new Error(
          `submit_validation_outcome blocked: findingId ${parsed.findingId} was not found in this organization, or this user does not own it.`,
        );
      }
      const reportCompleteness = buildFindingReportCompleteness(findingRow);

      if (findingRow.state === 'dismissed' && parsed.outcome === 'validated') {
        throw new Error(
          `submit_validation_outcome blocked: Risk ${parsed.findingId} is already dismissed. ` +
            'Record a fresh finding with durable evidence instead of reversing a rejected row from a worker tool.',
        );
      }

      for (const ev of resolvedEvidence) {
        await tx
          .insert(findingEvidence)
          .values({
            organizationId: params.organizationId,
            userId: params.userId,
            findingId: parsed.findingId,
            sessionId,
            kind: ev.kind,
            path: ev.path,
            displayPath: ev.displayPath,
            label: ev.label,
            excerpt: ev.kind === 'artifact' ? ev.excerpt : undefined,
            fileMissing: ev.kind === 'artifact' ? ev.fileMissing ?? false : false,
            data: ev.kind === 'http_exchange' ? ev.data : null,
            createdAt: now,
          })
          .onConflictDoNothing({
            target: [findingEvidence.findingId, findingEvidence.path],
          });
      }

      const evidenceRows = await tx
        .select({
          kind: findingEvidence.kind,
          path: findingEvidence.path,
          displayPath: findingEvidence.displayPath,
          label: findingEvidence.label,
          fileMissing: findingEvidence.fileMissing,
          sessionId: findingEvidence.sessionId,
          data: findingEvidence.data,
        })
        .from(findingEvidence)
        .where(eq(findingEvidence.findingId, parsed.findingId));

      const durableEvidence = evidenceRows.filter(
        (entry) => entry.kind === 'http_exchange' || entry.fileMissing !== true,
      );
      const workerEvidence = evidenceRows.filter((entry) => sessionId && entry.sessionId === sessionId);
      const workerDurableEvidence = workerEvidence.filter(
        (entry) => entry.kind === 'http_exchange' || entry.fileMissing !== true,
      );
      const submittedDurableEvidence = this.options.hasDurableFindingEvidence(resolvedEvidence);
      const knownEvidenceIds = new Set<string>();
      for (const entry of evidenceRows) {
        for (const value of [entry.path, entry.displayPath, entry.label]) {
          if (typeof value === 'string' && value.trim().length > 0) {
            knownEvidenceIds.add(value.trim());
            knownEvidenceIds.add(normalizeProofEvidenceId(value));
          }
        }
      }
      await this.validateProofEvidenceIds({
        workspaceDir: params.workspaceDir,
        proof: parsed.proof,
        knownEvidenceIds,
      });
      const validationProof = this.buildValidationProofBundle({
        findingTitle: findingRow.title,
        findingSummary: findingRow.summary,
        outcome: parsed.outcome,
        proof: parsed.proof,
        obligations: parsed.proofObligations,
        triage: parsed.advisoryTriage,
      });

      if (parsed.outcome === 'validated') {
        const corsBlockers = corsValidationBlockers({
          title: findingRow.title,
          summary: findingRow.summary,
          proofBundle: validationProof,
          evidence: evidenceRows,
        });
        if (corsBlockers.length > 0) {
          throw new Error(
            `submit_validation_outcome blocked: CORS validation requires ${corsBlockers.join('; ')}. ` +
              'Origin reflection, Access-Control-Allow-Credentials, raw HTTP output, or an unauthenticated error response alone is not a vulnerability.',
          );
        }
      }

      await tx.insert(findingValidationAudit).values({
        organizationId: params.organizationId,
        userId: params.userId,
        findingId: parsed.findingId,
        workerSessionId: sessionId,
        outcome: parsed.outcome,
        reason: this.options.normalizeToolText(parsed.reason),
        evidenceRefs: this.buildAuditEvidenceRefs({
          findingId: parsed.findingId,
          completedAt: now,
          evidenceRefs: auditEvidenceRefs,
          validationProof,
        }),
        completedAt: now,
        createdAt: now,
      });

      if (parsed.outcome === 'validated') {
        if (workerDurableEvidence.length === 0 && !submittedDurableEvidence) {
          throw new Error(
            `submit_validation_outcome blocked: validated outcome for finding ${parsed.findingId} must include durable evidence from the validator context. ` +
              'Attach a persisted artifact in evidence, or first call report_finding with validatesFindingId from the validator worker.',
          );
        }

        if (durableEvidence.length === 0) {
          throw new Error(
            `submit_validation_outcome blocked: finding ${parsed.findingId} has no durable evidence after validation.`,
          );
        }

        const [duplicateReportable] = await tx
          .select({ id: findings.id, title: findings.title, severity: findings.severity })
          .from(findings)
          .where(
            and(
              eq(findings.organizationId, params.organizationId),
              eq(findings.sourceKind, 'assessment'),
              eq(findings.dedupeKey, findingRow.dedupeKey),
              inArray(findings.state, [...REPORTABLE_RISK_STATES]),
              sql`${findings.id} <> ${parsed.findingId}`,
            ),
          )
          .limit(1);

        if (duplicateReportable) {
          throw new Error(
            `submit_validation_outcome blocked: finding ${parsed.findingId} duplicates an already-reportable finding. ` +
              `Existing reportable: ${duplicateReportable.id} ("${duplicateReportable.title}", ${duplicateReportable.severity}) covers the same scope, surface, and proof class (dedupeKey="${findingRow.dedupeKey}").`,
          );
        }

        const alreadyReportable = REPORTABLE_RISK_STATES.includes(
          findingRow.state as (typeof REPORTABLE_RISK_STATES)[number],
        );
        const nextState = findingRow.state === 'accepted' || findingRow.state === 'resolved'
          ? findingRow.state
          : 'confirmed';
        await tx
          .update(findings)
          .set({
            state: nextState,
            ...(nextState !== findingRow.state && {
              lifecycleVersion: findingRow.lifecycleVersion + 1,
            }),
            updatedAt: now,
          })
          .where(eq(findings.id, parsed.findingId));

        if (nextState !== findingRow.state) {
          await tx.insert(findingEvents).values({
            organizationId: params.organizationId,
            userId: params.userId,
            findingId: parsed.findingId,
            type: 'state_changed',
            fromState: findingRow.state,
            toState: nextState,
            note: `Validator confirmed Risk (${durableEvidence.length} durable evidence ref(s)): ${this.options.normalizeToolText(parsed.reason)}`,
            createdAt: now,
          });
        }

        await this.options.emitRunSystemEvent(
          params.runId,
          `Finding validated by independent worker: ${findingRow.title} (${findingRow.severity})`,
        );

        return {
          findingId: parsed.findingId,
          outcome: 'validated' as const,
          promoted: !alreadyReportable,
          alreadyReportable,
          state: nextState,
          lifecycleStage: 'reportable' as const,
          dedupeKey: findingRow.dedupeKey,
          durableEvidenceCount: durableEvidence.length,
          workerEvidenceCount: workerDurableEvidence.length + (submittedDurableEvidence ? 1 : 0),
          reportCompleteness,
          validationProof,
        };
      }

      const nextState = parsed.outcome === 'false_positive' ? 'dismissed' : 'verifying';
      await tx
        .update(findings)
        .set({
          state: nextState,
          ...(nextState !== findingRow.state && {
            lifecycleVersion: findingRow.lifecycleVersion + 1,
          }),
          updatedAt: now,
        })
        .where(eq(findings.id, parsed.findingId));

      if (nextState !== findingRow.state) {
        await tx.insert(findingEvents).values({
          organizationId: params.organizationId,
          userId: params.userId,
          findingId: parsed.findingId,
          type: 'state_changed',
          fromState: findingRow.state,
          toState: nextState,
          note:
            parsed.outcome === 'false_positive'
              ? `Validator dismissed Risk as false_positive: ${this.options.normalizeToolText(parsed.reason)}`
              : `Validator kept Risk in verification: ${this.options.normalizeToolText(parsed.reason)}`,
          createdAt: now,
        });
      }

      return {
        findingId: parsed.findingId,
        outcome: parsed.outcome,
        promoted: false,
        alreadyReportable: false,
        state: nextState,
        lifecycleStage: 'candidate' as const,
        dedupeKey: findingRow.dedupeKey,
        durableEvidenceCount: durableEvidence.length,
        workerEvidenceCount: workerDurableEvidence.length + (submittedDurableEvidence ? 1 : 0),
        reportCompleteness,
        validationProof,
      };
    });
  }
}
