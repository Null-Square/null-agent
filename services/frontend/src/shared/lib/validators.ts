/**
 * Validation utilities for frontend data.
 *
 * Task, Message, and Artifact schemas are imported from @null-ai/contracts
 * as the single source of truth.
 */

import { z } from "zod";
import type {
  AssistantChatSessionMeta,
  ChatSessionMeta,
  ChatSessionSnapshot,
} from "@/types/chat";
import { resolveSessionPresentation } from "@null-ai/contracts";

// Re-export from @null-ai/contracts (single source of truth)
export { validateTaskSummaries } from "@null-ai/contracts";
export { validateMessages } from "@null-ai/contracts";
export { validateArtifacts } from "@null-ai/contracts";

const logValidationWarning = (
  scope: string,
  message: string,
  sample: unknown,
) => {
  const preview = (() => {
    try {
      return JSON.stringify(sample)?.slice(0, 500);
    } catch {
      return "<unserializable>";
    }
  })();
  console.warn(`[${scope}] Validation warning: ${message}`, preview);
};

const num = () =>
  z.union([z.number(), z.string().transform((v) => Number(v))]).optional();
const requiredNum = z.union([
  z.number(),
  z.string().transform((v) => Number(v)),
]);

// Sessions must remain readable across staged rollouts and by older clients.
// Known worker types receive first-class UI, while future/unknown strings render
// through the generic hierarchy path instead of rejecting the whole session.
const WorkerTypeSchema = z.string().min(1);

const WorkerTaskStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "awaiting_input",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

const WorkerRunModeSchema = z.enum(["blocking", "background"]);
const WorkerContinuationModeSchema = z.enum(["spawn", "continue"]);
const WorkerDependencyModeSchema = z.enum(["dependency", "sidecar"]);

const WorkerTaskBudgetSchema = z
  .object({
    maxToolCalls: num(),
    maxTurns: num(),
    maxTargetRequests: num(),
    maxRequestConcurrency: num(),
    maxWallSeconds: num(),
    maxArtifactFiles: num(),
    maxArtifactBytes: num(),
    maxLeads: num(),
    maxStateChanges: num(),
  })
  .passthrough();

const EnumerationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    missionFingerprint: z.string(),
    resultHash: z.string(),
    status: z.enum(["completed", "partial", "blocked", "failed"]),
    targetRef: z.string(),
    surfaceRefs: z.array(z.string()),
    skills: z.array(z.object({
      slug: z.string(),
      versionHash: z.string(),
      role: z.enum(["primary", "supporting"]),
    }).passthrough()),
    leads: z.array(z.record(z.string(), z.unknown())),
    negativeResults: z.array(z.record(z.string(), z.unknown())),
    attempts: z.array(z.record(z.string(), z.unknown())),
    coverage: z.record(z.string(), z.unknown()),
    blockers: z.array(z.record(z.string(), z.unknown())),
    artifacts: z.array(z.record(z.string(), z.unknown())),
    recommendedValidationMissions: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const WorkerResultArtifactSchema = z
  .object({
    taskId: z.string(),
    workerType: WorkerTypeSchema,
    summary: z.string(),
    findings: z.array(z.string()).optional(),
    evidenceRefs: z.array(z.string()).optional(),
    sourceEvidenceRefs: z.array(z.string()).optional(),
    parentReadableEvidenceRefs: z.array(z.string()).optional(),
    parentReadableManifestPath: z.string().optional(),
    sourceSessionId: z.string().optional(),
    touchedTargets: z.array(z.string()).optional(),
    recommendedNextAction: z.string().optional(),
    confidence: num(),
    enumeration: EnumerationResultSchema.optional(),
  })
  .passthrough();

const SessionCoordinationSchema = z
  .object({
    role: z.enum(["direct", "coordinator", "worker"]),
    parentSessionId: z.string().optional(),
    parentTaskId: z.string().optional(),
    workerType: WorkerTypeSchema.optional(),
    expectedArtifactType: z.string().optional(),
    writeScope: z.array(z.string()).optional(),
    executionMode: WorkerRunModeSchema.optional(),
    dependencyMode: WorkerDependencyModeSchema.optional(),
    continuationMode: WorkerContinuationModeSchema.optional(),
    maxToolCalls: num(),
    maxTurns: num(),
    maxTargetRequests: num(),
    targetRequestsUsed: num(),
    maxRequestConcurrency: num(),
    activeTargetRequests: num(),
    enumerationMissionReservations: z.record(
      z.string(),
      z.object({ taskId: z.string(), reservedAt: requiredNum }).passthrough(),
    ).optional(),
    enumerationCreditReservations: z.record(
      z.string(),
      z.object({
        estimatedWorkerCredits: requiredNum,
        reservedRootCredits: requiredNum,
        remainingCreditsAtAdmission: requiredNum,
        reservedAt: requiredNum,
      }).passthrough(),
    ).optional(),
    enumerationAttemptReservations: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    enumerationAttempts: z.array(z.record(z.string(), z.unknown())).optional(),
    deadlineAt: num(),
  })
  .passthrough();

