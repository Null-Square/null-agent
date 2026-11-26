import { z } from 'zod';

import type {
  EnumerationMissionV1,
  EnumerationServerAttemptRecordV1,
  EnumerationWorkerResultV1,
  MissionEnvelope,
  WorkerTaskRecord,
} from '../types';
import { sha256Hex } from './sha256';

export const ENUMERATION_RESULT_ARTIFACT_TYPE = 'enumeration_result/v1';
export const ENUMERATION_MISSION_KIND = 'enumeration_hunt_v1';
export const ENUMERATION_ARTIFACT_ROOT = '/workspace/.artifacts/workers/enumeration';
export const B1_ACCEPTED_CATALOG_VERSION = '3.0.0-b1';
export const B1_ACCEPTED_CATALOG_DIGEST =
  'd97c8e6451f339786e0e7e5152a7c5bb5bd13d767fde3527339b28ec9789e74b';

export const ENUMERATION_DEFAULT_BUDGETS = {
  maxToolCalls: 45,
  maxTargetRequests: 100,
  maxRequestConcurrency: 2,
  maxWallSeconds: 900,
  maxArtifactFiles: 15,
  maxArtifactBytes: 5 * 1024 * 1024,
  maxLeads: 15,
  maxStateChanges: 0 as const,
};

export const ENUMERATION_MAX_BUDGETS = {
  maxToolCalls: 90,
  maxTargetRequests: 250,
  maxRequestConcurrency: 6,
  maxWallSeconds: 1800,
  maxArtifactFiles: 50,
  maxArtifactBytes: 10 * 1024 * 1024,
  maxLeads: 40,
  maxStateChanges: 0 as const,
};

export type EnumerationLifecycleAdmission = {
  allowed: boolean;
  reason?:
    | 'request_budget_exhausted'
    | 'deadline_exhausted'
    | 'target_request_already_issued'
    | 'retry_limit_reached'
    | 'artifact_already_produced';
  remainingTargetRequests: number;
  remainingWallMs: number;
};

export const resolveEnumerationContinuationAdmission = (
  task: Pick<WorkerTaskRecord, 'budget' | 'targetRequestsUsed' | 'deadlineAt'>,
  currentTime: number = Date.now(),
): EnumerationLifecycleAdmission => {
  const remainingTargetRequests = Math.max(
    0,
    (task.budget?.maxTargetRequests ?? 0) - (task.targetRequestsUsed ?? 0),
  );
  const remainingWallMs = Math.max(0, (task.deadlineAt ?? 0) - currentTime);
  const snapshot = {
    remainingTargetRequests,
    remainingWallMs,
  };
  if (remainingTargetRequests <= 0) {
    return { allowed: false, reason: 'request_budget_exhausted', ...snapshot };
  }
  if (remainingWallMs <= 0) {
    return { allowed: false, reason: 'deadline_exhausted', ...snapshot };
  }
  return { allowed: true, ...snapshot };
};

export const resolveEnumerationInfrastructureRetryAdmission = (
  task: Pick<
    WorkerTaskRecord,
    'artifact' | 'budget' | 'deadlineAt' | 'retryIndex' | 'targetRequestsUsed'
  >,
  currentTime: number = Date.now(),
): EnumerationLifecycleAdmission => {
  const continuation = resolveEnumerationContinuationAdmission(task, currentTime);
  if (!continuation.allowed) {
    return continuation;
  }
  if ((task.targetRequestsUsed ?? 0) > 0) {
    return { ...continuation, allowed: false, reason: 'target_request_already_issued' };
  }
  if ((task.retryIndex ?? 0) >= 1) {
    return { ...continuation, allowed: false, reason: 'retry_limit_reached' };
  }
  if (task.artifact) {
    return { ...continuation, allowed: false, reason: 'artifact_already_produced' };
  }
  return continuation;
};

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uniqueTextArray = (maximum: number) =>
  z.array(text).min(1).max(maximum).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'values must be unique' });
    }
  });
const optionalUniqueTextArray = (maximum: number) =>
  z.array(text).max(maximum).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'values must be unique' });
    }
  });

const skillRefSchema = z.object({
  slug: text,
  versionHash: hash,
}).strict();

const surfaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('endpoint_set'), refs: uniqueTextArray(25) }).strict(),
  z.object({ kind: z.literal('api_operation_set'), refs: uniqueTextArray(25) }).strict(),
  z.object({ kind: z.literal('path_prefix_set'), refs: uniqueTextArray(3) }).strict(),
  z.object({ kind: z.literal('component'), refs: z.array(text).length(1) }).strict(),
  z.object({ kind: z.literal('client_bundle_set'), refs: uniqueTextArray(10) }).strict(),
  z.object({ kind: z.literal('repository_path_set'), refs: uniqueTextArray(20) }).strict(),
]);

