import { createHash } from 'crypto';

import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import {
  agentArtifacts,
  agentSessions,
  auditLogs,
  complianceControlChecks,
  complianceEvidenceItems,
  complianceEvidenceMappings,
  findingEvidence,
  findings,
  runs,
  runPhases,
  scopes,
  type ComplianceControlCheckBasis,
  type ComplianceEvidenceSourceType,
} from '@/db/schema';
import {
  COMPLIANCE_FRAMEWORK_KEYS,
  FRAMEWORK_REGISTRY,
  type ComplianceFrameworkKey,
} from '@/domains/security-ops/compliance/frameworks';
import { resolveProofEvidenceReference } from '@/domains/security-ops/findings/ProofEvidenceReferenceResolver';
import { persistDurableAgentArtifactBuffer } from '@/domains/security-ops/artifacts/DurableAgentArtifact';

import { ComplianceReadinessService } from './ComplianceReadinessService';
import { complianceEvidenceHasDurableFile } from './ComplianceEvidenceService';

const ReplayEscapeReasonSchema = z.enum([
  'blind_oob',
  'race',
  'one_time_token',
  'non_idempotent',
  'unsafe_to_replay',
  'target_drift',
  'document_evidence_review',
  'integration_evidence_review',
  'other',
]);

const ControlCheckBasisSchema = z.enum([
  'agent_tested',
  'agent_reviewed_user_evidence',
  'agent_reviewed_integration',
]);

const ControlCheckReasonCodeSchema = z.enum([
  'control_operating',
  'control_failed',
  'missing_credentials',
  'missing_scope',
  'target_unavailable',
  'tooling_limit',
  'insufficient_evidence',
  'not_tested',
]);

const RAW_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu },
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/iu },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { name: 'password assignment', pattern: /\bpassword\s*[:=]\s*['"]?[^'"\s]{8,}/iu },
  { name: 'token assignment', pattern: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/iu },
  { name: 'secret query parameter', pattern: /[?&](?:key|token|auth|secret)=[^&#\s]{8,}/iu },
];

const findRawSecretLeak = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const match = RAW_SECRET_PATTERNS.find(({ pattern }) => pattern.test(value));
    return match?.name ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findRawSecretLeak(item);
      if (match) return match;
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const match = findRawSecretLeak(item);
      if (match) return match;
    }
  }
  return null;
};

