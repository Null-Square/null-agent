import type { RunPhaseRow, RunRow, RunTrigger } from '@/db/schema';
import {
  buildScopeDomainBoundaryConflictMessage,
  findScopeDomainBoundaryConflict,
  type ScopeTargetBoundaryInput,
} from '@/domains/security-ops/scopes/scopeTargetBoundary';
import {
  evaluateScopeVerification,
  scopeVerificationMessage,
} from '@/domains/security-ops/scopes/scopeVerificationGate';
import type { UsageSummaryRow } from '@/domains/platform/subscriptions/infrastructure/UsageRecordRepository';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { RunWorkflowDiscipline } from '@/db/schema';
import type { ModelCategory } from '@null-ai/contracts';
import { SYSTEM_PAUSED_BLOCKED_REASON } from '@null-ai/contracts';
import { createHash } from 'crypto';
import {
  DEFAULT_EXECUTION_TARGET,
  type ExecutionTarget,
} from './executionTargets';
export interface CreateRunParams {
  orgId: string;
  scopeId: string;
  goal: string;
  modelId?: string;
  modelCategory?: ModelCategory;
  trigger: RunTrigger;
  userId: string;
  vars?: Record<string, unknown>;
}

export type RunListItem = RunRow;

export interface RunUsageTotals {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead: number;
  platformCost: number;
  platformPrice: number;
  creditEquivalent: number;
  credits: number;
  entries: number;
}

export interface RunUsagePhaseSummary extends RunUsageTotals {
  sessionId: string;
}

export interface RunUsagePhaseBreakdown extends RunUsagePhaseSummary {
  phaseKey: string;
  label: string;
  ordinal: number;
}

export interface RunUsageSummary {
  total: RunUsageTotals;
  planner: RunUsagePhaseSummary | null;
  executor: RunUsagePhaseSummary | null;
  /**
   * Per-phase rollups (recon, enumeration, validation, evidence, reporting).
   * Populated when the caller passes phase rows; empty array otherwise so
   * older callers that only request the planner/executor totals don't break.
   */
  phases: RunUsagePhaseBreakdown[];
}

export interface RunDetail extends RunRow {
  eventsCount: number;
  usageSummary: RunUsageSummary;
}

export interface SessionRuntimeSnapshot {
  completed: boolean;
  blockedReason: string | null;
  hasPendingApproval?: boolean;
  isProcessing: boolean;
  lastActivityAt: Date | null;
}

export interface SessionRuntimeStatusPort {
  getRuntimeSnapshot(sessionId: string): Promise<{
    completed: boolean;
    blockedReason: string | null;
    hasPendingApproval?: boolean;
    isProcessing?: boolean;
    lastActiveAt: Date | null;
  } | null>;
  findById?(sessionId: string): Promise<{
    id: string;
    metadata?: Record<string, unknown>;
  } | null>;
  listIdsByRunId?(runId: string): Promise<string[]>;
}

export type FindingLifecycleMode = 'validate' | 'retest';
export type RunPrerequisiteWarningCode = 'scope_assets_missing';

export interface RunPrerequisiteWarning {
  code: RunPrerequisiteWarningCode;
  message: string;
}

export interface EvaluateRunPrerequisitesInput {
  goal: string;
  totalTargetsCount: number;
  verifiedTargetsCount: number;
  assetsCount: number;
  executionTarget?: ExecutionTarget;
  cloudBlockedTargetValues?: string[];
  networkActivityRequired?: boolean;
  scopeTargets?: ScopeTargetBoundaryInput[];
}

export interface EvaluateRunPrerequisitesResult {
  blockMessage?: string;
  warnings: RunPrerequisiteWarning[];
}

export interface FindingLifecycleRunNote {
  findingId: string;
}

export interface RunServiceOptions {
  maxConcurrentRunsPerScope?: number;
  runInactivityFailMs?: number;
  idempotencyBucketMs?: number;
}

export type RunDisplayStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type RunPauseReason = 'manual' | 'approval' | 'credits' | 'runner' | 'system';
export type RunInteractionType = 'none' | 'plan_approval';