export const EnumerationMissionV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal(ENUMERATION_MISSION_KIND),
  phaseAttemptId: text,
  targetRef: text,
  surface: surfaceSchema,
  techniqueIds: uniqueTextArray(8),
  primarySkill: skillRefSchema,
  supportingSkills: z.array(skillRefSchema).max(2),
  personaRefs: optionalUniqueTextArray(3),
  sourceMode: z.enum(['blackbox', 'greybox', 'whitebox']),
  impactCeiling: z.enum(['non_destructive', 'poc']),
  budgets: z.object({
    maxToolCalls: z.number().int().min(1).max(ENUMERATION_MAX_BUDGETS.maxToolCalls),
    maxTargetRequests: z.number().int().min(1).max(ENUMERATION_MAX_BUDGETS.maxTargetRequests),
    maxRequestConcurrency: z.number().int().min(1).max(ENUMERATION_MAX_BUDGETS.maxRequestConcurrency),
    maxWallSeconds: z.number().int().min(1).max(ENUMERATION_MAX_BUDGETS.maxWallSeconds),
    maxArtifactFiles: z.number().int().min(1).max(ENUMERATION_MAX_BUDGETS.maxArtifactFiles),
    maxArtifactBytes: z.number().int().min(1).max(ENUMERATION_MAX_BUDGETS.maxArtifactBytes),
    maxLeads: z.number().int().min(1).max(ENUMERATION_MAX_BUDGETS.maxLeads),
    maxStateChanges: z.literal(0),
  }).strict(),
  stop: z.object({
    whenTechniquesExhausted: z.literal(true),
    whenBlockedByPolicy: z.literal(true),
    maxHighConfidenceLeads: z.number().int().min(1).max(10),
  }).strict(),
  missionFingerprint: hash,
}).strict();

const blockerCodeSchema = z.enum([
  'credential_required',
  'auth_required',
  'account_state_required',
  'rate_limited',
  'target_unavailable',
  'out_of_scope',
  'waf_blocked',
  'policy_denied',
  'tool_unavailable',
  'prerequisite_missing',
  'budget_exhausted',
  'wall_timeout',
  'artifact_limit',
  'scope_ambiguous',
]);

const leadShape = {
  localId: text,
  serverFingerprint: hash.optional(),
  riskFamily: text,
  techniqueId: text,
  targetRef: text,
  surfaceRef: text,
  hypothesis: text.max(4_000),
  observation: text.max(8_000),
  validationGoal: text.max(4_000),
  requiredControls: optionalUniqueTextArray(20),
  prerequisites: optionalUniqueTextArray(20),
  evidenceRefs: optionalUniqueTextArray(30),
  evidenceState: z.enum(['durable', 'needs_evidence']),
  confidence: z.number().min(0).max(1),
  priority: z.enum(['low', 'medium', 'high']),
  authContextClass: text.max(200),
  attemptFingerprints: optionalUniqueTextArray(40),
};

const leadBaseSchema = z.object(leadShape).strict();

const refineLeadEvidence = (
  lead: z.infer<typeof leadBaseSchema>,
  ctx: z.RefinementCtx,
): void => {
  if (lead.confidence >= 0.8 && lead.evidenceState !== 'needs_evidence' && lead.evidenceRefs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceRefs'],
      message: 'high-confidence leads require durable evidence or evidenceState="needs_evidence"',
    });
  }
};

const leadSchema = leadBaseSchema.superRefine(refineLeadEvidence);

const inputLeadSchema = z.object({
  ...leadShape,
  attemptFingerprints: optionalUniqueTextArray(40).optional().default([]),
}).strict().superRefine(refineLeadEvidence);

export const isEnumerationLeadValidatorEligible = (
  lead: EnumerationWorkerResultV1['leads'][number],
): boolean =>
  lead.evidenceState === 'durable' && lead.evidenceRefs.length > 0;

const negativeShape = {
  localId: text,
  surfaceRef: text,
  techniqueId: text,
  controlOrBaseline: text,
  attemptFingerprints: uniqueTextArray(40),
  evidenceRefs: optionalUniqueTextArray(30),
  conclusion: text.max(4_000),
  confidence: z.number().min(0).max(1),
};

const negativeSchema = z.object(negativeShape).strict();

const inputNegativeSchema = z.object({
  ...negativeShape,
  attemptFingerprints: optionalUniqueTextArray(40).optional().default([]),
}).strict();