export const RecordControlCheckSchema = z.object({
  frameworkKey: z.enum([...COMPLIANCE_FRAMEWORK_KEYS] as [ComplianceFrameworkKey, ...ComplianceFrameworkKey[]]),
  controlId: z.string().trim().min(1).max(128),
  basis: ControlCheckBasisSchema.optional().default('agent_tested'),
  verdict: z.enum(['pass', 'fail', 'needs_context', 'not_attempted']),
  reasonCode: ControlCheckReasonCodeSchema,
  reason: z.string().trim().min(10).max(2_000),
  proofObligationId: z.string().trim().min(1).max(160),
  evidenceRefs: z.array(z.string().trim().min(1).max(1_024)).max(100).optional().default([]),
  findingIds: z.array(z.string().uuid()).max(50).optional().default([]),
  artifactIds: z.array(z.string().trim().min(1).max(1_024)).max(100).optional().default([]),
  targetRef: z.string().trim().min(1).max(1_024),
  method: z.string().trim().min(3).max(300),
  limitations: z.array(z.string().trim().min(1).max(500)).max(30).optional().default([]),
  toolName: z.string().trim().min(1).max(120).optional(),
  skillSlug: z.string().trim().min(1).max(160).optional(),
  freshUntil: z.coerce.date().optional(),
  proof: z.object({
    claim: z.string().trim().min(10).max(2_000),
    evidenceIds: z.array(z.string().trim().min(1).max(1_024)).max(100).optional().default([]),
    replayAttempted: z.boolean().optional().default(false),
    replayArtifact: z.string().trim().min(1).max(1_024).optional(),
    replayReproduced: z.boolean().optional(),
    notReplayedReason: ReplayEscapeReasonSchema.optional(),
  }),
}).superRefine((value, ctx) => {
  const rawSecretLeak = findRawSecretLeak({
    reason: value.reason,
    evidenceRefs: value.evidenceRefs,
    targetRef: value.targetRef,
    method: value.method,
    limitations: value.limitations,
    proof: value.proof,
  });
  if (rawSecretLeak) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proof'],
      message: `control checks must reference access materials by approved handle; raw ${rawSecretLeak} detected`,
    });
  }

  const evidenceIds = new Set([...value.evidenceRefs, ...value.proof.evidenceIds]);
  if ((value.verdict === 'pass' || value.verdict === 'fail') && evidenceIds.size === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceRefs'],
      message: `${value.verdict} requires at least one bound evidence reference`,
    });
  }
  if (value.proof.replayReproduced === true && !value.proof.replayArtifact) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proof', 'replayArtifact'],
      message: 'proof.replayArtifact is required when proof.replayReproduced is true',
    });
  }
  if (value.proof.replayReproduced !== undefined && !value.proof.replayAttempted) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proof', 'replayAttempted'],
      message: 'proof.replayAttempted must be true when replayReproduced is reported',
    });
  }
  if (value.verdict === 'pass' || value.verdict === 'fail') {
    if (!value.proof.replayAttempted && !value.proof.notReplayedReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proof', 'notReplayedReason'],
        message: `${value.verdict} requires a reproduced check or a structured reason why replay is not applicable`,
      });
    }
    if (!value.proof.replayAttempted && value.proof.notReplayedReason === 'other') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proof', 'notReplayedReason'],
        message: `${value.verdict} requires a specific non-replay reason; generic other is not accepted for conclusive control checks`,
      });
    }
    if (value.proof.replayAttempted && value.proof.replayReproduced !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proof', 'replayReproduced'],
        message: `${value.verdict} cannot be conclusive when the attempted replay was not reproduced`,
      });
    }
  }
  if (value.verdict === 'pass' && value.reasonCode !== 'control_operating') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'pass requires control_operating' });
  }
  if (value.verdict === 'fail' && value.reasonCode !== 'control_failed') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'fail requires control_failed' });
  }
  if (value.verdict === 'needs_context' && ['control_operating', 'control_failed', 'not_tested'].includes(value.reasonCode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'needs_context requires a blocker reason code' });
  }
  if (value.verdict === 'not_attempted' && value.reasonCode !== 'not_tested') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'not_attempted requires not_tested' });
  }
});

export type RecordControlCheckInput = z.infer<typeof RecordControlCheckSchema>;

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();

const COMPLIANCE_EVIDENCE_REF_PREFIX = 'compliance-evidence:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const USER_EVIDENCE_SOURCE_TYPES = new Set<ComplianceEvidenceSourceType>(['user_upload', 'user_attestation']);

const evidenceReviewObligationId = (frameworkKey: ComplianceFrameworkKey, controlId: string): string =>
  `evidence-review:${frameworkKey}:${controlId.toLowerCase()}`;

const safeEvidencePathPart = (value: string): string => {
  const normalized = value.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
  return normalized.slice(0, 120) || 'evidence';
};

const parseComplianceEvidenceRef = (value: string): { id: string; explicit: boolean } | null => {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith(COMPLIANCE_EVIDENCE_REF_PREFIX)) {
    const id = trimmed.slice(COMPLIANCE_EVIDENCE_REF_PREFIX.length).trim();
    return UUID_PATTERN.test(id) ? { id, explicit: true } : null;
  }
  return UUID_PATTERN.test(trimmed) ? { id: trimmed, explicit: false } : null;
};

const normalizeComplianceEvidenceRef = (id: string): string => `${COMPLIANCE_EVIDENCE_REF_PREFIX}${id}`;

const canonicalControlIdForFramework = (
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
): string => {
  const trimmed = controlId.trim();
  const framework = FRAMEWORK_REGISTRY[frameworkKey];
  return framework.controls.find((candidate) => candidate.id.toLowerCase() === trimmed.toLowerCase())?.id ?? trimmed;
};

const pgCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown; cause?: unknown };
  return typeof record.code === 'string' ? record.code : pgCode(record.cause);
};