export interface RunDisplayState {
  status: RunDisplayStatus;
  pauseReason: RunPauseReason | null;
  interactionType: RunInteractionType;
  awaitingPlanApproval: boolean;
}

export interface CreateRunRecordResult {
  run: RunRow;
  created: boolean;
}

export interface RunIdempotencyInput {
  scopeId: string;
  goal?: string;
  modelId?: string;
  modelCategory?: ModelCategory;
  executionTarget?: ExecutionTarget;
  workflowDiscipline?: RunWorkflowDiscipline;
  workflowIdentity?: string;
  stable?: boolean;
  now?: Date;
  bucketMs?: number;
}

export const FINDING_VALIDATE_EVENT_TYPE = 'finding_validate_started';
export const FINDING_RETEST_EVENT_TYPE = 'finding_retest_started';
export const FINDING_LIFECYCLE_EVENT_TYPES = [FINDING_VALIDATE_EVENT_TYPE, FINDING_RETEST_EVENT_TYPE] as const;
const UUID_V4ISH_PATTERN = /^[0-9a-fA-F-]{36}$/;
export const DEFAULT_MAX_CONCURRENT_RUNS_PER_SCOPE = 3;
export const DEFAULT_RUN_IDEMPOTENCY_BUCKET_MS = 60_000;
export const DEFAULT_RUN_INACTIVITY_FAIL_MS = 60 * 60 * 1000;
const RUN_STATUS_CHECK_CONSTRAINT = 'runs_status_check';
const PG_CHECK_VIOLATION_CODE = '23514';
export const encodeFindingLifecycleRunNote = (note: FindingLifecycleRunNote): string =>
  JSON.stringify({ findingId: note.findingId });

export const decodeFindingLifecycleRunNote = (note: string | null | undefined): FindingLifecycleRunNote | null => {
  if (!note) return null;

  try {
    const parsed = JSON.parse(note) as { findingId?: unknown };
    if (typeof parsed?.findingId === 'string' && UUID_V4ISH_PATTERN.test(parsed.findingId)) {
      return { findingId: parsed.findingId };
    }
  } catch {
    // Backward compatibility: plain finding ID notes.
    if (UUID_V4ISH_PATTERN.test(note)) {
      return { findingId: note };
    }
  }

  return null;
};

export const RUN_ACTIVE_STATUSES: Array<RunRow['status']> = [
  'queued',
  'running',
  'credits_exhausted',
  'user_paused',
  'awaiting_user',
  'awaiting_approval',
  'runner_unavailable',
  SYSTEM_PAUSED_BLOCKED_REASON,
];
export const PLAN_CONCURRENT_RUN_STATUSES: Array<RunRow['status']> = [
  'running',
  'awaiting_approval',
  'runner_unavailable',
];
export const VULNERABILITY_GOAL_HINTS = ['vulnerab', 'validation', 'retest', 'exploit'];
export const PHASE_TERMINALIZED_BLOCKED_REASON = 'phase_terminalized';
const isRetryBlockedReason = (reason: string): boolean =>
  reason.startsWith('error_retry:') || reason.startsWith('guard_retry:');

const isBlockingRunStatusReason = (reason: string): boolean =>
  reason === 'credits_exhausted' ||
  reason === 'user_paused' ||
  reason === 'awaiting_user' ||
  reason === 'awaiting_approval' ||
  reason === 'runner_unavailable' ||
  reason === SYSTEM_PAUSED_BLOCKED_REASON;

export const isRuntimeOnlyRunStatus = (status: string): boolean =>
  status === 'credits_exhausted' ||
  status === 'user_paused' ||
  status === 'awaiting_user' ||
  status === 'awaiting_approval' ||
  status === 'runner_unavailable' ||
  status === SYSTEM_PAUSED_BLOCKED_REASON;