const attemptSchema = z.object({
  fingerprint: hash,
  toolClass: text,
  actionClass: text,
  surfaceRef: text,
  techniqueId: text,
  personaClass: text.max(200),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  status: z.enum(['completed', 'blocked', 'failed']),
  requestCount: z.number().int().min(0).max(ENUMERATION_MAX_BUDGETS.maxTargetRequests),
  evidenceRefs: optionalUniqueTextArray(30),
  blockerCode: blockerCodeSchema.optional(),
}).strict();

const coverageSchema = z.object({
  requested: z.object({
    surfaceRefs: uniqueTextArray(25),
    techniqueIds: uniqueTextArray(8),
    personaClasses: optionalUniqueTextArray(4),
  }).strict(),
  attempted: z.object({
    surfaceRefs: optionalUniqueTextArray(25),
    techniqueIds: optionalUniqueTextArray(8),
    personaClasses: optionalUniqueTextArray(4),
  }).strict(),
  counts: z.object({
    attempts: z.number().int().min(0).max(200),
    requests: z.number().int().min(0).max(ENUMERATION_MAX_BUDGETS.maxTargetRequests),
    leads: z.number().int().min(0).max(ENUMERATION_MAX_BUDGETS.maxLeads),
    negativeResults: z.number().int().min(0).max(100),
  }).strict(),
  uncovered: z.array(z.object({
    kind: z.enum(['surface', 'technique', 'persona']),
    ref: text,
    reason: text,
  }).strict()).max(100),
}).strict();

const artifactRefSchema = z.object({
  id: text,
  path: text,
  sha256: hash,
  bytes: z.number().int().min(0).max(ENUMERATION_MAX_BUDGETS.maxArtifactBytes),
  contentType: text,
  purpose: text,
  sensitivity: z.enum(['public', 'internal', 'sensitive']),
}).strict();

export const EnumerationWorkerResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  missionFingerprint: hash,
  resultHash: hash,
  status: z.enum(['completed', 'partial', 'blocked', 'failed']),
  targetRef: text,
  surfaceRefs: uniqueTextArray(25),
  skills: z.array(skillRefSchema.extend({ role: z.enum(['primary', 'supporting']) })).min(1).max(3),
  leads: z.array(leadSchema).max(ENUMERATION_MAX_BUDGETS.maxLeads),
  negativeResults: z.array(negativeSchema).max(100),
  attempts: z.array(attemptSchema).max(200),
  coverage: coverageSchema,
  blockers: z.array(z.object({
    code: blockerCodeSchema,
    message: text.max(2_000),
    surfaceRef: text.optional(),
    techniqueId: text.optional(),
    prerequisite: text.optional(),
  }).strict()).max(50),
  artifacts: z.array(artifactRefSchema).max(25),
  recommendedValidationMissions: z.array(z.object({
    leadLocalId: text,
    question: text.max(2_000),
    requiredEvidence: uniqueTextArray(20),
    stopCondition: text.max(2_000),
    priority: z.enum(['low', 'medium', 'high']),
  }).strict()).max(5),
}).strict();

const enumerationInputAttemptSchema = z.record(z.string(), z.unknown());

export const EnumerationWorkerResultInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  missionFingerprint: z.string().optional(),
  resultHash: z.unknown().optional(),
  status: z.enum(['completed', 'partial', 'blocked', 'failed']),
  targetRef: z.string().optional(),
  surfaceRefs: z.array(z.string()).max(25).optional(),
  skills: z.unknown().optional(),
  leads: z.array(inputLeadSchema).max(10),
  negativeResults: z.array(inputNegativeSchema).max(100),
  attempts: z.array(enumerationInputAttemptSchema).max(200).optional().default([]),
  coverage: z.unknown().optional(),
  blockers: z.array(z.object({
    code: blockerCodeSchema,
    message: text.max(2_000),
    surfaceRef: text.optional(),
    techniqueId: text.optional(),
    prerequisite: text.optional(),
  }).strict()).max(50),
  artifacts: z.array(artifactRefSchema).max(25),
  recommendedValidationMissions: z.array(z.object({
    leadLocalId: text,
    question: text.max(2_000),
    requiredEvidence: uniqueTextArray(20),
    stopCondition: text.max(2_000),
    priority: z.enum(['low', 'medium', 'high']),
  }).strict()).max(5),
}).strict();

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

export const sha256Canonical = (value: unknown): string =>
  sha256Hex(JSON.stringify(canonicalize(value)));