const WorkerTaskRecordSchema = z
  .object({
    taskId: z.string(),
    parentSessionId: z.string(),
    workerSessionId: z.string(),
    workerType: WorkerTypeSchema,
    status: WorkerTaskStatusSchema,
    reason: z.string(),
    task: z.string(),
    expectedArtifactType: z.string(),
    executionMode: WorkerRunModeSchema,
    dependencyMode: WorkerDependencyModeSchema.optional(),
    continuationMode: WorkerContinuationModeSchema,
    planStepId: z.string().optional(),
    mission: z.record(z.string(), z.unknown()).optional(),
    writeScope: z.array(z.string()).optional(),
    budget: WorkerTaskBudgetSchema.optional(),
    continuationCount: num(),
    retryIndex: num(),
    targetRequestsUsed: num(),
    enumerationAttempts: z.array(z.record(z.string(), z.unknown())).optional(),
    deadlineAt: num(),
    enumerationCapability: z.object({
      enabled: z.boolean(),
      cohort: z.enum(["disabled", "allowlist", "percentage", "benchmark"]),
      policyVersion: requiredNum,
      catalogVersion: z.string(),
    }).passthrough().optional(),
    enumerationCreditReservation: z.object({
      estimatedWorkerCredits: requiredNum,
      reservedRootCredits: requiredNum,
      remainingCreditsAtAdmission: requiredNum,
      reservedAt: requiredNum,
      releasedAt: num(),
      releaseReason: z.string().optional(),
    }).passthrough().optional(),
    createdAt: requiredNum,
    startedAt: num(),
    completedAt: num(),
    lastUpdatedAt: num(),
    lastStatusReason: z.string().optional(),
    lastError: z.string().optional(),
    summary: z.string().optional(),
    artifact: WorkerResultArtifactSchema.optional(),
    enumerationDisposition: z.object({
      action: z.enum(["disposition", "acknowledge_terminal"]),
      resultHash: z.string().optional(),
      terminalStateVersion: z.string().optional(),
      payloadHash: z.string(),
      completedAt: requiredNum,
      leadDispositions: z.array(z.record(z.string(), z.unknown())),
      canonicalLeadIds: z.array(z.string()),
      validatorEligibleLeadIds: z.array(z.string()),
      coverageAcknowledged: z.boolean(),
      negativeResultsAcknowledged: z.boolean(),
      terminalReason: z.string().optional(),
    }).passthrough().optional(),
  })
  .passthrough();

// Session Schema (kept local as it has frontend-specific transformations)
const UsageSchema = z
  .object({
    promptTokens: num(),
    completionTokens: num(),
    totalTokens: num(),
    cost: num(),
    overhead: num(),
    currency: z.string().optional(),
    model: z.string().optional(),
    cachedPromptTokens: num().nullable(),
    platformCost: num().nullable(),
    platformPrice: num().nullable(),
    credits: num().nullable(),
    contextWindow: num().nullable(),
    contextRemaining: num().nullable(),
    estimatedTokens: num(),
    maxHistoryTokens: num(),
    lastTurnInputTokens: num(),
  })
  .passthrough();