export const hasRunsStatusCheckViolation = (error: unknown): boolean => {
  let current: unknown = error;

  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current !== 'object') {
      return false;
    }

    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : null;
    const message = typeof candidate.message === 'string' ? candidate.message : null;
    if (
      message?.includes(RUN_STATUS_CHECK_CONSTRAINT) ||
      (code === PG_CHECK_VIOLATION_CODE && message?.includes('new row for relation "runs" violates check constraint'))
    ) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
};

export const normalizeGoal = (value: string): string => value.trim().toLowerCase();

export const goalMatchesAnyHint = (goal: string, hints: readonly string[]): boolean =>
  hints.some((hint) => goal.includes(hint));

const RUN_CHILD_STATUS_PRIORITY: ReadonlyArray<RunRow['status']> = [
  'credits_exhausted',
  'runner_unavailable',
  'awaiting_user',
  'awaiting_approval',
  'user_paused',
  SYSTEM_PAUSED_BLOCKED_REASON,
  'running',
] as const;

// Run-phase statuses that mean the phase (and therefore its session) is finished. A session
// owned by a phase in one of these states must not contribute pause/blocked state to the run.
const RUN_TERMINAL_PHASE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'handoff_submitted',
  'failed',
  'timed_out',
  'aborted',
]);

/**
 * Pure: session IDs whose owning phase has terminalized. These must be excluded from the
 * run's runtime-status derivation so a stale earlier-phase session cannot wedge the run.
 * Single source of truth = the active phase, not superseded phase sessions.
 */
export const collectTerminalPhaseSessionIds = (
  phases: ReadonlyArray<{ status: string; sessionId: string | null }>,
): Set<string> => {
  const ids = new Set<string>();
  for (const phase of phases) {
    const sessionId = typeof phase.sessionId === 'string' ? phase.sessionId.trim() : '';
    if (sessionId && RUN_TERMINAL_PHASE_STATUSES.has(phase.status)) {
      ids.add(sessionId);
    }
  }
  return ids;
};

export function evaluateRunPrerequisites(
  input: EvaluateRunPrerequisitesInput,
): EvaluateRunPrerequisitesResult {
  const normalizedGoal = normalizeGoal(input.goal);
  const warnings: RunPrerequisiteWarning[] = [];
  const executionTarget = input.executionTarget ?? DEFAULT_EXECUTION_TARGET;
  const cloudBlockedTargetValues = input.cloudBlockedTargetValues ?? [];
  const networkActivityRequired = input.networkActivityRequired ?? true;

  if (input.totalTargetsCount === 0) {
    return {
      blockMessage: scopeVerificationMessage('no_target', 'run'),
      warnings,
    };
  }

  const boundaryConflict = findScopeDomainBoundaryConflict(input.scopeTargets ?? []);
  if (boundaryConflict) {
    return {
      blockMessage: buildScopeDomainBoundaryConflictMessage(boundaryConflict),
      warnings,
    };
  }

  // Same ownership rule the assistant chat and PreTurnChecks enforce.
  const ownership = evaluateScopeVerification({
    totalTargetsCount: input.totalTargetsCount,
    verifiedTargetsCount: input.verifiedTargetsCount,
  });
  if (!ownership.verified) {
    return {
      blockMessage: scopeVerificationMessage(ownership.reason ?? 'unverified', 'run'),
      warnings,
    };
  }

  if (networkActivityRequired && executionTarget === 'cloud' && cloudBlockedTargetValues.length > 0) {
    const listedTargets = cloudBlockedTargetValues.slice(0, 3).join(', ');
    const suffix = cloudBlockedTargetValues.length > 3 ? ` and ${cloudBlockedTargetValues.length - 3} more` : '';
    return {
      blockMessage: `Private or reserved network targets (${listedTargets}${suffix}) require attached private runner execution. Select the private runner before starting network assessment.`,
      warnings,
    };
  }

  if (goalMatchesAnyHint(normalizedGoal, VULNERABILITY_GOAL_HINTS) && input.assetsCount === 0) {
    warnings.push({
      code: 'scope_assets_missing',
      message: 'No assets discovered yet for this scope. Vulnerability scan may return limited results.',
    });
  }

  return { warnings };
}