export class ComplianceControlCheckService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async persistPortableProofEvidence(params: {
    sessionId: string;
    workspaceDir: string;
    evidenceRefs: string[];
    knownEvidenceIds: ReadonlySet<string>;
  }): Promise<string[]> {
    const artifactIds: string[] = [];
    for (const evidenceRef of params.evidenceRefs) {
      const resolution = await resolveProofEvidenceReference({
        workspaceDir: params.workspaceDir,
        evidenceId: evidenceRef,
        knownEvidenceIds: params.knownEvidenceIds,
      });
      if (resolution.resolutionStatus === 'unresolved') {
        throw new Error(
          `record_control_check blocked: proof.evidenceIds include unresolved reference(s): ${evidenceRef}. ` +
            'Use finding evidence paths, structured HTTP exchange IDs, raw-http:<exchangeId> with a persisted manifest, or a workspace artifact path.',
        );
      }
      if (resolution.resolutionStatus === 'oversized') {
        throw new Error(
          `record_control_check blocked: proof evidence reference ${evidenceRef} is too large for portable audit evidence. ` +
            'Attach a smaller summary artifact or cite durable finding evidence.',
        );
      }
      for (const file of resolution.files) {
        if (file.content.length === 0) {
          continue;
        }
        const artifact = await persistDurableAgentArtifactBuffer({
          db: this.db,
          sessionId: params.sessionId,
          originalName: [
            'compliance-proof',
            safeEvidencePathPart(resolution.normalizedReference),
            safeEvidencePathPart(file.relativePath),
          ].join('/'),
          fileType: file.mimeType,
          content: file.content,
        });
        artifactIds.push(artifact.id);
      }
    }
    return uniqueStrings(artifactIds);
  }

  private async validateComplianceEvidenceRefs(params: {
    organizationId: string;
    scopeId: string;
    frameworkKey: ComplianceFrameworkKey;
    controlId: string;
    basis: ComplianceControlCheckBasis;
    verdict: RecordControlCheckInput['verdict'];
    evidenceRefs: string[];
  }): Promise<{
    evidenceRefs: string[];
    workspaceEvidenceRefs: string[];
  }> {
    const parsedRefs = params.evidenceRefs.map((ref) => ({ ref, parsed: parseComplianceEvidenceRef(ref) }));
    const candidateIds = Array.from(
      new Set(parsedRefs.map((entry) => entry.parsed?.id).filter((id): id is string => Boolean(id))),
    );

    const evidenceRows = candidateIds.length > 0
      ? await this.db
          .select()
          .from(complianceEvidenceItems)
          .where(inArray(complianceEvidenceItems.id, candidateIds))
      : [];
    const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));

    const explicitMissing = parsedRefs
      .filter((entry) => entry.parsed?.explicit && !evidenceById.has(entry.parsed.id))
      .map((entry) => entry.ref);
    if (explicitMissing.length > 0) {
      throw new Error(`Compliance evidence reference not found: ${explicitMissing.join(', ')}`);
    }

    const complianceEvidenceIds = candidateIds.filter((id) => evidenceById.has(id));
    const mappings = complianceEvidenceIds.length > 0
      ? await this.db
          .select()
          .from(complianceEvidenceMappings)
          .where(inArray(complianceEvidenceMappings.evidenceItemId, complianceEvidenceIds))
      : [];
    const mappingsByItemId = new Map<string, typeof mappings>();
    for (const mapping of mappings) {
      const list = mappingsByItemId.get(mapping.evidenceItemId) ?? [];
      list.push(mapping);
      mappingsByItemId.set(mapping.evidenceItemId, list);
    }

    const matchedSourceTypes = new Set<ComplianceEvidenceSourceType>();
    const normalizedRefs: string[] = [];
    const workspaceEvidenceRefs: string[] = [];

    for (const { ref, parsed } of parsedRefs) {
      const row = parsed ? evidenceById.get(parsed.id) : null;
      if (!row) {
        workspaceEvidenceRefs.push(ref);
        normalizedRefs.push(ref);
        continue;
      }
      if (row.organizationId !== params.organizationId) {
        throw new Error('Compliance evidence reference is outside the current organization');
      }
      if (row.scopeId && row.scopeId !== params.scopeId) {
        throw new Error('Compliance evidence reference is outside the current scope');
      }
      const hasControlMapping = (mappingsByItemId.get(row.id) ?? []).some(
        (mapping) =>
          mapping.frameworkKey === params.frameworkKey &&
          mapping.controlId.trim().toLowerCase() === params.controlId.toLowerCase(),
      );
      if (!hasControlMapping) {
        throw new Error(`Compliance evidence ${row.id} is not mapped to ${params.frameworkKey}/${params.controlId}`);
      }
      if ((row.sourceType === 'user_upload' || row.sourceType === 'user_attestation' || row.sourceType === 'integration') &&
        !complianceEvidenceHasDurableFile(row.artifact)) {
        throw new Error(`Compliance evidence ${row.id} does not have a durable stored file`);
      }
      matchedSourceTypes.add(row.sourceType);
      normalizedRefs.push(normalizeComplianceEvidenceRef(row.id));
    }

    if (params.basis === 'agent_reviewed_user_evidence' && params.verdict !== 'not_attempted') {
      const hasUserEvidence = Array.from(matchedSourceTypes).some((sourceType) => USER_EVIDENCE_SOURCE_TYPES.has(sourceType));
      if (!hasUserEvidence) {
        throw new Error('agent_reviewed_user_evidence checks require at least one mapped user-uploaded evidence reference');
      }
    }
    if (params.basis === 'agent_reviewed_integration' && params.verdict !== 'not_attempted' && !matchedSourceTypes.has('integration')) {
      throw new Error('agent_reviewed_integration checks require at least one mapped integration evidence reference');
    }

    return {
      evidenceRefs: uniqueStrings(normalizedRefs),
      workspaceEvidenceRefs: uniqueStrings(workspaceEvidenceRefs),
    };
  }

  async record(params: {
    userId: string;
    organizationId: string;
    scopeId: string;
    runId: string;
    sessionId: string;
    workspaceDir: string;
    input: unknown;
  }): Promise<{ checkId: string; created: boolean; verdict: RecordControlCheckInput['verdict']; freshUntil: string }> {
    const parsedInput = RecordControlCheckSchema.parse(params.input);
    const input: RecordControlCheckInput = {
      ...parsedInput,
      controlId: canonicalControlIdForFramework(parsedInput.frameworkKey, parsedInput.controlId),
    };
    const framework = FRAMEWORK_REGISTRY[input.frameworkKey];
    const control = framework.controls.find((candidate) => candidate.id === input.controlId);
    if (!control) {
      throw new Error(`Unknown compliance control ${input.frameworkKey}/${input.controlId}`);
    }
    if (input.basis === 'agent_tested' && !control.proofObligation) {
      throw new Error(`Control ${input.frameworkKey}/${input.controlId} does not have an authored proof obligation yet`);
    }
    const allowedObligationIds =
      input.basis === 'agent_tested'
        ? [control.proofObligation?.id].filter((value): value is string => Boolean(value))
        : uniqueStrings([
            control.proofObligation?.id ?? '',
            evidenceReviewObligationId(input.frameworkKey, input.controlId),
          ]);
    if (!allowedObligationIds.includes(input.proofObligationId)) {
      throw new Error(`proofObligationId must equal one of: ${allowedObligationIds.join(', ')}`);
    }
    if (input.verdict === 'pass' && input.basis === 'agent_tested' && control.supportLevel !== 'automated_testable') {
      throw new Error(`Agent checks cannot pass ${control.supportLevel} controls`);
    }
    if (
      input.verdict === 'pass' &&
      input.basis === 'agent_tested' &&
      input.skillSlug &&
      !(control.testSkillSlugs ?? control.skillSlugs ?? []).includes(input.skillSlug)
    ) {
      throw new Error(`Skill ${input.skillSlug} is not allowed to prove ${input.frameworkKey}/${input.controlId}`);
    }

    const [scope, run, session, phaseSessions] = await Promise.all([
      this.db.select({ id: scopes.id }).from(scopes).where(and(eq(scopes.id, params.scopeId), eq(scopes.organizationId, params.organizationId))).limit(1),
      this.db.select({
        id: runs.id,
        complianceFrameworkKey: runs.complianceFrameworkKey,
        sessionId: runs.sessionId,
        plannerSessionId: runs.plannerSessionId,
        executorSessionId: runs.executorSessionId,
      }).from(runs).where(and(eq(runs.id, params.runId), eq(runs.organizationId, params.organizationId), eq(runs.scopeId, params.scopeId))).limit(1),
      this.db.select({ id: agentSessions.id, scopeId: agentSessions.scopeId, userId: agentSessions.userId }).from(agentSessions).where(eq(agentSessions.id, params.sessionId)).limit(1),
      this.db.select({ sessionId: runPhases.sessionId }).from(runPhases).where(eq(runPhases.runId, params.runId)),
    ]);
    if (!scope[0]) throw new Error('Scope not found for organization');
    if (!run[0]) throw new Error('Run not found for organization and scope');
    if (!session[0] || session[0].scopeId !== params.scopeId || (session[0].userId && session[0].userId !== params.userId)) {
      throw new Error('Session is not bound to the current user and scope');
    }
    const runSessionIds = new Set([
      run[0].sessionId,
      run[0].plannerSessionId,
      run[0].executorSessionId,
      ...phaseSessions.map((phase) => phase.sessionId),
    ].filter((value): value is string => Boolean(value)));
    if (!runSessionIds.has(params.sessionId)) {
      throw new Error('Session is not bound to the current run');
    }
    if (run[0].complianceFrameworkKey && run[0].complianceFrameworkKey !== input.frameworkKey) {
      throw new Error(
        `record_control_check is scoped to ${run[0].complianceFrameworkKey} for this run; ` +
          `received ${input.frameworkKey}/${input.controlId}`,
      );
    }

    const selectedFrameworks = await new ComplianceReadinessService(this.db).getScopeReadiness({
      organizationId: params.organizationId,
      scopeId: params.scopeId,
    });
    if (!selectedFrameworks.selectedFrameworks.some((selected) => selected.key === input.frameworkKey)) {
      throw new Error(`Framework ${input.frameworkKey} is not selected for this scope`);
    }

    const findingRows = input.findingIds.length > 0
      ? await this.db.select({ id: findings.id }).from(findings).where(and(
          eq(findings.organizationId, params.organizationId),
          eq(findings.scopeId, params.scopeId),
          inArray(findings.id, input.findingIds),
        ))
      : [];
    if (findingRows.length !== new Set(input.findingIds).size) {
      throw new Error('One or more findingIds are outside the current organization or scope');
    }

    const knownEvidenceRows = input.findingIds.length > 0
      ? await this.db.select({ id: findingEvidence.id, path: findingEvidence.path, displayPath: findingEvidence.displayPath })
          .from(findingEvidence)
          .where(and(
            eq(findingEvidence.organizationId, params.organizationId),
            inArray(findingEvidence.findingId, input.findingIds),
            inArray(findingEvidence.sessionId, [...runSessionIds]),
          ))
      : [];
    const explicitArtifactRefs = uniqueStrings(input.artifactIds);
    const knownArtifactRows = explicitArtifactRefs.length > 0
      ? await this.db.select({ id: agentArtifacts.id, filePath: agentArtifacts.filePath, originalName: agentArtifacts.originalName })
          .from(agentArtifacts)
          .where(and(
            inArray(agentArtifacts.sessionId, [...runSessionIds]),
            or(
              inArray(agentArtifacts.id, explicitArtifactRefs),
              inArray(agentArtifacts.filePath, explicitArtifactRefs),
              inArray(agentArtifacts.originalName, explicitArtifactRefs),
            ),
          ))
      : [];
    const knownEvidenceIds = new Set([
      ...knownEvidenceRows.flatMap((row) => [row.id, row.path, row.displayPath ?? '']),
      ...knownArtifactRows.flatMap((row) => [row.id, row.filePath, row.originalName]),
    ].filter((value): value is string => Boolean(value)));
    const evidenceValidation = await this.validateComplianceEvidenceRefs({
      organizationId: params.organizationId,
      scopeId: params.scopeId,
      frameworkKey: input.frameworkKey,
      controlId: input.controlId,
      basis: input.basis,
      verdict: input.verdict,
      evidenceRefs: uniqueStrings([
        ...input.evidenceRefs,
        ...input.proof.evidenceIds,
        ...input.artifactIds,
        input.proof.replayArtifact ?? '',
      ]),
    });
    const evidenceRefs = evidenceValidation.evidenceRefs;

    const now = this.now();
    const maximumFreshUntil = new Date(now.getTime() + (control.freshnessWindowDays ?? 90) * 86_400_000);
    const freshUntil = input.freshUntil && input.freshUntil < maximumFreshUntil ? input.freshUntil : maximumFreshUntil;
    if (freshUntil <= now) {
      throw new Error('freshUntil must be in the future');
    }

    const findingIds = uniqueStrings(input.findingIds);
    const limitations = uniqueStrings(input.limitations);
    const idempotencyKey = createHash('sha256').update(JSON.stringify({
      organizationId: params.organizationId,
      scopeId: params.scopeId,
      runId: params.runId,
      sessionId: params.sessionId,
      frameworkKey: input.frameworkKey,
      controlId: input.controlId,
      basis: input.basis,
      verdict: input.verdict,
      reasonCode: input.reasonCode,
      targetRef: input.targetRef,
      method: input.method,
      evidenceRefs,
      findingIds,
      claim: input.proof.claim,
    })).digest('hex');

    const existing = await this.db.select({ id: complianceControlChecks.id, freshUntil: complianceControlChecks.freshUntil })
      .from(complianceControlChecks).where(eq(complianceControlChecks.idempotencyKey, idempotencyKey)).limit(1);
    if (existing[0]) {
      return { checkId: existing[0].id, created: false, verdict: input.verdict, freshUntil: existing[0].freshUntil.toISOString() };
    }
    const persistedProofArtifactIds = await this.persistPortableProofEvidence({
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      evidenceRefs: evidenceValidation.workspaceEvidenceRefs,
      knownEvidenceIds,
    });
    const artifactIds = uniqueStrings([...input.artifactIds, ...persistedProofArtifactIds]);

    try {
      const row = await this.db.transaction(async (tx) => {
        const [created] = await tx.insert(complianceControlChecks).values({
          organizationId: params.organizationId,
          scopeId: params.scopeId,
          runId: params.runId,
          sessionId: params.sessionId,
          frameworkKey: input.frameworkKey,
          controlId: input.controlId,
          catalogRef: control.catalogRef ?? `${input.frameworkKey}:${input.controlId}`,
          basis: input.basis,
          verdict: input.verdict,
          reasonCode: input.reasonCode,
          reason: input.reason,
          proofObligationId: input.proofObligationId,
          method: input.method,
          toolName: input.toolName ?? null,
          skillSlug: input.skillSlug ?? null,
          targetRef: input.targetRef,
          evidenceRefs,
          findingIds,
          artifactIds,
          proof: { ...input.proof, evidenceIds: evidenceRefs },
          limitations,
          freshUntil,
          createdByActorType: 'agent',
          createdByActorId: params.sessionId,
          idempotencyKey,
        }).returning();
        if (!created) throw new Error('Failed to create compliance control check');
        await tx.insert(auditLogs).values({
          organizationId: params.organizationId,
          actorId: params.sessionId,
          actorType: 'system',
          action: 'compliance.control_check.recorded',
          resourceType: 'compliance_control_check',
          resourceId: created.id,
          changes: { frameworkKey: input.frameworkKey, controlId: input.controlId, verdict: input.verdict },
          metadata: { runId: params.runId, scopeId: params.scopeId, sessionId: params.sessionId },
        });
        return created;
      });
      return { checkId: row.id, created: true, verdict: row.verdict, freshUntil: row.freshUntil.toISOString() };
    } catch (error) {
      if (pgCode(error) === '23505') {
        const duplicate = await this.db.select({ id: complianceControlChecks.id, freshUntil: complianceControlChecks.freshUntil })
          .from(complianceControlChecks).where(eq(complianceControlChecks.idempotencyKey, idempotencyKey)).limit(1);
        if (duplicate[0]) {
          return { checkId: duplicate[0].id, created: false, verdict: input.verdict, freshUntil: duplicate[0].freshUntil.toISOString() };
        }
      }
      throw error;
    }
  }
}