const ApprovalRequestSchema = z
  .object({
    actionId: z.string(),
    tool: z.string(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    preview: z
      .object({
        cmd: z.string().optional(),
        path: z.string().optional(),
        diff: z.string().optional(),
        risk: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    expiresAt: z.string().optional(),
    requestedAt: z.number().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const SessionSchema = z.object({
  id: z.string(),
  desiredExecution: z.enum(["running", "stopped"]).optional(),
  condition: z.enum([
    "executing",
    "waiting_approval",
    "waiting_credits",
    "waiting_runner",
    "waiting_prerequisite",
    "recovering",
    "completed",
    "idle",
  ]).optional(),
  conditionReason: z.string().nullable().optional(),
  title: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  status: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  pause_reason: z
    .enum(["manual", "approval", "credits", "runner", "system"])
    .nullable()
    .optional(),
  interaction_type: z.enum(["none"]).optional(),
  blocked_reason: z.string().nullable().optional(),
  blocked_meta: z.record(z.string(), z.unknown()).nullable().optional(),
  isProcessing: z.boolean().optional(),
  completed: z.boolean().optional(),
  mode: z.enum(["interactive", "automated"]).optional(),
  executionTarget: z.enum(["cloud", "scope_runner"]).optional(),
  runnerId: z.string().nullable().optional(),
  runnerName: z.string().nullable().optional(),
  createdAt: z
    .union([z.number(), z.string().transform((val) => Number(val))])
    .optional()
    .transform((val) => (Number.isFinite(val) ? Number(val) : Date.now())),
  lastActive: z
    .union([z.number(), z.string().transform((val) => Number(val))])
    .optional()
    .transform((val) =>
      typeof val === "number" && Number.isFinite(val) ? Number(val) : undefined,
    ),
  updatedAt: z
    .union([z.number(), z.string().transform((val) => Number(val))])
    .optional()
    .transform((val) => (Number.isFinite(val) ? Number(val) : Date.now())),
  scopeId: z.string().nullable().optional(),
  assistantMode: z.literal("read_only_chat").optional(),
  sessionKind: z.literal("assistant_chat").optional(),
  turn: z.number().optional(),
  messageCount: z.number().optional(),
  summary: z.string().nullable().optional(),
  report: z.string().nullable().optional(),
  artifacts: z.array(z.any()).optional(),
  usage: UsageSchema.nullable().optional(),
  usageHistory: z.array(z.any()).optional(),
  messages: z.array(z.any()).optional(),
  plan: z.array(z.any()).optional(),
  task: z.any().optional(),
  liveToolStreams: z.record(z.string(), z.any()).optional(),
  timeline: z.array(z.any()).optional(),
  coordination: SessionCoordinationSchema.optional(),
  workerTasks: z.array(WorkerTaskRecordSchema).optional(),
  workerResult: WorkerResultArtifactSchema.optional(),
  pendingApproval: ApprovalRequestSchema.nullable().optional(),
}).transform((session) => {
  const presentation = resolveSessionPresentation(session);
  return {
    ...session,
    desiredExecution: presentation.desiredExecution,
    condition: presentation.condition,
    ...(session.conditionReason !== undefined || presentation.conditionReason !== null
      ? { conditionReason: session.conditionReason ?? presentation.conditionReason }
      : {}),
  };
});

export const SessionArraySchema = z.array(SessionSchema);

export const validateSession = (data: unknown): ChatSessionSnapshot => {
  const parsed = SessionSchema.safeParse(data);
  if (parsed.success) {
    return parsed.data as ChatSessionSnapshot;
  }
  if (data && typeof data === "object") {
    logValidationWarning("validateSession", parsed.error.message, data);
    return {
      ...(data as Record<string, unknown>),
      id: (data as Record<string, unknown>).id as string,
    } as ChatSessionSnapshot;
  }
  throw new Error(`Invalid session payload: ${parsed.error.message}`);
};

export const validateSessions = (data: unknown): ChatSessionMeta[] => {
  const parsed = SessionArraySchema.safeParse(data);
  if (parsed.success) {
    return parsed.data as ChatSessionMeta[];
  }

  if (Array.isArray(data)) {
    const valid: ChatSessionMeta[] = [];
    data.forEach((item) => {
      const single = SessionSchema.safeParse(item);
      if (single.success) {
        valid.push(single.data as ChatSessionMeta);
      } else {
        logValidationWarning("validateSessions", single.error.message, item);
      }
    });
    if (valid.length > 0) {
      return valid;
    }
    return data as ChatSessionMeta[];
  }

  logValidationWarning("validateSessions", parsed.error.message, data);
  return [];
};

export const validateAssistantSessions = (
  data: unknown,
): AssistantChatSessionMeta[] =>
  validateSessions(data) as AssistantChatSessionMeta[];

/**
 * Target type detection
 */
export const DOMAIN_REGEX = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})+$/;
export const CIDR_REGEX = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/([0-9]|[1-2][0-9]|3[0-2]))?$/;

export type TargetType = 'domain' | 'cidr';

export const detectTargetType = (value: string): TargetType => {
  const trimmed = value.trim();
  if (CIDR_REGEX.test(trimmed)) return 'cidr';
  return 'domain'; // Default to domain if it doesn't match CIDR precisely
};