export const resolvePositiveInt = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value) || !value) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
};

export function buildRunIdempotencyKey(input: RunIdempotencyInput): string {
  const normalizedGoal = input.goal?.trim().toLowerCase();
  if (!normalizedGoal) {
    throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'goal is required for idempotency key');
  }
  const normalizedModelSelection =
    input.modelId?.trim().toLowerCase() || input.modelCategory?.trim().toLowerCase() || 'default';
  const executionTarget = input.executionTarget ?? DEFAULT_EXECUTION_TARGET;
  const workflowDiscipline = input.workflowDiscipline ?? 'pentest';
  const workflowIdentity = input.workflowIdentity?.trim().toLowerCase() || 'default';

  const now = input.now ?? new Date();
  const bucketMs = resolvePositiveInt(input.bucketMs, DEFAULT_RUN_IDEMPOTENCY_BUCKET_MS);
  const bucket = input.stable ? 'stable' : String(Math.floor(now.getTime() / bucketMs));
  const keyMaterial = [
    `discipline:${workflowDiscipline}`,
    `identity:${workflowIdentity}`,
    `goal:${normalizedGoal}`,
    `model:${normalizedModelSelection}`,
    `execution:${executionTarget}`,
  ].join(':');
  const material = `${input.scopeId.trim().toLowerCase()}:${keyMaterial}:${bucket}`;
  return createHash('sha256').update(material).digest('hex');
}

export const normalizeAssignedSkillSlugs = (skillSlugs?: string[] | null): string[] | null => {
  if (!Array.isArray(skillSlugs) || skillSlugs.length === 0) {
    return null;
  }

  const normalized = new Set<string>();
  for (const value of skillSlugs) {
    const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (slug) {
      normalized.add(slug);
    }
  }

  return normalized.size > 0 ? Array.from(normalized) : null;
};

export function mapSessionSnapshotToRunStatus(
  snapshot: SessionRuntimeSnapshot,
  _currentStatus: string,
  _startedAt: Date | null,
  _nowMs: number = Date.now(),
  _inactivityFailMs: number = DEFAULT_RUN_INACTIVITY_FAIL_MS,
): string | null {
  if (snapshot.completed) {
    return 'completed';
  }

  if (snapshot.blockedReason) {
    if (snapshot.blockedReason === PHASE_TERMINALIZED_BLOCKED_REASON) {
      return null;
    }
    if (
      snapshot.isProcessing &&
      (snapshot.blockedReason === 'user_paused' || snapshot.blockedReason === SYSTEM_PAUSED_BLOCKED_REASON)
    ) {
      return 'running';
    }
    // Pass through specific blocked reasons as status
    if (isRetryBlockedReason(snapshot.blockedReason)) {
      return 'running';
    }
    if (isBlockingRunStatusReason(snapshot.blockedReason)) {
      return snapshot.blockedReason;
    }
    // Unknown session prerequisites are recoverable observations. They cannot
    // manufacture a terminal business-run failure.
    return null;
  }

  if (snapshot.hasPendingApproval) {
    return 'awaiting_approval';
  }

  if (snapshot.isProcessing) {
    return 'running';
  }

  // Absence of a live marker is not failure. Durable recovery/claim ownership
  // decides whether execution resumes; an explicit run transition decides
  // whether the business run failed or was cancelled.
  return null;
}

export const toChildRuntimeStatus = (
  snapshot: SessionRuntimeSnapshot,
  startedAt: Date | null,
  nowMs: number,
  inactivityFailMs: number,
): RunRow['status'] | null => {
  const status = mapSessionSnapshotToRunStatus(
    snapshot,
    'running',
    startedAt,
    nowMs,
    inactivityFailMs,
  );

  if (status === 'failed' || status === 'completed' || status === 'cancelled' || status === 'queued') {
    return null;
  }

  return status as RunRow['status'] | null;
};