export const computeEnumerationMissionFingerprint = (
  runId: string,
  mission: EnumerationMissionV1,
): string =>
  sha256Hex(
    [
      runId,
      mission.phaseAttemptId,
      mission.targetRef,
      mission.surface.kind,
      [...mission.surface.refs].sort().join(','),
      [...mission.techniqueIds].sort().join(','),
      [...mission.personaRefs].sort().join(','),
      mission.primarySkill.versionHash,
    ].join('|'),
  );

const stringArg = (
  args: Record<string, unknown>,
  names: readonly string[],
): string | undefined => {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const classifyInputValue = (key: string, value: unknown): unknown => {
  if (/(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/iu.test(key)) {
    return '<secret>';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => classifyInputValue(key, entry));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([entryKey]) => !/(?:toolCallId|requestId|timestamp|nonce)/iu.test(entryKey))
        .map(([entryKey, entry]) => [entryKey, classifyInputValue(entryKey, entry)]),
    );
  }
  if (typeof value !== 'string') {
    return typeof value;
  }
  if (/^(?:https?|wss?):\/\//iu.test(value)) {
    try {
      const parsed = new URL(value);
      const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}?${queryKeys.join('&')}`;
    } catch {
      return value.trim().toLowerCase();
    }
  }
  if (value.length > 128 || /(?:bearer\s+|basic\s+|-----begin\s)/iu.test(value)) {
    return `string:${value.length}`;
  }
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
};

const resolveAttemptSurfaceRef = (
  mission: EnumerationMissionV1,
  args: Record<string, unknown>,
): string => {
  const explicit = stringArg(args, ['surfaceRef', 'surface_ref']);
  if (explicit && mission.surface.refs.includes(explicit)) {
    return explicit;
  }
  const actionRef = stringArg(args, [
    'url',
    'uri',
    'target',
    'path',
    'endpoint',
    'operation',
    'repositoryPath',
    'repository_path',
    'filePath',
    'file_path',
  ]);
  if (actionRef) {
    const normalizedAction = actionRef.replace(/\\/gu, '/').toLowerCase();
    const matching = mission.surface.refs
      .filter((ref) => {
        const normalizedRef = ref.replace(/\\/gu, '/').toLowerCase();
        return normalizedAction === normalizedRef ||
          normalizedAction.startsWith(normalizedRef.endsWith('/') ? normalizedRef : `${normalizedRef}/`) ||
          normalizedAction.includes(normalizedRef);
      })
      .sort((left, right) => right.length - left.length)[0];
    if (matching) {
      return matching;
    }
  }
  return [...mission.surface.refs].sort()[0]!;
};

const classifyAttemptTool = (toolName: string): string => {
  if (toolName.startsWith('http_') || toolName === 'authz_replay') return 'http';
  if (toolName === 'browser_action') return 'browser';
  if (toolName.includes('repository')) return 'repository';
  if (toolName === 'shell_run' || toolName === 'wait_for_shell_job') return 'shell';
  if (toolName === 'python_session') return 'python';
  return toolName.replace(/[^a-z0-9_-]/giu, '_').toLowerCase();
};

export const buildEnumerationAttemptReservation = (
  mission: EnumerationMissionV1,
  toolName: string,
  args: Record<string, unknown>,
  requestCount: number,
  reservedAt: number,
): EnumerationServerAttemptRecordV1 => {
  const surfaceRef = resolveAttemptSurfaceRef(mission, args);
  const methodOrAction = stringArg(args, ['method', 'action', 'mode', 'operation']) ??
    (toolName.startsWith('http_') ? 'GET' : toolName);
  const actionClass = `${toolName}:${methodOrAction.trim().toUpperCase()}`;
  const personaRef = stringArg(args, ['personaRef', 'persona_ref', 'personaId', 'persona_id']);
  const personaClass =
    personaRef && mission.personaRefs.includes(personaRef) ? 'authenticated' : 'anonymous';
  const inputClass = sha256Canonical(
    Object.fromEntries(
      Object.entries(args)
        .filter(([key]) => !/(?:persona|toolCallId|requestId|timestamp|nonce)/iu.test(key))
        .map(([key, value]) => [key, classifyInputValue(key, value)]),
    ),
  );
  const identityBase = {
    missionFingerprint: mission.missionFingerprint,
    surfaceRef,
    inputClass,
    methodOrAction: methodOrAction.trim().toUpperCase(),
    toolClass: classifyAttemptTool(toolName),
    personaClass,
  };
  return {
    reservationFingerprint: sha256Canonical(identityBase),
    fingerprintsByTechnique: Object.fromEntries(
      mission.techniqueIds.map((techniqueId) => [
        techniqueId,
        sha256Canonical({ ...identityBase, techniqueId }),
      ]),
    ),
    surfaceRef,
    toolClass: identityBase.toolClass,
    actionClass,
    personaClass,
    requestCount,
    reservedAt,
    status: 'reserved',
  };
};

export const computeEnumerationLeadFingerprint = (
  organizationId: string,
  scopeId: string,
  runId: string,
  lead: EnumerationWorkerResultV1['leads'][number],
): string =>
  sha256Canonical({
    organizationId,
    scopeId,
    runId,
    targetRef: lead.targetRef.trim().toLowerCase(),
    surfaceRef: lead.surfaceRef.trim().toLowerCase(),
    riskFamily: lead.riskFamily.trim().toLowerCase(),
    techniqueId: lead.techniqueId.trim().toLowerCase(),
    authContextClass: lead.authContextClass.trim().toLowerCase(),
    hypothesis: lead.hypothesis.trim().toLowerCase().replace(/\s+/gu, ' '),
  });

export const computeEnumerationResultHash = (
  result: Omit<EnumerationWorkerResultV1, 'resultHash'> | EnumerationWorkerResultV1,
): string => {
  const { resultHash: _ignored, ...payload } = result as EnumerationWorkerResultV1;
  return sha256Canonical(payload);
};

const asInputString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseOptionalUniqueStrings = (value: unknown, maximum: number): string[] => {
  const parsed = optionalUniqueTextArray(maximum).safeParse(value);
  return parsed.success ? parsed.data : [];
};

const isInputRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getInputRecord = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (!isInputRecord(value)) {
    return undefined;
  }
  const entry = value[key];
  return isInputRecord(entry) ? entry : undefined;
};

const inputAttemptStatus = (
  attempt: Record<string, unknown> | undefined,
): EnumerationWorkerResultV1['attempts'][number]['status'] | undefined => {
  const status = asInputString(attempt?.status);
  return status === 'completed' || status === 'blocked' || status === 'failed'
    ? status
    : undefined;
};

const chooseInputAttemptForServerAttempt = (
  serverAttempt: EnumerationServerAttemptRecordV1,
  inputAttempts: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined => {
  const serverFingerprints = new Set(Object.values(serverAttempt.fingerprintsByTechnique));
  const fingerprintMatch = inputAttempts.find((attempt) => {
    const fingerprint = asInputString(attempt.fingerprint);
    return fingerprint ? serverFingerprints.has(fingerprint) : false;
  });
  if (fingerprintMatch) {
    return fingerprintMatch;
  }
  return inputAttempts.find((attempt) =>
    asInputString(attempt.surfaceRef) === serverAttempt.surfaceRef &&
    asInputString(attempt.toolClass) === serverAttempt.toolClass &&
    asInputString(attempt.actionClass) === serverAttempt.actionClass &&
    asInputString(attempt.personaClass) === serverAttempt.personaClass
  );
};

const chooseTechniqueForServerAttempt = (
  mission: EnumerationMissionV1,
  serverAttempt: EnumerationServerAttemptRecordV1,
  inputAttempt: Record<string, unknown> | undefined,
): string => {
  const inputTechniqueId = asInputString(inputAttempt?.techniqueId);
  if (
    inputTechniqueId &&
    mission.techniqueIds.includes(inputTechniqueId) &&
    serverAttempt.fingerprintsByTechnique[inputTechniqueId]
  ) {
    return inputTechniqueId;
  }
  const inputFingerprint = asInputString(inputAttempt?.fingerprint);
  if (inputFingerprint) {
    const matching = Object.entries(serverAttempt.fingerprintsByTechnique)
      .find(([, fingerprint]) => fingerprint === inputFingerprint);
    if (matching?.[0] && mission.techniqueIds.includes(matching[0])) {
      return matching[0];
    }
  }
  return mission.techniqueIds[0]!;
};

const normalizeEnumerationAttempts = (
  mission: EnumerationMissionV1,
  serverAttempts: EnumerationServerAttemptRecordV1[],
  inputAttempts: Array<Record<string, unknown>>,
): EnumerationWorkerResultV1['attempts'] =>
  serverAttempts.map((serverAttempt) => {
    const inputAttempt = chooseInputAttemptForServerAttempt(serverAttempt, inputAttempts);
    const techniqueId = chooseTechniqueForServerAttempt(mission, serverAttempt, inputAttempt);
    const endedAt = serverAttempt.completedAt ?? serverAttempt.reservedAt;
    const status =
      serverAttempt.status === 'failed'
        ? 'failed'
        : inputAttemptStatus(inputAttempt) ?? 'completed';
    return {
      fingerprint: serverAttempt.fingerprintsByTechnique[techniqueId]!,
      toolClass: serverAttempt.toolClass,
      actionClass: serverAttempt.actionClass,
      surfaceRef: serverAttempt.surfaceRef,
      techniqueId,
      personaClass: serverAttempt.personaClass,
      startedAt: new Date(serverAttempt.reservedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      status,
      requestCount: serverAttempt.requestCount,
      evidenceRefs: parseOptionalUniqueStrings(inputAttempt?.evidenceRefs, 30),
      ...(blockerCodeSchema.safeParse(inputAttempt?.blockerCode).success
        ? { blockerCode: inputAttempt?.blockerCode as EnumerationWorkerResultV1['attempts'][number]['blockerCode'] }
        : {}),
    };
  });

const normalizeAttemptFingerprints = (
  submitted: string[],
  surfaceRef: string,
  techniqueId: string,
  attempts: EnumerationWorkerResultV1['attempts'],
): string[] => {
  const known = new Set(attempts.map((attempt) => attempt.fingerprint));
  const retained = submitted.filter((fingerprint) => known.has(fingerprint));
  if (retained.length > 0) {
    return Array.from(new Set(retained)).slice(0, 40);
  }
  return attempts
    .filter((attempt) => attempt.surfaceRef === surfaceRef && attempt.techniqueId === techniqueId)
    .map((attempt) => attempt.fingerprint)
    .slice(0, 40);
};

const normalizeEnumerationCoverage = (
  mission: EnumerationMissionV1,
  inputCoverage: unknown,
  attempts: EnumerationWorkerResultV1['attempts'],
  leads: EnumerationWorkerResultV1['leads'],
  negativeResults: EnumerationWorkerResultV1['negativeResults'],
): EnumerationWorkerResultV1['coverage'] => {
  const requested = getInputRecord(inputCoverage, 'requested');
  const uncoveredSchema = z.array(z.object({
    kind: z.enum(['surface', 'technique', 'persona']),
    ref: text,
    reason: text,
  }).strict()).max(100);
  const uncovered = isInputRecord(inputCoverage)
    ? uncoveredSchema.safeParse(inputCoverage.uncovered)
    : undefined;
  return {
    requested: {
      surfaceRefs: [...mission.surface.refs],
      techniqueIds: [...mission.techniqueIds],
      personaClasses: parseOptionalUniqueStrings(requested?.personaClasses, 4),
    },
    attempted: {
      surfaceRefs: Array.from(new Set(attempts.map((attempt) => attempt.surfaceRef))),
      techniqueIds: Array.from(new Set(attempts.map((attempt) => attempt.techniqueId))),
      personaClasses: Array.from(new Set(attempts.map((attempt) => attempt.personaClass))),
    },
    counts: {
      attempts: attempts.length,
      requests: attempts.reduce((sum, attempt) => sum + attempt.requestCount, 0),
      leads: leads.length,
      negativeResults: negativeResults.length,
    },
    uncovered: uncovered?.success ? uncovered.data : [],
  };
};

export const normalizeEnumerationResultInputV1 = (
  value: unknown,
  task: Pick<
    WorkerTaskRecord,
    'taskId' | 'mission' | 'writeScope' | 'budget' | 'targetRequestsUsed' | 'enumerationAttempts'
  >,
): EnumerationWorkerResultV1 => {
  const input = EnumerationWorkerResultInputV1Schema.parse(value);
  const mission = task.mission?.enumeration;
  if (!mission) {
    throw new Error('enumeration_result/v1 requires an enumeration_hunt_v1 mission');
  }
  const attempts = normalizeEnumerationAttempts(
    mission,
    task.enumerationAttempts ?? [],
    input.attempts,
  );
  const leads = input.leads.map((lead) => ({
    ...lead,
    attemptFingerprints: normalizeAttemptFingerprints(
      lead.attemptFingerprints,
      lead.surfaceRef,
      lead.techniqueId,
      attempts,
    ),
  }));
  const negativeResults = input.negativeResults.map((negative) => ({
    ...negative,
    attemptFingerprints: normalizeAttemptFingerprints(
      negative.attemptFingerprints,
      negative.surfaceRef,
      negative.techniqueId,
      attempts,
    ),
  }));
  const result = {
    schemaVersion: 1 as const,
    missionFingerprint: mission.missionFingerprint,
    resultHash: '',
    status: input.status,
    targetRef: mission.targetRef,
    surfaceRefs: [...mission.surface.refs],
    skills: [
      { ...mission.primarySkill, role: 'primary' as const },
      ...mission.supportingSkills.map((skill) => ({ ...skill, role: 'supporting' as const })),
    ],
    leads,
    negativeResults,
    attempts,
    coverage: normalizeEnumerationCoverage(
      mission,
      input.coverage,
      attempts,
      leads,
      negativeResults,
    ),
    blockers: input.blockers,
    artifacts: input.artifacts.filter((artifact) =>
      isEnumerationArtifactPathForTask(task.taskId, artifact.path)
    ),
    recommendedValidationMissions: input.recommendedValidationMissions,
  };
  return {
    ...result,
    resultHash: computeEnumerationResultHash(result),
  };
};

export const parseEnumerationMissionV1 = (value: unknown): EnumerationMissionV1 =>
  EnumerationMissionV1Schema.parse(value);

export const parseEnumerationResultV1 = (
  value: unknown,
  task: Pick<
    WorkerTaskRecord,
    'taskId' | 'mission' | 'writeScope' | 'budget' | 'targetRequestsUsed' | 'enumerationAttempts'
  >,
): EnumerationWorkerResultV1 => {
  const serializedInput = JSON.stringify(value);
  if (
    /(?:authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}|cookie["']?\s*[:=]\s*["'][^"']{8,}|(?:api[_-]?key|client[_-]?secret|password)["']?\s*[:=]\s*["'][^"']{6,})/iu.test(
      serializedInput,
    )
  ) {
    throw new Error('enumeration result contains secret-bearing fields');
  }
  const result = EnumerationWorkerResultV1Schema.parse(value);
  const mission = task.mission?.enumeration;
  if (!mission) {
    throw new Error('enumeration_result/v1 requires an enumeration_hunt_v1 mission');
  }
  if (result.missionFingerprint !== mission.missionFingerprint) {
    throw new Error('enumeration result missionFingerprint does not match the task mission');
  }
  if (result.targetRef !== mission.targetRef) {
    throw new Error('enumeration result targetRef does not match the task mission');
  }
  if (
    JSON.stringify([...result.surfaceRefs].sort()) !==
    JSON.stringify([...mission.surface.refs].sort())
  ) {
    throw new Error('enumeration result surfaceRefs must exactly project the mission surface');
  }
  const expectedSkills = [
    { ...mission.primarySkill, role: 'primary' as const },
    ...mission.supportingSkills.map((skill) => ({ ...skill, role: 'supporting' as const })),
  ];
  if (
    JSON.stringify(result.skills) !== JSON.stringify(expectedSkills) ||
    JSON.stringify([...result.coverage.requested.surfaceRefs].sort()) !==
      JSON.stringify([...mission.surface.refs].sort()) ||
    JSON.stringify([...result.coverage.requested.techniqueIds].sort()) !==
      JSON.stringify([...mission.techniqueIds].sort())
  ) {
    throw new Error('enumeration result skill or requested coverage projection does not match the mission');
  }
  if (result.leads.some((lead) =>
    lead.targetRef !== mission.targetRef ||
    !mission.surface.refs.includes(lead.surfaceRef) ||
    !mission.techniqueIds.includes(lead.techniqueId)
  )) {
    throw new Error('enumeration result contains a lead outside the mission target, surface, or techniques');
  }
  if (
    new Set(result.leads.map((lead) => lead.localId)).size !== result.leads.length ||
    new Set(result.negativeResults.map((negative) => negative.localId)).size !==
      result.negativeResults.length ||
    result.negativeResults.some(
      (negative) =>
        !mission.surface.refs.includes(negative.surfaceRef) ||
        !mission.techniqueIds.includes(negative.techniqueId),
    ) ||
    result.attempts.some(
      (attempt) =>
        !mission.surface.refs.includes(attempt.surfaceRef) ||
        !mission.techniqueIds.includes(attempt.techniqueId) ||
        new Date(attempt.endedAt).getTime() < new Date(attempt.startedAt).getTime(),
    ) ||
    result.coverage.attempted.surfaceRefs.some((ref) => !mission.surface.refs.includes(ref)) ||
    result.coverage.attempted.techniqueIds.some((id) => !mission.techniqueIds.includes(id)) ||
    result.blockers.some(
      (blocker) =>
        (blocker.surfaceRef !== undefined && !mission.surface.refs.includes(blocker.surfaceRef)) ||
        (blocker.techniqueId !== undefined && !mission.techniqueIds.includes(blocker.techniqueId)),
    )
  ) {
    throw new Error('enumeration result contains an outcome or coverage entry outside the mission');
  }
  const leadLocalIds = new Set(result.leads.map((lead) => lead.localId));
  if (
    result.recommendedValidationMissions.some(
      (recommendation) => !leadLocalIds.has(recommendation.leadLocalId),
    )
  ) {
    throw new Error('enumeration result recommends validation for an unknown lead');
  }
  if (result.leads.length > mission.budgets.maxLeads) {
    throw new Error('enumeration result exceeds the mission lead budget');
  }
  const attemptFingerprints = new Set(result.attempts.map((attempt) => attempt.fingerprint));
  if (attemptFingerprints.size !== result.attempts.length) {
    throw new Error('enumeration result contains duplicate attempt fingerprints');
  }
  if (result.leads.some((lead) =>
    lead.attemptFingerprints.some((fingerprint) => !attemptFingerprints.has(fingerprint))
  )) {
    throw new Error('enumeration result lead references an unknown attempt fingerprint');
  }
  if (result.negativeResults.some((negative) =>
    negative.attemptFingerprints.some((fingerprint) => !attemptFingerprints.has(fingerprint))
  )) {
    throw new Error('enumeration result negative references an unknown attempt fingerprint');
  }
  const requestCount = result.attempts.reduce((sum, attempt) => sum + attempt.requestCount, 0);
  if (
    result.coverage.counts.attempts !== result.attempts.length ||
    result.coverage.counts.requests !== requestCount ||
    result.coverage.counts.leads !== result.leads.length ||
    result.coverage.counts.negativeResults !== result.negativeResults.length
  ) {
    throw new Error('enumeration result coverage counts do not reconcile with attempts and outcomes');
  }
  if (requestCount > mission.budgets.maxTargetRequests) {
    throw new Error('enumeration result exceeds the target request budget');
  }
  if (
    typeof task.targetRequestsUsed === 'number' &&
    requestCount !== task.targetRequestsUsed
  ) {
    throw new Error(
      `enumeration result request count ${requestCount} does not match the server meter ${task.targetRequestsUsed}`,
    );
  }
  const serverAttempts = task.enumerationAttempts ?? [];
  const meteredAttempts = result.attempts.filter((attempt) => attempt.requestCount > 0);
  if (serverAttempts.length > 0 || meteredAttempts.length > 0) {
    if (
      serverAttempts.length !== meteredAttempts.length ||
      serverAttempts.some((serverAttempt) => {
        const submitted = meteredAttempts.find(
          (attempt) =>
            serverAttempt.fingerprintsByTechnique[attempt.techniqueId] === attempt.fingerprint,
        );
        return !submitted ||
          submitted.surfaceRef !== serverAttempt.surfaceRef ||
          submitted.toolClass !== serverAttempt.toolClass ||
          submitted.actionClass !== serverAttempt.actionClass ||
          submitted.personaClass !== serverAttempt.personaClass ||
          submitted.requestCount !== serverAttempt.requestCount ||
          serverAttempt.status === 'reserved';
      })
    ) {
      throw new Error('enumeration result attempts do not reconcile with server attempt reservations');
    }
  }
  const totalArtifactBytes = result.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  if (
    result.artifacts.length > mission.budgets.maxArtifactFiles ||
    totalArtifactBytes > mission.budgets.maxArtifactBytes
  ) {
    throw new Error('enumeration result exceeds the artifact budget');
  }
  if (result.artifacts.some(
    (artifact) => !isEnumerationArtifactPathForTask(task.taskId, artifact.path),
  )) {
    throw new Error('enumeration result contains an artifact outside the task artifact root');
  }
  if (new Set(result.artifacts.map((artifact) => artifact.id)).size !== result.artifacts.length) {
    throw new Error('enumeration result contains duplicate artifact ids');
  }
  const computedHash = computeEnumerationResultHash(result);
  if (computedHash !== result.resultHash) {
    throw new Error('enumeration resultHash does not match the canonical payload');
  }
  return result;
};

export const isEnumerationMissionEnvelope = (
  mission: MissionEnvelope | undefined,
): mission is MissionEnvelope & { enumeration: EnumerationMissionV1 } =>
  mission?.enumeration?.kind === ENUMERATION_MISSION_KIND;

export const enumerationArtifactRootForTask = (taskId: string): string =>
  `${ENUMERATION_ARTIFACT_ROOT}/${taskId}`;

const normalizePosixPath = (value: string): string => {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join('/');
  return absolute ? `/${joined}` : joined || '.';
};

export const isEnumerationArtifactPathForTask = (
  taskId: string,
  candidatePath: string,
): boolean => {
  const root = enumerationArtifactRootForTask(taskId);
  const normalized = normalizePosixPath(candidatePath.replace(/\\/gu, '/'));
  return normalized === root || normalized.startsWith(`${root}/`);
};