export const chooseRelatedRunStatus = (
  primaryStatus: string | null,
  relatedStatuses: readonly (RunRow['status'] | null)[],
): string | null => {
  if (primaryStatus === 'cancelled') {
    return 'cancelled';
  }

  const candidates = [primaryStatus, ...relatedStatuses].filter((value): value is RunRow['status'] => Boolean(value));
  for (const status of RUN_CHILD_STATUS_PRIORITY) {
    if (candidates.includes(status)) {
      return status;
    }
  }

  if (primaryStatus === 'completed') {
    return relatedStatuses.some((status) => status === 'running') ? 'running' : 'completed';
  }

  if (primaryStatus === 'failed') {
    return relatedStatuses.some((status) => status === 'running') ? 'running' : 'failed';
  }

  return primaryStatus;
};

const createEmptyRunUsageTotals = (): RunUsageTotals => ({
  promptTokens: 0,
  cachedPromptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  nativeCost: 0,
  overhead: 0,
  platformCost: 0,
  platformPrice: 0,
  creditEquivalent: 0,
  credits: 0,
  entries: 0,
});

const mergeRunUsageTotals = (base: RunUsageTotals, summary?: UsageSummaryRow | null): RunUsageTotals => ({
  promptTokens: base.promptTokens + Number(summary?.promptTokens ?? 0),
  cachedPromptTokens: base.cachedPromptTokens + Number(summary?.cachedPromptTokens ?? 0),
  completionTokens: base.completionTokens + Number(summary?.completionTokens ?? 0),
  totalTokens: base.totalTokens + Number(summary?.totalTokens ?? 0),
  nativeCost: base.nativeCost + Number(summary?.nativeCost ?? 0),
  overhead: base.overhead + Number(summary?.overhead ?? 0),
  platformCost: base.platformCost + Number(summary?.platformCost ?? 0),
  platformPrice: base.platformPrice + Number(summary?.platformPrice ?? 0),
  creditEquivalent: base.creditEquivalent + Number(summary?.creditEquivalent ?? 0),
  credits: base.credits + Number(summary?.credits ?? 0),
  entries: base.entries + Number(summary?.entries ?? 0),
});

const toRunUsagePhaseSummary = (
  sessionId: string | null,
  summaryBySessionId: ReadonlyMap<string, UsageSummaryRow>,
): RunUsagePhaseSummary | null => {
  if (!sessionId) return null;
  const base = createEmptyRunUsageTotals();
  const summary = summaryBySessionId.get(sessionId);
  return {
    sessionId,
    ...mergeRunUsageTotals(base, summary),
  };
};

export const resolveRunUsageSessionRefs = (
  run: Pick<RunRow, 'sessionId' | 'plannerSessionId' | 'executorSessionId'>,
  additionalSessionIds: readonly string[] = [],
): {
  plannerSessionId: string | null;
  executorSessionId: string | null;
  sessionIds: string[];
} => {
  const currentSessionId = typeof run.sessionId === 'string' && run.sessionId.trim().length > 0
    ? run.sessionId.trim()
    : null;
  const explicitPlannerSessionId = typeof run.plannerSessionId === 'string' && run.plannerSessionId.trim().length > 0
    ? run.plannerSessionId.trim()
    : null;
  const explicitExecutorSessionId = typeof run.executorSessionId === 'string' && run.executorSessionId.trim().length > 0
    ? run.executorSessionId.trim()
    : null;

  const plannerSessionId = explicitPlannerSessionId
    ?? (!explicitExecutorSessionId ? currentSessionId : null);
  const executorSessionId = explicitExecutorSessionId
    ?? (explicitPlannerSessionId && currentSessionId && currentSessionId !== explicitPlannerSessionId
      ? currentSessionId
      : null);

  const sessionIds = Array.from(
    new Set(
      [
        plannerSessionId,
        executorSessionId,
        currentSessionId,
        ...additionalSessionIds.map((value) => value.trim()).filter((value) => value.length > 0),
      ].filter((value): value is string => Boolean(value)),
    ),
  );

  return { plannerSessionId, executorSessionId, sessionIds };
};

export const isRunAwaitingPlanApproval = (
  run: {
    goal: string;
    status: string;
    executorSessionId?: string | null;
    plan?: string | null;
  },
): boolean =>
  Boolean(
    run.goal &&
    run.status === 'awaiting_approval' &&
    !run.executorSessionId &&
    typeof run.plan === 'string' &&
    run.plan.trim().length > 0,
  );

export const deriveRunDisplayState = (
  run: {
    goal: string;
    status: string;
    executorSessionId?: string | null;
    plan?: string | null;
  },
): RunDisplayState => {
  const awaitingPlanApproval = isRunAwaitingPlanApproval(run);

  switch (run.status) {
    case 'queued':
      return { status: 'queued', pauseReason: null, interactionType: 'none', awaitingPlanApproval };
    case 'running':
      return { status: 'running', pauseReason: null, interactionType: 'none', awaitingPlanApproval };
    case 'credits_exhausted':
      return { status: 'paused', pauseReason: 'credits', interactionType: 'none', awaitingPlanApproval };
    case 'user_paused':
    case 'awaiting_user':
      return { status: 'paused', pauseReason: 'manual', interactionType: 'none', awaitingPlanApproval };
    case 'awaiting_approval':
      return {
        status: 'paused',
        pauseReason: 'approval',
        interactionType: awaitingPlanApproval ? 'plan_approval' : 'none',
        awaitingPlanApproval,
      };
    case 'runner_unavailable':
      return { status: 'paused', pauseReason: 'runner', interactionType: 'none', awaitingPlanApproval };
    case 'system_paused':
      return { status: 'paused', pauseReason: 'system', interactionType: 'none', awaitingPlanApproval };
    case 'completed':
      return { status: 'completed', pauseReason: null, interactionType: 'none', awaitingPlanApproval };
    case 'cancelled':
      return { status: 'cancelled', pauseReason: null, interactionType: 'none', awaitingPlanApproval };
    case 'failed':
    default:
      return { status: 'failed', pauseReason: null, interactionType: 'none', awaitingPlanApproval };
  }
};

const PHASE_USAGE_LABELS: Record<string, string> = {
  planning: 'Planner',
  recon: 'Recon',
  enumeration: 'Enumeration',
  validation: 'Validation',
  evidence: 'Evidence',
  reporting: 'Reporting',
};

const labelForPhase = (phaseKey: string): string =>
  PHASE_USAGE_LABELS[phaseKey] ??
  phaseKey.charAt(0).toUpperCase() + phaseKey.slice(1).replace(/[_-]+/g, ' ');

export const buildRunUsageSummary = (
  run: Pick<RunRow, 'sessionId' | 'plannerSessionId' | 'executorSessionId'>,
  summaryBySessionId: ReadonlyMap<string, UsageSummaryRow>,
  additionalSessionIds: readonly string[] = [],
  phaseRows: readonly Pick<RunPhaseRow, 'phaseKey' | 'ordinal' | 'sessionId'>[] = [],
): RunUsageSummary => {
  const refs = resolveRunUsageSessionRefs(run, additionalSessionIds);
  const planner = toRunUsagePhaseSummary(refs.plannerSessionId, summaryBySessionId);
  const executor = toRunUsagePhaseSummary(refs.executorSessionId, summaryBySessionId);
  const total = refs.sessionIds.reduce<RunUsageTotals>((acc, sessionId) => {
    return mergeRunUsageTotals(acc, summaryBySessionId.get(sessionId));
  }, createEmptyRunUsageTotals());

  const phases = phaseRows
    .filter((row): row is typeof row & { sessionId: string } => Boolean(row.sessionId))
    .map((row): RunUsagePhaseBreakdown => ({
      phaseKey: row.phaseKey,
      ordinal: row.ordinal,
      label: labelForPhase(row.phaseKey),
      sessionId: row.sessionId,
      ...mergeRunUsageTotals(createEmptyRunUsageTotals(), summaryBySessionId.get(row.sessionId)),
    }))
    .sort((a, b) => a.ordinal - b.ordinal);

  return {
    total,
    planner,
    executor,
    phases,
  };
};
