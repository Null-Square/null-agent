import { RUN_TRIGGERS, type RunTrigger } from '@/db/schema';
import type { AgentApiServices } from '@/app/services/agent/types';
import type {
  CodeReviewContext,
  CodeReviewOperation,
  FindingDispositionSnapshot,
  RunPhaseReplanRow,
  RunPhaseRow,
  RunRow,
  RunSchedulingClass,
  RunnerRow,
  RunWorkflowDiscipline,
} from '@/db/schema';
import type { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { workCancellationRegistry } from '@/domains/agent-brain/application/orchestration/services/WorkContinuationGuard';
import type { PromptProfile } from '@/domains/agent-brain/domain/prompts';
import type { ToolAccessPolicy } from '@/domains/agent-brain/domain/types';
import type { MissionEnvelopeNode } from '@/domains/agent-brain/domain/workers/missionEnvelope';
import type { RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { createRunnerSecurityOpsFlags } from '@/domains/security-ops/runners/runnerSession';
import type { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { ComplianceFrameworkKey, ModelCategory } from '@null-ai/contracts';
import {
  readSessionExecutionProfile,
  type ExecutionSelection,
} from '@/domains/agent-brain/domain/runtime/ExecutionRuntimeRegistry';
import {
  attachMissionPhases,
  phaseProfileRegistry,
  type RunPhaseKey,
  type RunPhaseStatus,
} from './PhaseProfileRegistry';
import { PhaseSessionFactory, type CreatePhaseSessionInput } from './PhaseSessionFactory';
import {
  isRunAwaitingPlanApproval,
  resolvePolicyForRunnerType,
  type RunPrerequisiteWarning,
  type RunService,
  type ValidationLeadSummary,
} from './RunService';
import {
  CODE_REVIEW_PLANNER_TOOL_POLICY,
  COMPLIANCE_PLANNER_TOOL_POLICY,
  EXECUTION_PHASE_KICKOFF_PROMPTS,
  PHASE_EXECUTION_MODE,
  REPORTING_PHASE_KICKOFF_PROMPT,
  VALIDATION_PHASE_KICKOFF_PROMPT,
  buildFreshExecutionPhaseContext,
  focusScopeContextOnAsset,
  buildPhasePlanSeed,
  buildPlannerToolPolicy,
  buildReportingPhaseContext,
  buildValidationPhaseContext,
  ensureRunArtifactRoot,
  isFreshExecutionPhaseKey,
  phaseHandoffTerminalStatus,
  resolveStoredMissionEnvelopeNodes,
  uniqueSkillSlugs,
  type FreshExecutionPhaseKey,
} from './StartRunPromptHelpers';
import {
  buildCodeReviewIdempotencyIdentity,
  type CodeReviewManifestFile,
  validateRunWorkflowIdentity,
} from './codeReviewRunContext';
import { StartRunReplanService } from './StartRunReplanService';
import { StartRunRuntimeService } from './StartRunRuntimeService';
import type { StartRunWorkspaceServiceDeps } from './StartRunWorkspaceService';
import { StartRunWorkspaceService, toWorkspaceProjectionAppError } from './StartRunWorkspaceService';
import {
  disabledEnumerationWorkerCapabilitySnapshot,
  readEnumerationWorkerCapabilitySnapshot,
  resolveEnumerationWorkerCapabilitySnapshot,
} from './enumerationCapability';
import { resolveControlledExploitationCapabilitySnapshot } from './exploitationCapability';
import { evaluateControlledExploitationPhaseAdmission } from './controlledExploitationAdmission';
import { normalizeExecutionTarget, type ExecutionTarget } from './executionTargets';
import { syncAssignedSkillsIntoWorkspace } from './skillWorkspaceSync';
import { PHASE_TERMINALIZED_BLOCKED_REASON } from './RunLifecycleHelpers';
import type { ExposureLeadInjector } from '@/domains/security-ops/exposure/ExposureLeadInjector';
import type { CapacityLeaseService } from './scheduling/CapacityLeaseService';
import { loadCloudRunSchedulingConfig, type CloudRunSchedulingConfig } from './scheduling/CloudRunSchedulingConfig';
import type { RunAdmissionQueue } from './scheduling/RunAdmissionQueue';
export {
  CODE_REVIEW_PLANNER_TOOL_POLICY,
  COMPLIANCE_PLANNER_TOOL_POLICY,
  DEFAULT_PLANNER_TOOL_POLICY,
  SOLO_EXECUTOR_TOOL_POLICY,
  buildPlannerToolPolicy,
} from './StartRunPromptHelpers';

/**
 * `exposure_verification` is distinct from `event` on purpose: it is the only
 * trigger whose runs are narrowly scoped to a single advisory against a single
 * asset, and separating it is what makes cost per verification measurable from
 * the first run rather than lost inside general automation spend.
 */
type PlannerRunTrigger = RunTrigger;

type RunStartRunnerSummary = Pick<RunnerRow, 'id' | 'name' | 'type' | 'status'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const FINDING_DISPOSITION_KICKOFF_PROMPT =
  'Start the focused finding disposition verification now. Read the immutable snapshot and validation skill, perform the bounded replay, submit exactly one submit_finding_disposition_outcome, then close the validation phase.';

const readRunSecurityOpsFlags = (launchPayload: unknown): Record<string, unknown> => {
  if (!isRecord(launchPayload) || !isRecord(launchPayload.params)) return {};
  const flags = launchPayload.params.securityOpsFlags;
  return isRecord(flags) ? flags : {};
};

const readRunPlannerVars = (launchPayload: unknown): Record<string, unknown> => {
  if (!isRecord(launchPayload) || !isRecord(launchPayload.params)) return {};
  const vars = launchPayload.params.vars;
  return isRecord(vars) ? vars : {};
};

/**
 * Preserve the narrow host identity of a trusted Research Lab run when the
 * planner creates fresh phase sessions. Arbitrary planner flags must never
 * cross this boundary: phase sessions only inherit the host marker when the
 * source session is already bound to the same persisted product run.
 */
export const readHostedSidecarPhaseFlags = (flags: unknown, expectedRunId: string): Record<string, unknown> => {
  const root = isRecord(flags) ? flags : {};
  const securityops = isRecord(root.securityops) ? root.securityops : {};
  if (nonEmptyString(securityops.runId) !== expectedRunId.trim() || securityops.runHost !== 'research_lab') {
    return {};
  }

  const evaluationCaseId = nonEmptyString(securityops.evaluationCaseId);
  return {
    runHost: 'research_lab',
    ...(evaluationCaseId ? { evaluationCaseId: evaluationCaseId.slice(0, 256) } : {}),
  };
};

export const assertCodeReviewLaunchAvailable = (
  workflowDiscipline: RunWorkflowDiscipline,
  operation?: CodeReviewOperation | null,
): void => {
  if (workflowDiscipline === 'code_review' && operation === 'finding_fix') {
    throw new AppError(
      ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      'Code Review finding fixes require the separate patch approval and pull-request publication workflow',
    );
  }
};

const withComplianceFrameworkContext = (params: {
  workflowDiscipline: RunWorkflowDiscipline;
  frameworkKey?: ComplianceFrameworkKey | null;
  codeReviewOperation?: CodeReviewOperation | null;
  codeReviewContext?: CodeReviewContext | null;
  extra?: Record<string, unknown>;
  includeReport?: boolean;
  reportSourceRunId?: string | null;
}): Record<string, unknown> => {
  const extra = { ...(params.extra ?? {}) };
  if (params.workflowDiscipline === 'code_review') {
    if (!params.codeReviewOperation || !params.codeReviewContext) {
      throw new AppError(
        ERROR_CODES.VALIDATION_MISSING_REQUIRED,
        'Code Review session flags require an operation and immutable context',
      );
    }
    extra.codeReview = {
      ...params.codeReviewContext,
      operation: params.codeReviewOperation,
    };
    return extra;
  }
  if (params.workflowDiscipline !== 'compliance' || !params.frameworkKey) {
    return extra;
  }

  const existingAssessment = isRecord(extra.complianceAssessment) ? extra.complianceAssessment : {};
  extra.complianceAssessment = {
    ...existingAssessment,
    framework: nonEmptyString(existingAssessment.framework) ?? params.frameworkKey,
  };

  if (params.includeReport) {
    const existingReport = isRecord(extra.complianceReport) ? extra.complianceReport : {};
    extra.complianceReport = {
      ...existingReport,
      framework: nonEmptyString(existingReport.framework) ?? params.frameworkKey,
      source: nonEmptyString(existingReport.source) ?? 'assessment-run',
      ...(nonEmptyString(existingReport.sourceRunId)
        ? { sourceRunId: nonEmptyString(existingReport.sourceRunId) }
        : params.reportSourceRunId
          ? { sourceRunId: params.reportSourceRunId }
          : {}),
    };
  }

  return extra;
};

export type StartPlannerRunParams = {
  orgId: string;
  userId: string;
  scopeId: string;
  goal: string;
  modelId?: string;
  modelCategory?: ModelCategory;
  /** Immutable request input parsed only by the development HTTP composition. */
  executionSelection?: ExecutionSelection;
  executionTarget?: ExecutionTarget;
  title?: string | null;
  trigger: PlannerRunTrigger;
  vars?: Record<string, unknown>;
  toolPolicy: ToolAccessPolicy;
  idempotency?: 'enabled' | 'disabled';
  /** Internal stable key for durable schedulers. HTTP callers must never populate this. */
  idempotencyKey?: string;
  /** Allow a durable scheduler to replace, but never revive, a failed prior Run. */
  replaceFailedIdempotentRun?: boolean;
  securityOpsFlags?: Record<string, unknown>;
  workflowDiscipline?: RunWorkflowDiscipline;
  codeReviewOperation?: CodeReviewOperation | null;
  codeReviewContext?: CodeReviewContext | null;
  codeReviewManifestFiles?: readonly CodeReviewManifestFile[];
  codeReviewRepositoryBrief?: string | null;
  complianceFrameworkKey?: ComplianceFrameworkKey | null;
  plannerPromptProfile?: PromptProfile;
  planningSkillSlugs?: string[];
  autoApproveOnPlanning?: boolean;
  /** Authoritative commercial limit resolved by AccessControlService. */
  maxConcurrentRuns?: number | null;
  /** Durable backlog bound for queued, not-yet-admitted runs. */
  maxQueuedBacklog?: number | null;
  schedulingClass?: RunSchedulingClass;
  /** Internal scheduler handoff. HTTP callers must never populate this. */
  admission?: {
    runId: string;
    admissionEpoch: number;
    claimOwner: string;
    leaseId: string;
    runner: RunnerRow;
  };
};

const cloudAdmissionRuntimeFlags = (
  admission: StartPlannerRunParams['admission'] | undefined,
): Record<string, unknown> =>
  admission
    ? {
        cloudAdmission: {
          admissionEpoch: admission.admissionEpoch,
          leaseId: admission.leaseId,
          bundleKey: `run:${admission.runId}:epoch:${admission.admissionEpoch}`,
        },
      }
    : {};

export type StartPlannerRunResult = {
  run: RunRow;
  sessionId: string | null;
  policySlug: string;
  warnings: RunPrerequisiteWarning[];
  runner: RunStartRunnerSummary | null;
  runnerName: string | null;
  idempotentReplay: boolean;
};

type PlannerLaunchPayloadV1 = {
  version: 1;
  kind: 'planner';
  params: Omit<StartPlannerRunParams, 'admission' | 'maxConcurrentRuns' | 'maxQueuedBacklog' | 'schedulingClass'>;
};

const serializePlannerLaunchPayload = (params: StartPlannerRunParams): Record<string, unknown> => {
  const {
    admission: _admission,
    maxConcurrentRuns: _maxConcurrentRuns,
    maxQueuedBacklog: _maxQueuedBacklog,
    schedulingClass: _schedulingClass,
    ...launchParams
  } = params;
  // JSON round-tripping strips undefined values and proves that the durable
  // handoff does not depend on closures or process-local objects.
  return JSON.parse(
    JSON.stringify({
      version: 1,
      kind: 'planner',
      params: launchParams,
    }),
  ) as Record<string, unknown>;
};

const parsePlannerLaunchPayload = (value: unknown): PlannerLaunchPayloadV1 => {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'planner' || !isRecord(value.params)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_INVALID_FORMAT,
      'Queued run launch payload is missing or has an unsupported version.',
    );
  }
  const params = value.params;
  if (
    typeof params.orgId !== 'string' ||
    typeof params.userId !== 'string' ||
    typeof params.scopeId !== 'string' ||
    typeof params.goal !== 'string' ||
    !isRecord(params.toolPolicy) ||
    !RUN_TRIGGERS.includes(params.trigger as RunTrigger)
  ) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Queued planner launch payload is invalid.');
  }
  return value as unknown as PlannerLaunchPayloadV1;
};

export type StartReportOnlyRunParams = {
  orgId: string;
  userId: string;
  scopeId: string;
  goal: string;
  title: string;
  mission: MissionEnvelopeNode;
  modelId?: string;
  modelCategory?: ModelCategory;
  /** Immutable request input parsed only by the development HTTP composition. */
  executionSelection?: ExecutionSelection;
  executionTarget?: ExecutionTarget;
  trigger: PlannerRunTrigger;
  vars?: Record<string, unknown>;
  sourceRunId?: string | null;
  securityOpsFlags?: Record<string, unknown>;
  workflowDiscipline: 'pentest' | 'compliance';
  complianceFrameworkKey?: ComplianceFrameworkKey | null;
  maxConcurrentRuns?: number | null;
  maxQueuedBacklog?: number | null;
  schedulingClass?: RunSchedulingClass;
  /** Internal scheduler handoff. */
  admission?: StartPlannerRunParams['admission'];
};

export type StartReportOnlyRunResult = StartPlannerRunResult & {
  phaseId: string | null;
};

type ReportLaunchPayloadV1 = {
  version: 1;
  kind: 'report_only';
  params: Omit<StartReportOnlyRunParams, 'admission' | 'maxConcurrentRuns' | 'maxQueuedBacklog' | 'schedulingClass'>;
};

const serializeReportLaunchPayload = (params: StartReportOnlyRunParams): Record<string, unknown> => {
  const {
    admission: _admission,
    maxConcurrentRuns: _maxConcurrentRuns,
    maxQueuedBacklog: _maxQueuedBacklog,
    schedulingClass: _schedulingClass,
    ...launchParams
  } = params;
  return JSON.parse(JSON.stringify({ version: 1, kind: 'report_only', params: launchParams })) as Record<
    string,
    unknown
  >;
};

const parseReportLaunchPayload = (value: unknown): ReportLaunchPayloadV1 => {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'report_only' || !isRecord(value.params)) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Queued report launch payload is invalid.');
  }
  const params = value.params;
  if (
    typeof params.orgId !== 'string' ||
    typeof params.userId !== 'string' ||
    typeof params.scopeId !== 'string' ||
    typeof params.goal !== 'string' ||
    !isRecord(params.mission)
  ) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Queued report launch payload is invalid.');
  }
  return value as unknown as ReportLaunchPayloadV1;
};

export type StartFindingDispositionVerificationRunParams = {
  orgId: string;
  userId: string;
  scopeId: string;
  verificationId: string;
  findingId: string;
  requestedState: 'resolved' | 'dismissed';
  snapshot: FindingDispositionSnapshot;
  launchKey: string;
  reason?: string | null;
  modelId?: string;
  modelCategory?: ModelCategory;
  beforeKickoff?: (result: { run: RunRow; sessionId: string; phaseId: string }) => Promise<void>;
  maxConcurrentRuns?: number | null;
  maxQueuedBacklog?: number | null;
  schedulingClass?: RunSchedulingClass;
  admission?: StartPlannerRunParams['admission'];
};

export type StartFindingDispositionVerificationRunResult = StartPlannerRunResult & {
  phaseId: string | null;
};

type FindingDispositionLaunchPayloadV1 = {
  version: 1;
  kind: 'finding_disposition';
  params: Omit<
    StartFindingDispositionVerificationRunParams,
    'admission' | 'beforeKickoff' | 'maxConcurrentRuns' | 'maxQueuedBacklog' | 'schedulingClass'
  >;
};

const serializeFindingDispositionLaunchPayload = (
  params: StartFindingDispositionVerificationRunParams,
): Record<string, unknown> => {
  const {
    admission: _admission,
    beforeKickoff: _beforeKickoff,
    maxConcurrentRuns: _maxConcurrentRuns,
    maxQueuedBacklog: _maxQueuedBacklog,
    schedulingClass: _schedulingClass,
    ...launchParams
  } = params;
  return JSON.parse(
    JSON.stringify({
      version: 1,
      kind: 'finding_disposition',
      params: launchParams,
    }),
  ) as Record<string, unknown>;
};

const parseFindingDispositionLaunchPayload = (value: unknown): FindingDispositionLaunchPayloadV1 => {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'finding_disposition' || !isRecord(value.params)) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Queued finding verification payload is invalid.');
  }
  const params = value.params;
  if (
    typeof params.orgId !== 'string' ||
    typeof params.userId !== 'string' ||
    typeof params.scopeId !== 'string' ||
    typeof params.verificationId !== 'string' ||
    typeof params.findingId !== 'string' ||
    !isRecord(params.snapshot)
  ) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Queued finding verification payload is invalid.');
  }
  return value as unknown as FindingDispositionLaunchPayloadV1;
};

export type ApproveRunParams = {
  orgId: string;
  runId: string;
  userId: string;
  toolPolicy?: ToolAccessPolicy;
  /** Who/what authorized the plan approval continuation (H-2026-05-28-010 observability). */
  approvalSource?: 'user' | 'auto';
  /** Optional machine-readable reason, e.g. the auto-approval trigger. */
  approvalReason?: string;
};

export type ApproveRunResult = {
  run: RunRow;
  sessionId: string;
  policySlug: string;
  runnerName: string | null;
};

export type StartReportingPhaseResult = {
  run: RunRow;
  sessionId: string;
  phaseId: string;
};

export type StartValidationPhaseResult = {
  run: RunRow;
  sessionId: string;
  phaseId: string;
  queuedFindingIds: string[];
};

export type StartExecutionPhaseResult = {
  run: RunRow;
  sessionId: string;
  phaseId: string;
  phaseKey: FreshExecutionPhaseKey;
};

export type RequestPlanFeedbackParams = {
  orgId: string;
  runId: string;
  feedback: string;
};

export type RequestPlanFeedbackResult = {
  run: RunRow;
  plannerSessionId: string;
};

export type StartReadyPhaseRunsResult = {
  attempted: number;
  started: number;
  skipped: number;
  failed: number;
  inFlight: boolean;
};

type StartRunServiceDeps = Omit<StartRunWorkspaceServiceDeps, 'runService' | 'agentServices' | 'sessionRepository'> & {
  runService: RunService;
  scopeService: ScopeService;
  runnerService: RunnerService;
  sessionService: SessionService;
  phaseSessionFactory?: {
    create: (input: CreatePhaseSessionInput) => ReturnType<SessionService['createSession']>;
  };
  agentServices: Pick<AgentApiServices, 'sessionStore' | 'orchestrator' | 'sandbox' | 'traceRecorder'>;
  sessionRepository?: {
    setCompleted?: (id: string, completed: boolean) => Promise<boolean>;
    setBlockedReason?: (id: string, reason: string, meta?: Record<string, unknown>) => Promise<boolean>;
    clearBlockedReason?: (id: string, expectedReason?: string) => Promise<boolean>;
  };
  /**
   * Renders Threat Watch exposures as validation leads at run start.
   *
   * Optional, mirroring the other capability-shaped deps: a node without Threat
   * Watch simply starts runs without exposure leads rather than failing.
   */
  exposureLeadInjector?: Pick<ExposureLeadInjector, 'injectForRun'>;
  cloudScheduling?: {
    config: CloudRunSchedulingConfig;
    queue?: RunAdmissionQueue;
    leases?: CapacityLeaseService;
  };
};

export class StartRunService {
  private phaseStartSweepInFlight = false;
  private readonly phaseStartRunIds = new Set<string>();
  private readonly workspaceService: StartRunWorkspaceService;
  private readonly replanService: StartRunReplanService;
  private readonly runtimeService: StartRunRuntimeService;
  private readonly phaseSessionFactory: Pick<PhaseSessionFactory, 'create'>;
  private readonly cloudScheduling: NonNullable<StartRunServiceDeps['cloudScheduling']>;

  constructor(private readonly deps: StartRunServiceDeps) {
    this.cloudScheduling = deps.cloudScheduling ?? {
      config: loadCloudRunSchedulingConfig(),
    };
    this.workspaceService = new StartRunWorkspaceService(deps);
    this.replanService = new StartRunReplanService(deps);
    this.phaseSessionFactory = deps.phaseSessionFactory ?? new PhaseSessionFactory(deps.sessionService);
    this.runtimeService = new StartRunRuntimeService(deps);
  }

  private async loadSession(sessionId: string | null | undefined) {
    if (!sessionId) return null;
    return (
      (await this.deps.agentServices.sessionStore.getOrHydrate?.(sessionId)) ??
      this.deps.agentServices.sessionStore.get(sessionId) ??
      null
    );
  }

  private async stopPriorPhaseSessionBeforeAdvance(params: {
    phase: Pick<RunPhaseRow, 'id' | 'runId' | 'phaseKey' | 'sessionId'> | null | undefined;
    nextPhaseKey: RunPhaseKey;
    terminalStatus?: Extract<RunPhaseStatus, 'completed' | 'blocked' | 'failed'>;
    caller: string;
  }): Promise<void> {
    const phase = params.phase;
    const sessionId = phase?.sessionId?.trim();
    if (!phase || !sessionId) {
      return;
    }

    const stoppedAt = new Date().toISOString();
    const meta = {
      reason: 'phase_terminalized_before_next_phase',
      runId: phase.runId,
      phaseId: phase.id,
      phaseKey: phase.phaseKey,
      terminalStatus: params.terminalStatus ?? null,
      nextPhaseKey: params.nextPhaseKey,
      stoppedAt,
    };

    workCancellationRegistry.markSessionCancelled(sessionId);

    await this.deps.sessionRepository
      ?.setBlockedReason?.(sessionId, PHASE_TERMINALIZED_BLOCKED_REASON, meta)
      .catch((error) => {
        logger.warn(
          {
            err: error,
            runId: params.phase?.runId,
            phaseId: params.phase?.id,
            sessionId,
            caller: params.caller,
          },
          '[runs] Failed to persist terminalized phase session marker',
        );
        return false;
      });

    await this.deps.agentServices.sessionStore
      .abortCurrentTurnAsync?.(sessionId, 'phase_terminalized_before_next_phase')
      .catch((error) => {
        logger.warn(
          {
            err: error,
            runId: params.phase?.runId,
            phaseId: params.phase?.id,
            sessionId,
            caller: params.caller,
          },
          '[runs] Failed to abort terminalized phase session',
        );
      });

    const liveSession =
      (await this.deps.agentServices.sessionStore.getOrHydrate?.(sessionId).catch((error) => {
        logger.warn(
          {
            err: error,
            runId: params.phase?.runId,
            phaseId: params.phase?.id,
            sessionId,
            caller: params.caller,
          },
          '[runs] Failed to hydrate terminalized phase session',
        );
        return null;
      })) ?? this.deps.agentServices.sessionStore.get(sessionId);

    if (!liveSession) {
      return;
    }

    liveSession.stateMachine?.stopProcessing?.(PHASE_TERMINALIZED_BLOCKED_REASON, liveSession.turn ?? 0, params.caller);
    liveSession.blockedReason = PHASE_TERMINALIZED_BLOCKED_REASON;
    liveSession.blockedMeta = meta;
    liveSession.flags = {
      ...(liveSession.flags ?? {}),
      blocked_reason: PHASE_TERMINALIZED_BLOCKED_REASON,
      phaseLifecycle: {
        ...(liveSession.flags?.phaseLifecycle &&
        typeof liveSession.flags.phaseLifecycle === 'object' &&
        !Array.isArray(liveSession.flags.phaseLifecycle)
          ? liveSession.flags.phaseLifecycle
          : {}),
        terminalizedBeforeNextPhase: true,
        ...meta,
      },
    };

    await this.deps.agentServices.sessionStore
      .setAsync(sessionId, liveSession, 'securityops.phase_terminalized')
      .catch((error) => {
        logger.warn(
          {
            err: error,
            runId: params.phase?.runId,
            phaseId: params.phase?.id,
            sessionId,
            caller: params.caller,
          },
          '[runs] Failed to persist terminalized phase session state',
        );
      });

    await this.deps.agentServices.sandbox.destroy(liveSession).catch((error) => {
      logger.warn(
        {
          err: error,
          runId: params.phase?.runId,
          phaseId: params.phase?.id,
          sessionId,
          caller: params.caller,
        },
        '[runs] Failed to destroy terminalized phase sandbox',
      );
    });
  }

  usesQueuedCloudAdmission(executionTarget: ExecutionTarget = 'cloud'): boolean {
    return executionTarget === 'cloud' && this.cloudScheduling.config.queueCloudRuns;
  }

  async launchAdmittedPlannerRun(params: {
    run: RunRow;
    claimOwner: string;
    leaseId: string;
    runner: RunnerRow;
  }): Promise<StartPlannerRunResult> {
    if (params.run.status !== 'queued' || !params.run.admittedAt) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Run is not in an admitted queued state.');
    }
    const payload = parsePlannerLaunchPayload(params.run.launchPayload);
    return this.startPlannerRun({
      ...payload.params,
      admission: {
        runId: params.run.id,
        admissionEpoch: params.run.admissionEpoch,
        claimOwner: params.claimOwner,
        leaseId: params.leaseId,
        runner: params.runner,
      },
    });
  }

  private async cloudAdmissionRuntimeFlagsForRun(
    run: Pick<RunRow, 'id' | 'executionTarget' | 'admissionEpoch'>,
  ): Promise<Record<string, unknown>> {
    if (
      run.executionTarget !== 'cloud' ||
      run.admissionEpoch <= 0 ||
      !this.usesQueuedCloudAdmission(normalizeExecutionTarget(run.executionTarget))
    ) {
      return {};
    }
    const ownership = await this.cloudScheduling.leases?.getRuntimeOwnership(run.id, run.admissionEpoch);
    if (!ownership) {
      throw new AppError(
        ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
        'Active cloud Run capacity ownership is missing; refusing to create an unowned phase runtime.',
      );
    }
    return {
      cloudAdmission: {
        admissionEpoch: run.admissionEpoch,
        leaseId: ownership.leaseId,
        bundleKey: ownership.bundleKey,
      },
    };
  }

  async launchAdmittedRun(params: {
    run: RunRow;
    claimOwner: string;
    leaseId: string;
    runner: RunnerRow;
  }): Promise<StartPlannerRunResult | StartReportOnlyRunResult | StartFindingDispositionVerificationRunResult> {
    const kind = isRecord(params.run.launchPayload) ? params.run.launchPayload.kind : null;
    if (kind === 'planner') return this.launchAdmittedPlannerRun(params);
    if (kind === 'report_only') {
      if (params.run.status !== 'queued' || !params.run.admittedAt) {
        throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Run is not admitted.');
      }
      const payload = parseReportLaunchPayload(params.run.launchPayload);
      return this.startReportOnlyRun({
        ...payload.params,
        admission: {
          runId: params.run.id,
          admissionEpoch: params.run.admissionEpoch,
          claimOwner: params.claimOwner,
          leaseId: params.leaseId,
          runner: params.runner,
        },
      });
    }
    if (kind === 'finding_disposition') {
      if (params.run.status !== 'queued' || !params.run.admittedAt) {
        throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Run is not admitted.');
      }
      const payload = parseFindingDispositionLaunchPayload(params.run.launchPayload);
      return this.startFindingDispositionVerificationRun({
        ...payload.params,
        admission: {
          runId: params.run.id,
          admissionEpoch: params.run.admissionEpoch,
          claimOwner: params.claimOwner,
          leaseId: params.leaseId,
          runner: params.runner,
        },
      });
    }
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Unsupported queued run launch kind.');
  }

  async cleanupAdmittedLaunchFailure(orgId: string, runId: string, admissionEpoch: number): Promise<void> {
    const run = await this.deps.runService.getById(orgId, runId).catch(() => null);
    const sessionId = run?.sessionId?.trim();
    if (sessionId) {
      const session =
        (await this.deps.agentServices.sessionStore.getOrHydrate?.(sessionId)) ??
        this.deps.agentServices.sessionStore.get(sessionId);
      if (session) {
        await this.deps.agentServices.sandbox.destroy(session);
      }
      await this.deps.agentServices.sessionStore.removeAsync(sessionId, 'explicit').catch((error) => {
        logger.warn({ err: error, runId, sessionId }, '[runs] Failed to remove rejected admitted session');
      });
    }
    await this.deps.agentServices.sandbox.destroyOwnedBundleAndVerify({
      runId,
      admissionEpoch,
    });
    if (isRecord(run?.launchPayload) && run.launchPayload.kind === 'finding_disposition') {
      const payload = parseFindingDispositionLaunchPayload(run.launchPayload);
      await this.deps.runService.resetFindingDispositionVerificationLaunch({
        verificationId: payload.params.verificationId,
        runId,
      });
    }
  }

  async startPlannerRun(params: StartPlannerRunParams): Promise<StartPlannerRunResult> {
    const workflowDiscipline = params.workflowDiscipline ?? 'pentest';
    const identityValidation = validateRunWorkflowIdentity({
      workflowDiscipline,
      complianceFrameworkKey: params.complianceFrameworkKey,
      codeReviewOperation: params.codeReviewOperation,
      codeReviewContext: params.codeReviewContext,
    });
    if (!identityValidation.ok) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Invalid ${workflowDiscipline} run identity: ${identityValidation.issues.join('; ')}`,
      );
    }
    assertCodeReviewLaunchAvailable(workflowDiscipline, params.codeReviewOperation);

    await this.deps.scopeService.getById(params.orgId, params.scopeId);
    const executionTarget = normalizeExecutionTarget(params.executionTarget);
    const codeReviewContext = workflowDiscipline === 'code_review' ? (params.codeReviewContext ?? null) : null;
    if (codeReviewContext && !params.codeReviewManifestFiles) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Standalone Code Review requires the immutable repository manifest at run start',
      );
    }
    const workflowIdentity = codeReviewContext ? buildCodeReviewIdempotencyIdentity(codeReviewContext) : undefined;
    const stablePullRequestIdentity = codeReviewContext?.operation === 'pull_request_review';
    const explicitIdempotencyKey = params.idempotencyKey?.trim() || null;
    const idempotencyKey =
      params.idempotency === 'disabled'
        ? null
        : (explicitIdempotencyKey ??
          this.deps.runService.buildRunIdempotencyKey(params.scopeId, {
            goal: stablePullRequestIdentity ? workflowIdentity : params.goal,
            modelId: stablePullRequestIdentity ? undefined : params.modelId,
            modelCategory: stablePullRequestIdentity ? undefined : params.modelCategory,
            executionTarget,
            workflowDiscipline,
            workflowIdentity,
            stable: stablePullRequestIdentity,
          }));

    if (idempotencyKey && !params.admission) {
      const existingRun = await this.deps.runService.getByIdempotencyKey(params.orgId, idempotencyKey);
      if (existingRun && !(params.replaceFailedIdempotentRun && existingRun.status === 'failed')) {
        const existingPolicySlug = await this.runtimeService.resolvePolicySlugForRunner(
          params.orgId,
          existingRun.runnerId,
        );
        return this.runtimeService.buildReplayResult(existingRun, existingPolicySlug);
      }
    }

    // The queued Run already reserved its scope slot transactionally at
    // submission. Re-counting here includes that same row and can deadlock a
    // full scope backlog where every admitted Run rejects itself.
    if (!params.admission) {
      await this.deps.runService.enforceScopeConcurrencyLimit(params.orgId, params.scopeId, workflowDiscipline);
    }
    const scopeContext = await this.deps.scopeService.getScopeContext(params.scopeId);
    if (codeReviewContext) {
      const repository = scopeContext.connectedRepositories.find(
        (candidate) =>
          candidate.id === codeReviewContext.repository.repositoryId ||
          candidate.fullName.toLowerCase() === codeReviewContext.repository.fullName.toLowerCase(),
      );
      if (!repository) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'The immutable Code Review repository is not connected to this scope',
        );
      }
      if (
        repository.id !== codeReviewContext.repository.repositoryId ||
        repository.fullName.toLowerCase() !== codeReviewContext.repository.fullName.toLowerCase()
      ) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'The Code Review repository id and full name do not identify the same connected repository',
        );
      }
    }
    const codeReviewMemorySnapshot =
      codeReviewContext && params.codeReviewManifestFiles
        ? await this.deps.runService.buildCodeReviewMemorySnapshot({
            organizationId: params.orgId,
            scopeId: params.scopeId,
            userId: params.userId,
            context: codeReviewContext,
            manifestFiles: params.codeReviewManifestFiles,
            repositoryBrief: params.codeReviewRepositoryBrief,
          })
        : null;
    const warnings = await this.deps.runService.enforceRunPrerequisites({
      orgId: params.orgId,
      scopeId: params.scopeId,
      goal: params.goal,
      scopeContext,
      executionTarget,
      networkActivityRequired: workflowDiscipline !== 'code_review',
    });

    const scheduling = this.cloudScheduling;
    if (executionTarget === 'cloud' && this.usesQueuedCloudAdmission(executionTarget) && !params.admission) {
      if (
        params.maxConcurrentRuns === undefined ||
        (params.maxConcurrentRuns !== null &&
          (!Number.isInteger(params.maxConcurrentRuns) || Number(params.maxConcurrentRuns) <= 0))
      ) {
        throw new AppError(
          ERROR_CODES.INTERNAL_CONFIGURATION,
          'Cloud scheduling requires the authoritative plan concurrency limit at submission.',
        );
      }
      const schedulingClass = params.schedulingClass ?? 'free';
      const maxQueuedBacklog = params.maxQueuedBacklog ?? scheduling.config.backlogByClass[schedulingClass];
      // Reserve the conservative minimum-progress bundle up front. Included
      // worker subleases consume that reservation; optional workers serialize
      // behind additional capacity instead of deadlocking two parent Runs.
      const runResult = await this.deps.runService.createRunRecord({
        orgId: params.orgId,
        scopeId: params.scopeId,
        userId: params.userId,
        sessionId: null,
        plannerSessionId: null,
        goal: params.goal,
        title: params.title,
        modelId: params.modelId,
        modelCategory: params.modelCategory ?? null,
        workflowDiscipline,
        codeReviewOperation: workflowDiscipline === 'code_review' ? (params.codeReviewOperation ?? null) : null,
        codeReviewContext,
        complianceFrameworkKey: workflowDiscipline === 'compliance' ? (params.complianceFrameworkKey ?? null) : null,
        trigger: params.trigger,
        executionTarget,
        runnerId: null,
        initialStatus: 'queued',
        idempotencyKey,
        ...(params.replaceFailedIdempotentRun ? { replaceFailedIdempotentRun: true } : {}),
        maxConcurrentRuns: params.maxConcurrentRuns,
        maxQueuedBacklog,
        admissionPurpose: 'planning',
        schedulingClass,
        capacityProfile: 'heavy',
        capacityProfileVersion: scheduling.config.profiles.heavy.version,
        launchPayload: serializePlannerLaunchPayload(params),
      });
      if (!runResult.created) {
        return this.runtimeService.buildReplayResult(runResult.run, resolvePolicyForRunnerType(undefined));
      }
      return {
        run: runResult.run,
        sessionId: null,
        policySlug: resolvePolicyForRunnerType(undefined),
        warnings,
        runner: null,
        runnerName: null,
        idempotentReplay: false,
      };
    }

    const resolvedRunner =
      params.admission?.runner ??
      (await this.deps.runnerService.resolveRunner(params.orgId, params.scopeId, executionTarget));
    const policySlug = resolvePolicyForRunnerType(resolvedRunner?.type);
    const enumerationRuntimeContext = {
      enumerationWorkerV1: resolveEnumerationWorkerCapabilitySnapshot({
        organizationId: params.orgId,
      }),
      enumerationImpactTolerance: scopeContext.impactTolerance,
      enumerationSourceMode:
        scopeContext.testingPosture === 'gray-box' ? 'greybox' : scopeContext.testingPosture.replace('-', ''),
      enumerationTargetRefs: scopeContext.targets.filter((target) => target.verified).map((target) => target.value),
      enumerationExclusions: scopeContext.exclusions,
      exploitationExclusions: scopeContext.exclusions,
    };
    const planningSkillSlugs = uniqueSkillSlugs(
      params.planningSkillSlugs && params.planningSkillSlugs.length > 0
        ? params.planningSkillSlugs
        : params.trigger === 'exposure_verification'
          ? ['cve-verification']
          : workflowDiscipline === 'compliance'
            ? ['compliance-planning']
            : workflowDiscipline === 'code_review'
              ? ['code-review-planning']
              : ['securityops-planning'],
    );

    const exposureAssetValue =
      params.trigger === 'exposure_verification' ? nonEmptyString(params.vars?.assetValue) : null;
    const promptScopeContext =
      params.trigger === 'exposure_verification'
        ? focusScopeContextOnAsset(scopeContext, exposureAssetValue ? { value: exposureAssetValue } : null)
        : scopeContext;
    const plannerContextBase = codeReviewContext
      ? ['=== CODE REVIEW RUN CONTEXT ===', JSON.stringify(codeReviewContext, null, 2)].join('\n')
      : await this.deps.runService.buildExtraContextFromParts(params.orgId, promptScopeContext, executionTarget);
    const priorRunContext =
      params.trigger === 'exposure_verification'
        ? ''
        : codeReviewContext
          ? (codeReviewMemorySnapshot?.promptText ?? '')
          : await this.deps.runService.buildPriorRunContext(
              params.orgId,
              params.scopeId,
              workflowDiscipline,
              workflowDiscipline === 'compliance' ? (params.complianceFrameworkKey ?? null) : null,
            );
    const complianceAssessmentContext =
      workflowDiscipline === 'compliance'
        ? (params.securityOpsFlags?.complianceAssessment ??
          params.vars?.complianceAssessment ??
          (params.complianceFrameworkKey ? { framework: params.complianceFrameworkKey } : null))
        : null;
    const compliancePlannerContext =
      workflowDiscipline === 'compliance'
        ? [
            '=== COMPLIANCE ASSESSMENT MISSION ===',
            JSON.stringify(
              {
                discipline: 'compliance',
                assessment: complianceAssessmentContext,
                requiredPlannerShape: [
                  'one control_assessment mission assigned to compliance-access-control, compliance-technical-readiness, compliance-evidence-review, compliance-governance-review, or the needed combination, with no other skills',
                  'if inventory is empty, stale, or insufficient for selected technical controls, include a bounded inventory/evidence-context step inside the control_assessment mission; do not create a recon mission',
                  'one reporting mission assigned only to compliance-reporting',
                ],
                verdictRule:
                  'Control pass/fail must come from fresh record_control_check evidence. Missing evidence, access, context, or remediation must produce record_control_request rather than an inferred pass/fail.',
              },
              null,
              2,
            ),
          ].join('\n')
        : '';
    const plannerSkillContext =
      planningSkillSlugs.length > 0
        ? await this.deps.runService.buildAssignedSkillsContext(params.orgId, params.scopeId, planningSkillSlugs)
        : '';
    const plannerContextSections = [
      plannerContextBase,
      priorRunContext,
      compliancePlannerContext,
      plannerSkillContext,
      `=== RUN GOAL ===\n${params.goal}`,
    ];
    if (params.vars && Object.keys(params.vars).length > 0) {
      plannerContextSections.push(`=== OPERATOR VARS ===\n${JSON.stringify(params.vars, null, 2)}`);
    }
    const plannerExtraContext = plannerContextSections.filter((value) => value.trim().length > 0).join('\n\n');

    const plannerToolPolicy = buildPlannerToolPolicy(
      scopeContext,
      workflowDiscipline === 'code_review'
        ? CODE_REVIEW_PLANNER_TOOL_POLICY
        : workflowDiscipline === 'compliance'
          ? COMPLIANCE_PLANNER_TOOL_POLICY
          : params.toolPolicy,
    );

    const { session, model } = await this.deps.sessionService.createSession({
      userId: params.userId,
      organizationId: params.orgId,
      modelId: params.modelId,
      modelCategory: params.modelCategory,
      executionSelection: params.executionSelection,
      profileKey: policySlug,
      extraContext: plannerExtraContext,
      flags: {
        securityops: {
          ...createRunnerSecurityOpsFlags({
            organizationId: params.orgId,
            scopeId: params.scopeId,
            runId: params.admission?.runId,
            workflowDiscipline,
            executionTarget,
            runnerId: resolvedRunner?.id ?? null,
            runnerName: resolvedRunner?.name ?? null,
            extra: withComplianceFrameworkContext({
              workflowDiscipline,
              frameworkKey: params.complianceFrameworkKey ?? null,
              codeReviewOperation: params.codeReviewOperation ?? null,
              codeReviewContext,
              extra: {
                ...(params.securityOpsFlags ?? {}),
                runTrigger: params.trigger,
                ...(workflowDiscipline === 'code_review' ? {} : enumerationRuntimeContext),
                ...cloudAdmissionRuntimeFlags(params.admission),
              },
            }),
          }),
          // Planning is a real authorization boundary for phase-scoped tools.
          // Without this, Code Review planners are given repository tools that
          // immediately reject them as being outside the planning phase.
          activePhaseKey: 'planning',
        },
      },
      scopeId: params.scopeId,
      mode: 'automated',
      agentType: 'planner',
      promptProfile:
        params.plannerPromptProfile ??
        (params.trigger === 'exposure_verification'
          ? 'exposure-verification'
          : workflowDiscipline === 'code_review'
            ? 'code-review-planner'
            : workflowDiscipline === 'compliance'
              ? 'compliance-planner'
              : 'planner'),
      toolPolicy: plannerToolPolicy,
      lazySandbox: true,
    });

    const runResult = params.admission
      ? {
          run: await this.deps.runService.attachSessionToAdmittedRun({
            runId: params.admission.runId,
            claimOwner: params.admission.claimOwner,
            admissionEpoch: params.admission.admissionEpoch,
            sessionId: session.id,
            modelId: model.id ?? params.modelId,
            modelCategory: params.modelCategory ?? model.selectionCategory ?? null,
          }),
          created: true,
        }
      : await this.deps.runService.createRunRecord({
          orgId: params.orgId,
          scopeId: params.scopeId,
          userId: params.userId,
          sessionId: session.id,
          plannerSessionId: session.id,
          goal: params.goal,
          title: params.title,
          modelId: model.id ?? params.modelId,
          modelCategory: params.modelCategory ?? model.selectionCategory ?? null,
          workflowDiscipline,
          codeReviewOperation: workflowDiscipline === 'code_review' ? (params.codeReviewOperation ?? null) : null,
          codeReviewContext,
          complianceFrameworkKey: workflowDiscipline === 'compliance' ? (params.complianceFrameworkKey ?? null) : null,
          trigger: params.trigger,
          executionTarget,
          runnerId: resolvedRunner?.id ?? null,
          initialStatus: 'running',
          idempotencyKey,
          ...(params.replaceFailedIdempotentRun ? { replaceFailedIdempotentRun: true } : {}),
          maxConcurrentRuns: params.maxConcurrentRuns,
          launchPayload: serializePlannerLaunchPayload(params),
        });

    if (!runResult.created) {
      this.deps.agentServices.sessionStore.remove(session.id, 'explicit');
      return this.runtimeService.buildReplayResult(runResult.run, policySlug);
    }

    if (codeReviewContext && codeReviewMemorySnapshot) {
      try {
        await this.deps.runService.persistCodeReviewMemorySnapshot({
          runId: runResult.run.id,
          organizationId: params.orgId,
          scopeId: params.scopeId,
          context: codeReviewContext,
          snapshot: codeReviewMemorySnapshot,
        });
      } catch (error) {
        const appError = new AppError(
          ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
          'The Code Review memory snapshot could not be persisted, so the run was not started',
          {
            context: {
              runId: runResult.run.id,
              repositoryId: codeReviewContext.repository.repositoryId,
            },
            cause: error instanceof Error ? error : undefined,
          },
        );
        await this.workspaceService.failRunStart({
          orgId: params.orgId,
          run: runResult.run,
          session,
          error: appError,
          code: 'code_review_memory_snapshot_failed',
          reason: 'run_start_code_review_memory_snapshot_failed',
        });
        throw appError;
      }
    }

    const runWorkspaceSession = await this.deps.agentServices.sessionStore.assignRunWorkspaceAsync(
      session.id,
      runResult.run.id,
      'securityops.run_created',
    );
    if (runWorkspaceSession?.workspaceDir) {
      session.workspaceDir = runWorkspaceSession.workspaceDir;
    }

    await this.deps.agentServices.sessionStore.mergeFlagNamespaceAsync(session.id, 'securityops', {
      ...createRunnerSecurityOpsFlags({
        organizationId: params.orgId,
        scopeId: params.scopeId,
        runId: runResult.run.id,
        workflowDiscipline,
        executionTarget,
        runnerId: resolvedRunner?.id ?? null,
        runnerName: resolvedRunner?.name ?? null,
        extra: withComplianceFrameworkContext({
          workflowDiscipline,
          frameworkKey: params.complianceFrameworkKey ?? null,
          codeReviewOperation: params.codeReviewOperation ?? null,
          codeReviewContext,
          extra: {
            ...(params.securityOpsFlags ?? {}),
            runTrigger: params.trigger,
            ...(workflowDiscipline === 'code_review' ? {} : enumerationRuntimeContext),
            ...cloudAdmissionRuntimeFlags(params.admission),
          },
        }),
      }),
      activePhaseKey: 'planning',
    });
    await this.runtimeService.recordExecutionEnvironmentTimeline(
      session.id,
      executionTarget,
      resolvedRunner?.name ?? null,
    );

    try {
      await syncAssignedSkillsIntoWorkspace(planningSkillSlugs, session.workspaceDir);
      await this.workspaceService.projectRunWorkspace({
        orgId: params.orgId,
        scopeId: params.scopeId,
        runId: runResult.run.id,
        session,
        phaseKey: 'planning',
        assignedSkillSlugs: planningSkillSlugs,
        reason: 'run_start',
        scopes: ['all'],
      });
    } catch (error) {
      const appError = toWorkspaceProjectionAppError(error, {
        orgId: params.orgId,
        scopeId: params.scopeId,
        runId: runResult.run.id,
        sessionId: session.id,
        reason: 'run_start',
      });
      await this.workspaceService.failRunStartForWorkspaceProjectionFailure({
        orgId: params.orgId,
        run: runResult.run,
        session,
        error: appError,
      });
      throw appError;
    }

    let startedRun = runResult.run;
    if (params.admission) {
      const queue = scheduling?.queue;
      const leases = scheduling?.leases;
      if (!queue || !leases) {
        throw new AppError(ERROR_CODES.INTERNAL_CONFIGURATION, 'Admission runtime services are unavailable.');
      }
      await leases.activateLease({
        leaseId: params.admission.leaseId,
        sessionId: session.id,
      });
      startedRun = await queue.markStarted({
        runId: runResult.run.id,
        owner: params.admission.claimOwner,
        sessionId: session.id,
      });
    }

    await this.runtimeService.kickoffPlanner(startedRun.id, session.id, {
      workflowDiscipline,
      trigger: params.trigger,
    });

    return {
      run: startedRun,
      sessionId: session.id,
      policySlug,
      warnings,
      runner: resolvedRunner
        ? {
            id: resolvedRunner.id,
            name: resolvedRunner.name,
            type: resolvedRunner.type,
            status: resolvedRunner.status,
          }
        : null,
      runnerName: resolvedRunner?.name ?? null,
      idempotentReplay: false,
    };
  }

  async startReportOnlyRun(params: StartReportOnlyRunParams): Promise<StartReportOnlyRunResult> {
    await this.deps.scopeService.getById(params.orgId, params.scopeId);
    const executionTarget = normalizeExecutionTarget(params.executionTarget);
    const workflowDiscipline = params.workflowDiscipline;
    const isComplianceReportOnly = workflowDiscipline === 'compliance';
    if (!params.admission) {
      await this.deps.runService.enforceScopeConcurrencyLimit(params.orgId, params.scopeId, workflowDiscipline);
    }
    const scopeContext = await this.deps.scopeService.getScopeContext(params.scopeId);
    const warnings = await this.deps.runService.enforceRunPrerequisites({
      orgId: params.orgId,
      scopeId: params.scopeId,
      goal: params.goal,
      scopeContext,
      executionTarget,
      networkActivityRequired: false,
    });
    const resolvedRunner =
      params.admission?.runner ??
      (await this.deps.runnerService.resolveRunner(params.orgId, params.scopeId, executionTarget));
    const policySlug = resolvePolicyForRunnerType(resolvedRunner?.type);
    const resolvedRunnerName = resolvedRunner?.name ?? null;
    const reportingSkill = isComplianceReportOnly ? 'compliance-reporting' : 'security-reporting';
    const reportingPromptProfile: PromptProfile = isComplianceReportOnly ? 'compliance-reporting' : 'phase-reporting';
    const reportingToolPolicy = phaseProfileRegistry.buildToolPolicy('reporting', {
      ...scopeContext,
      complianceReporting: isComplianceReportOnly,
    });
    const reportingSkills = [reportingSkill];
    const missionEnvelopeNodes = attachMissionPhases([
      {
        ...params.mission,
        phase: 'reporting',
        assignedSkills: [reportingSkill],
      },
    ]);
    const planDocument = [
      `# ${params.title}`,
      '',
      `1. ${params.mission.question}`,
      '',
      'This run is a reporting-only closeout from existing canonical evidence.',
    ].join('\n');

    if (executionTarget === 'cloud' && this.usesQueuedCloudAdmission(executionTarget) && !params.admission) {
      if (
        params.maxConcurrentRuns === undefined ||
        (params.maxConcurrentRuns !== null &&
          (!Number.isInteger(params.maxConcurrentRuns) || Number(params.maxConcurrentRuns) <= 0))
      ) {
        throw new AppError(
          ERROR_CODES.INTERNAL_CONFIGURATION,
          'Cloud scheduling requires the authoritative plan concurrency limit at submission.',
        );
      }
      const schedulingClass = params.schedulingClass ?? 'free';
      const runResult = await this.deps.runService.createRunRecord({
        orgId: params.orgId,
        scopeId: params.scopeId,
        userId: params.userId,
        sessionId: null,
        goal: params.goal,
        title: params.title,
        modelId: params.modelId,
        modelCategory: params.modelCategory ?? null,
        plan: planDocument,
        missionEnvelope: { missions: missionEnvelopeNodes },
        assignedSkillSlugs: reportingSkills,
        workflowDiscipline,
        complianceFrameworkKey: workflowDiscipline === 'compliance' ? (params.complianceFrameworkKey ?? null) : null,
        trigger: params.trigger,
        executionTarget,
        initialStatus: 'queued',
        idempotencyKey: null,
        maxConcurrentRuns: params.maxConcurrentRuns,
        maxQueuedBacklog: params.maxQueuedBacklog ?? this.cloudScheduling.config.backlogByClass[schedulingClass],
        admissionPurpose: 'execution',
        schedulingClass,
        capacityProfile: 'heavy',
        capacityProfileVersion: this.cloudScheduling.config.profiles.heavy.version,
        launchPayload: serializeReportLaunchPayload(params),
      });
      return {
        run: runResult.run,
        sessionId: null,
        phaseId: null,
        policySlug,
        warnings,
        runner: null,
        runnerName: null,
        idempotentReplay: false,
      };
    }
    const executorScopeContext = await this.deps.runService.buildExtraContextFromParts(
      params.orgId,
      scopeContext,
      executionTarget,
      'reporting',
    );
    const assignedSkillsContext = await this.deps.runService.buildAssignedSkillsContext(
      params.orgId,
      params.scopeId,
      reportingSkills,
    );
    const operatorVarsContext =
      params.vars && Object.keys(params.vars).length > 0
        ? `=== OPERATOR VARS ===\n${JSON.stringify(params.vars, null, 2)}`
        : '';
    const initialExtraContext = [
      executorScopeContext,
      assignedSkillsContext,
      `=== RUN GOAL ===\n${params.goal}`,
      operatorVarsContext,
      '=== REPORTING SESSION BOOTSTRAP ===\nA reporting phase will be attached before kickoff. Wait for the reporting phase contract in this context.',
    ]
      .filter((value) => value.trim().length > 0)
      .join('\n\n');

    const { session, model } = await this.phaseSessionFactory.create({
      phaseKey: 'reporting',
      userId: params.userId,
      organizationId: params.orgId,
      modelId: params.modelId,
      modelCategory: params.modelCategory,
      profileKey: policySlug,
      promptProfile: reportingPromptProfile,
      extraContext: initialExtraContext,
      executionMode: 'evidence',
      flags: {
        securityops: createRunnerSecurityOpsFlags({
          organizationId: params.orgId,
          scopeId: params.scopeId,
          runId: params.admission?.runId,
          workflowDiscipline,
          executionTarget,
          runnerId: resolvedRunner?.id ?? null,
          runnerName: resolvedRunnerName,
          extra: withComplianceFrameworkContext({
            workflowDiscipline,
            frameworkKey: params.complianceFrameworkKey ?? null,
            includeReport: isComplianceReportOnly,
            reportSourceRunId: params.sourceRunId ?? null,
            extra: {
              reportingOnly: true,
              ...(params.securityOpsFlags ?? {}),
              ...cloudAdmissionRuntimeFlags(params.admission),
            },
          }),
        }),
      },
      scopeId: params.scopeId,
      planSeed: [],
      toolPolicy: reportingToolPolicy,
      executionSelection: params.executionSelection,
      lazySandbox: true,
    });

    const runResult = params.admission
      ? {
          run: await this.deps.runService.attachSessionToAdmittedRun({
            runId: params.admission.runId,
            claimOwner: params.admission.claimOwner,
            admissionEpoch: params.admission.admissionEpoch,
            sessionId: session.id,
            modelId: model.id ?? params.modelId,
            modelCategory: params.modelCategory ?? model.selectionCategory ?? null,
            sessionRole: 'executor',
          }),
          created: true,
        }
      : await this.deps.runService.createRunRecord({
          orgId: params.orgId,
          scopeId: params.scopeId,
          userId: params.userId,
          sessionId: session.id,
          executorSessionId: session.id,
          goal: params.goal,
          title: params.title,
          modelId: model.id ?? params.modelId,
          modelCategory: params.modelCategory ?? model.selectionCategory ?? null,
          plan: planDocument,
          missionEnvelope: { missions: missionEnvelopeNodes },
          assignedSkillSlugs: reportingSkills,
          workflowDiscipline,
          complianceFrameworkKey: workflowDiscipline === 'compliance' ? (params.complianceFrameworkKey ?? null) : null,
          trigger: params.trigger,
          executionTarget,
          runnerId: resolvedRunner?.id ?? null,
          initialStatus: 'running',
          idempotencyKey: null,
          maxConcurrentRuns: params.maxConcurrentRuns,
        });

    const phaseRows = await this.deps.runService.replaceRunPhasesForReportOnlyRun({
      runId: runResult.run.id,
      missions: missionEnvelopeNodes,
    });
    const reportingPhase = phaseRows.find((phase) => phase.phaseKey === 'reporting');
    if (!reportingPhase) {
      throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to create reporting phase for report-only run');
    }

    const runWorkspaceSession = await this.deps.agentServices.sessionStore.assignRunWorkspaceAsync(
      session.id,
      runResult.run.id,
      'securityops.report_only_run_created',
    );
    if (runWorkspaceSession?.workspaceDir) {
      session.workspaceDir = runWorkspaceSession.workspaceDir;
    }

    if (params.sourceRunId) {
      const sourceRun = await this.deps.runService.getById(params.orgId, params.sourceRunId);
      if (sourceRun.scopeId !== params.scopeId) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'Compliance report source run must belong to the selected scope',
        );
      }
      for (const sourceSessionId of [sourceRun.executorSessionId, sourceRun.sessionId, sourceRun.plannerSessionId]) {
        const sourceSession = sourceSessionId ? this.deps.agentServices.sessionStore.get(sourceSessionId) : null;
        if (sourceSession?.workspaceDir) {
          await this.workspaceService.importSourceRunArtifacts(sourceSession.workspaceDir, session.workspaceDir);
          break;
        }
      }
    }

    const phaseContext = buildReportingPhaseContext({
      reportingMissions: missionEnvelopeNodes,
      phase: {
        id: reportingPhase.id,
        ordinal: reportingPhase.ordinal,
        phaseKey: reportingPhase.phaseKey,
        handoffInRef: null,
      },
      handoffPayload: null,
    });
    const extraContext = [
      executorScopeContext,
      assignedSkillsContext,
      `=== RUN GOAL ===\n${params.goal}`,
      operatorVarsContext,
      phaseContext,
    ]
      .filter((value) => value.trim().length > 0)
      .join('\n\n');

    await ensureRunArtifactRoot(session.workspaceDir, missionEnvelopeNodes);
    await syncAssignedSkillsIntoWorkspace(reportingSkills, session.workspaceDir);
    await this.workspaceService.projectRunWorkspace({
      orgId: params.orgId,
      scopeId: params.scopeId,
      runId: runResult.run.id,
      session,
      phaseKey: 'reporting',
      assignedSkillSlugs: reportingSkills,
      reason: 'report_only_phase_start',
      scopes: ['all'],
    });
    await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.skills');
    await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.artifacts');
    await this.workspaceService.writeAndSyncScopeCredentialsIfAvailable({
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      orgId: params.orgId,
      scopeId: params.scopeId,
      hasScopeAccessMaterials: scopeContext.accessMaterialCount > 0,
    });

    const reportSession = this.deps.agentServices.sessionStore.get(session.id) ?? session;
    await this.deps.agentServices.sessionStore.setAsync(
      reportSession.id,
      {
        ...reportSession,
        extraContext,
        plan: buildPhasePlanSeed(missionEnvelopeNodes, reportingPhase.stepIds, planDocument),
        flags: {
          ...(reportSession.flags ?? {}),
          securityops: createRunnerSecurityOpsFlags({
            organizationId: params.orgId,
            scopeId: params.scopeId,
            runId: runResult.run.id,
            workflowDiscipline,
            executionTarget,
            runnerId: resolvedRunner?.id ?? null,
            runnerName: resolvedRunnerName,
            extra: withComplianceFrameworkContext({
              workflowDiscipline,
              frameworkKey: params.complianceFrameworkKey ?? null,
              includeReport: isComplianceReportOnly,
              reportSourceRunId: params.sourceRunId ?? runResult.run.id,
              extra: {
                reportingOnly: true,
                activePhaseId: reportingPhase.id,
                activePhaseKey: 'reporting',
                phaseHandoffSubmitted: false,
                phaseOrdinal: reportingPhase.ordinal,
                phaseProfile: reportingPhase.phaseProfile,
                toolProfile: reportingPhase.toolProfile,
                promptProfile: reportingPhase.promptProfile,
                phaseAssignedSkillSlugs: reportingSkills,
                handoffInRef: null,
                ...(params.securityOpsFlags ?? {}),
                ...cloudAdmissionRuntimeFlags(params.admission),
              },
            }),
          }),
        },
      },
      'securityops.report_only_context_ready',
    );

    let updatedRun: RunRow;
    try {
      updatedRun = await this.deps.runService.activatePhaseSession({
        runId: runResult.run.id,
        phaseId: reportingPhase.id,
        sessionId: session.id,
        handoffInRef: null,
      });
    } catch (error) {
      await this.workspaceService.markCreatedPhaseSessionUnused({
        session,
        runId: runResult.run.id,
        phaseId: reportingPhase.id,
        phaseKey: 'reporting',
        reason: 'phase_activation_failed',
        error,
      });
      throw error;
    }

    let startedRun = updatedRun;
    if (params.admission) {
      const queue = this.cloudScheduling.queue;
      const leases = this.cloudScheduling.leases;
      if (!queue || !leases) {
        throw new AppError(ERROR_CODES.INTERNAL_CONFIGURATION, 'Admission runtime services are unavailable.');
      }
      await leases.activateLease({
        leaseId: params.admission.leaseId,
        sessionId: session.id,
      });
      startedRun = await queue.markStarted({
        runId: updatedRun.id,
        owner: params.admission.claimOwner,
        sessionId: session.id,
      });
    }

    await this.runtimeService.recordExecutionEnvironmentTimeline(session.id, executionTarget, resolvedRunnerName);
    await this.runtimeService.kickoffExecutor(
      startedRun.id,
      session.id,
      REPORTING_PHASE_KICKOFF_PROMPT,
    );

    return {
      run: startedRun,
      sessionId: session.id,
      phaseId: reportingPhase.id,
      policySlug,
      warnings,
      runner: resolvedRunner
        ? {
            id: resolvedRunner.id,
            name: resolvedRunner.name,
            type: resolvedRunner.type,
            status: resolvedRunner.status,
          }
        : null,
      runnerName: resolvedRunnerName,
      idempotentReplay: false,
    };
  }

  /**
   * Starts (or repairs) the single-phase Run used to verify a proposed finding
   * disposition. This deliberately has no planner or approval gate. The stable
   * launch key and the session message ledger make retries safe across a crash
   * at any point between Run creation, phase activation, and kickoff.
   */
  async startFindingDispositionVerificationRun(
    params: StartFindingDispositionVerificationRunParams,
  ): Promise<StartFindingDispositionVerificationRunResult> {
    await this.deps.scopeService.getById(params.orgId, params.scopeId);

    const attachedRunner = params.admission
      ? null
      : await this.deps.runnerService.getAttachedRunner(params.orgId, params.scopeId);
    const executionTarget: ExecutionTarget = params.admission ? 'cloud' : attachedRunner ? 'scope_runner' : 'cloud';
    const existingRun = params.admission
      ? null
      : await this.deps.runService.getByIdempotencyKey(params.orgId, params.launchKey);

    if (!existingRun && !params.admission) {
      await this.deps.runService.enforceScopeConcurrencyLimit(params.orgId, params.scopeId, 'pentest');
    }

    const scopeContext = await this.deps.scopeService.getScopeContext(params.scopeId);
    const goal =
      params.requestedState === 'resolved'
        ? `Verify whether finding ${params.findingId} is fixed`
        : `Verify whether finding ${params.findingId} is a false positive`;
    const warnings = existingRun
      ? []
      : await this.deps.runService.enforceRunPrerequisites({
          orgId: params.orgId,
          scopeId: params.scopeId,
          goal,
          scopeContext,
          executionTarget,
          networkActivityRequired: true,
        });
    const resolvedRunner =
      params.admission?.runner ??
      (existingRun
        ? existingRun.runnerId
          ? await this.deps.runnerService.getRunner(params.orgId, existingRun.runnerId)
          : null
        : await this.deps.runnerService.resolveRunner(params.orgId, params.scopeId, executionTarget));
    const policySlug = resolvePolicyForRunnerType(resolvedRunner?.type);
    const assignedSkills = ['validation'];
    const mission: MissionEnvelopeNode = {
      id: `verify-finding-${params.findingId}`,
      phase: 'validation',
      question:
        params.requestedState === 'resolved'
          ? `Does fresh replay prove that finding ${params.findingId} no longer reproduces while its prerequisites still work?`
          : `Does fresh replay disprove the historical claim for finding ${params.findingId} while its prerequisites still work?`,
      whyReadyNow: `An operator requested the ${params.requestedState} state in verification attempt ${params.verificationId}.`,
      requiredEvidence: [
        'Fresh replay evidence produced by this session',
        'Evidence that the intended target, routing, authentication, and required prerequisites worked',
        'An explicit proof-carrying submit_finding_disposition_outcome result',
      ],
      expectedArtifact: `A typed outcome for the requested ${params.requestedState} state of Risk ${params.findingId}`,
      stopCondition: 'Stop after one accepted disposition outcome and the validation phase handoff.',
      assignedSkills,
      revalidatesFindingId: params.findingId,
    };
    const missionEnvelopeNodes = attachMissionPhases([mission]);
    const title =
      params.requestedState === 'resolved'
        ? `Fix verification: ${params.snapshot.finding.title}`
        : `False-positive verification: ${params.snapshot.finding.title}`;
    const planDocument = [
      `# ${title}`,
      '',
      `1. ${mission.question}`,
      '',
      'This is a focused, planner-free finding disposition verification.',
    ].join('\n');

    if (existingRun?.status === 'queued' && !existingRun.sessionId) {
      return {
        run: existingRun,
        sessionId: null,
        phaseId: null,
        policySlug,
        warnings,
        runner: null,
        runnerName: null,
        idempotentReplay: true,
      };
    }

    if (executionTarget === 'cloud' && this.usesQueuedCloudAdmission(executionTarget) && !params.admission) {
      if (params.maxConcurrentRuns === undefined) {
        throw new AppError(
          ERROR_CODES.INTERNAL_CONFIGURATION,
          'Cloud scheduling requires the authoritative plan concurrency limit at submission.',
        );
      }
      const schedulingClass = params.schedulingClass ?? 'internal';
      const runResult = await this.deps.runService.createRunRecord({
        orgId: params.orgId,
        scopeId: params.scopeId,
        userId: params.userId,
        sessionId: null,
        goal,
        title,
        modelId: params.modelId,
        modelCategory: params.modelCategory ?? null,
        plan: planDocument,
        missionEnvelope: { missions: missionEnvelopeNodes },
        assignedSkillSlugs: assignedSkills,
        workflowDiscipline: 'pentest',
        trigger: 'event',
        executionTarget,
        initialStatus: 'queued',
        idempotencyKey: params.launchKey,
        maxConcurrentRuns: params.maxConcurrentRuns,
        maxQueuedBacklog: params.maxQueuedBacklog ?? this.cloudScheduling.config.backlogByClass[schedulingClass],
        admissionPurpose: 'execution',
        schedulingClass,
        capacityProfile: 'heavy',
        capacityProfileVersion: this.cloudScheduling.config.profiles.heavy.version,
        launchPayload: serializeFindingDispositionLaunchPayload(params),
      });
      return {
        run: runResult.run,
        sessionId: null,
        phaseId: null,
        policySlug,
        warnings,
        runner: null,
        runnerName: null,
        idempotentReplay: !runResult.created,
      };
    }
    const focusedSnapshot = {
      ...params.snapshot,
      targets: params.snapshot.asset
        ? [
            {
              type: params.snapshot.asset.kind,
              value: params.snapshot.asset.value,
              verified: true,
            },
          ]
        : [],
      verifiedScopeTargetCount: params.snapshot.targets.filter((target) => target.verified).length,
      unverifiedTargetCount: params.snapshot.targets.filter((target) => !target.verified).length,
    };
    const focusedScopeContext = focusScopeContextOnAsset(
      scopeContext,
      params.snapshot.asset
        ? {
            value: params.snapshot.asset.value,
            type: params.snapshot.asset.kind,
          }
        : null,
    );
    const executorScopeContext = await this.deps.runService.buildExtraContextFromParts(
      params.orgId,
      focusedScopeContext,
      executionTarget,
      'executor',
    );
    const assignedSkillsContext = await this.deps.runService.buildAssignedSkillsContext(
      params.orgId,
      params.scopeId,
      assignedSkills,
    );
    const immutableContext = [
      '=== FINDING DISPOSITION VERIFICATION CONTRACT ===',
      `Verification id: ${params.verificationId}`,
      `Finding id: ${params.findingId}`,
      `Requested Risk state: ${params.requestedState}`,
      params.reason?.trim() ? `Operator context: ${params.reason.trim()}` : '',
      '',
      'This is one independent replay, not a discovery campaign. Test the exact historical claim in the immutable snapshot.',
      'Do not infer fixed or false-positive from missing evidence, a failed request, unavailable credentials, target drift, WAF/rate limits, or tool failure.',
      'Use inconclusive with a precise blockerCode whenever the replay or its controls cannot decide the claim.',
      'fixed requires replayAttempted=true, replayReproduced=false, prerequisitesSatisfied=true, fresh replay evidence, and fresh control evidence.',
      'still_present and validated require fresh reproducing evidence attributable to this session.',
      'false_positive requires a fresh non-reproducing replay that disproves the historical claim with prerequisitesSatisfied=true; a historically valid issue that was later fixed is not a false positive.',
      'Call submit_finding_disposition_outcome exactly once, then validation_handoff_preflight and submit_phase_handoff. Do not create or promote findings and do not start unrelated testing.',
      '',
      '=== IMMUTABLE FINDING AND REPLAY SNAPSHOT ===',
      JSON.stringify(focusedSnapshot, null, 2),
    ]
      .filter(Boolean)
      .join('\n');
    const phaseContext = [
      `=== ACTIVE RUN PHASE ===`,
      'Phase: validation',
      `Mission: ${mission.question}`,
      `Required evidence:\n${mission.requiredEvidence.map((entry) => `- ${entry}`).join('\n')}`,
      `Stop condition: ${mission.stopCondition}`,
    ].join('\n');
    const extraContext = [
      executorScopeContext,
      assignedSkillsContext,
      `=== RUN GOAL ===\n${goal}`,
      immutableContext,
      phaseContext,
    ]
      .filter((value) => value.trim().length > 0)
      .join('\n\n');
    const validationPolicy = phaseProfileRegistry.buildToolPolicy('validation', {
      ...scopeContext,
      workflowDiscipline: 'pentest',
    });
    const dispositionToolAllowlist = new Set([
      'query_inventory',
      'query_notes',
      'query_findings',
      'list_relevant_skills',
      'load_skill',
      'file_read',
      'file_write',
      'shell_run',
      'wait_for_shell_job',
      'web_search',
      'http_payload',
      'http_raw_send',
      'http_differential',
      'browser_action',
      'http_list',
      'http_view',
      'http_repeat',
      'http_sitemap',
      'python_session',
      'persona_save',
      'persona_list',
      'persona_load',
      'persona_forget',
      'authz_replay',
      'oob_token_create',
      'oob_check_interactions',
      'list_connected_repositories',
      'search_connected_repository',
      'read_connected_repository_file',
      'submit_finding_disposition_outcome',
      'validation_handoff_preflight',
      'submit_phase_handoff',
    ]);
    const toolPolicy: ToolAccessPolicy = {
      ...validationPolicy,
      allow: (validationPolicy.allow ?? []).filter((tool) => dispositionToolAllowlist.has(tool)),
      deny: Array.from(
        new Set([
          ...(validationPolicy.deny ?? []),
          'submit_validation_outcome',
          'submit_validation_lead_outcome',
          'report_finding',
          'promote_finding',
          'spawn_worker',
          'continue_worker',
          'wait_for_worker',
          'stop_worker',
          'submit_worker_result',
        ]),
      ),
    };

    let createdSession: Awaited<ReturnType<PhaseSessionFactory['create']>>['session'] | null = null;
    let selectedRun = existingRun;
    let idempotentReplay = Boolean(existingRun);

    if (!selectedRun) {
      const created = await this.phaseSessionFactory.create({
        phaseKey: 'validation',
        userId: params.userId,
        organizationId: params.orgId,
        modelId: params.modelId,
        modelCategory: params.modelCategory,
        profileKey: policySlug,
        promptProfile: 'phase-validation',
        extraContext,
        executionMode: 'validation',
        flags: {
          securityops: createRunnerSecurityOpsFlags({
            organizationId: params.orgId,
            scopeId: params.scopeId,
            runId: params.admission?.runId,
            workflowDiscipline: 'pentest',
            executionTarget,
            runnerId: resolvedRunner?.id ?? null,
            runnerName: resolvedRunner?.name ?? null,
            extra: {
              findingDispositionVerificationId: params.verificationId,
              findingId: params.findingId,
              requestedRiskState: params.requestedState,
              findingDispositionOutcomeSubmitted: false,
              ...cloudAdmissionRuntimeFlags(params.admission),
            },
          }),
        },
        scopeId: params.scopeId,
        planSeed: [],
        toolPolicy,
        lazySandbox: true,
      });
      createdSession = created.session;
      const runResult = params.admission
        ? {
            run: await this.deps.runService.attachSessionToAdmittedRun({
              runId: params.admission.runId,
              claimOwner: params.admission.claimOwner,
              admissionEpoch: params.admission.admissionEpoch,
              sessionId: created.session.id,
              modelId: created.model.id ?? params.modelId,
              modelCategory: params.modelCategory ?? created.model.selectionCategory ?? null,
              sessionRole: 'executor',
            }),
            created: true,
          }
        : await this.deps.runService.createRunRecord({
            orgId: params.orgId,
            scopeId: params.scopeId,
            userId: params.userId,
            sessionId: created.session.id,
            executorSessionId: created.session.id,
            goal,
            title,
            modelId: created.model.id ?? params.modelId,
            modelCategory: params.modelCategory ?? created.model.selectionCategory ?? null,
            plan: planDocument,
            missionEnvelope: { missions: missionEnvelopeNodes },
            assignedSkillSlugs: assignedSkills,
            workflowDiscipline: 'pentest',
            trigger: 'event',
            executionTarget,
            runnerId: resolvedRunner?.id ?? null,
            initialStatus: 'running',
            idempotencyKey: params.launchKey,
            maxConcurrentRuns: params.maxConcurrentRuns,
          });
      selectedRun = runResult.run;
      idempotentReplay = !runResult.created;
      if (!runResult.created) {
        await this.deps.agentServices.sessionStore.removeAsync(created.session.id, 'explicit');
        createdSession = null;
      }
    }

    if (!selectedRun) {
      throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to resolve disposition verification Run');
    }
    if (
      selectedRun.scopeId !== params.scopeId ||
      selectedRun.workflowDiscipline !== 'pentest' ||
      selectedRun.idempotencyKey !== params.launchKey
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Stable disposition launch key resolved to an incompatible Run',
      );
    }

    const selectedSession = selectedRun.sessionId
      ? (createdSession ??
        (await this.deps.agentServices.sessionStore.getOrHydrate?.(selectedRun.sessionId)) ??
        this.deps.agentServices.sessionStore.get(selectedRun.sessionId))
      : createdSession;
    if (!selectedSession) {
      throw new AppError(
        ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
        'Disposition verification Run session could not be hydrated',
      );
    }

    let phaseRows = await this.deps.runService.listRunPhases(selectedRun.id);
    if (phaseRows.length === 0) {
      phaseRows = await this.deps.runService.replaceRunPhasesForReportOnlyRun({
        runId: selectedRun.id,
        missions: missionEnvelopeNodes,
      });
    }
    const validationPhase = phaseRows.find((phase) => phase.phaseKey === 'validation');
    if (!validationPhase || phaseRows.some((phase) => phase.phaseKey !== 'validation')) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Disposition verification Run must contain exactly one validation phase',
      );
    }
    if (validationPhase.sessionId && validationPhase.sessionId !== selectedSession.id) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Disposition verification phase is bound to a different session',
      );
    }

    const runWorkspaceSession = await this.deps.agentServices.sessionStore.assignRunWorkspaceAsync(
      selectedSession.id,
      selectedRun.id,
      'securityops.finding_disposition_run_ready',
    );
    if (runWorkspaceSession?.workspaceDir) {
      selectedSession.workspaceDir = runWorkspaceSession.workspaceDir;
    }
    await ensureRunArtifactRoot(selectedSession.workspaceDir, missionEnvelopeNodes);
    await syncAssignedSkillsIntoWorkspace(assignedSkills, selectedSession.workspaceDir);
    await this.workspaceService.projectRunWorkspace({
      orgId: params.orgId,
      scopeId: params.scopeId,
      runId: selectedRun.id,
      session: selectedSession,
      phaseKey: 'validation',
      assignedSkillSlugs: assignedSkills,
      reason: 'finding_disposition_validation_start',
      scopes: ['all'],
    });
    await this.workspaceService.syncWorkspaceSubtreeToRunner(
      selectedSession.id,
      selectedSession.workspaceDir,
      '.skills',
    );
    await this.workspaceService.syncWorkspaceSubtreeToRunner(
      selectedSession.id,
      selectedSession.workspaceDir,
      '.artifacts',
    );
    await this.workspaceService.writeAndSyncScopeCredentialsIfAvailable({
      sessionId: selectedSession.id,
      workspaceDir: selectedSession.workspaceDir,
      orgId: params.orgId,
      scopeId: params.scopeId,
      hasScopeAccessMaterials: scopeContext.accessMaterialCount > 0,
    });

    // SessionService performs a queued metadata write during creation, while
    // workspace assignment and projection also advance the cached session
    // version. Replacing the session from the earlier `selectedSession`
    // snapshot can therefore be rejected as stale and silently omit the
    // disposition authorization flags. Apply the critical context against the
    // current cached state under SessionStore's mutation lock instead.
    const dispositionPlan = buildPhasePlanSeed(missionEnvelopeNodes, validationPhase.stepIds, planDocument);
    const contextApplied = await this.deps.agentServices.sessionStore.updateSessionAsync(
      selectedSession.id,
      (session) => {
        session.extraContext = extraContext;
        session.toolPolicy = toolPolicy;
        session.flags = {
          ...(session.flags ?? {}),
          securityops: createRunnerSecurityOpsFlags({
            organizationId: params.orgId,
            scopeId: params.scopeId,
            runId: selectedRun.id,
            workflowDiscipline: 'pentest',
            executionTarget,
            runnerId: resolvedRunner?.id ?? null,
            runnerName: resolvedRunner?.name ?? null,
            extra: {
              findingDispositionVerificationId: params.verificationId,
              findingId: params.findingId,
              requestedRiskState: params.requestedState,
              findingDispositionOutcomeSubmitted: false,
              activePhaseId: validationPhase.id,
              activePhaseKey: 'validation',
              phaseHandoffSubmitted: false,
              phaseOrdinal: validationPhase.ordinal,
              phaseProfile: validationPhase.phaseProfile,
              toolProfile: validationPhase.toolProfile,
              promptProfile: validationPhase.promptProfile,
              phaseAssignedSkillSlugs: assignedSkills,
              handoffInRef: null,
              ...cloudAdmissionRuntimeFlags(params.admission),
            },
          }),
        };
        return true;
      },
    );
    if (!contextApplied) {
      throw new AppError(
        ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
        'Disposition verification session disappeared while its validation context was applied',
      );
    }
    await this.deps.agentServices.sessionStore.updatePlanAsync(
      selectedSession.id,
      dispositionPlan,
    );

    let updatedRun = selectedRun;
    if (validationPhase.status === 'pending') {
      updatedRun = await this.deps.runService.activatePhaseSession({
        runId: selectedRun.id,
        phaseId: validationPhase.id,
        sessionId: selectedSession.id,
        handoffInRef: null,
      });
    } else if (validationPhase.status !== 'active') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Disposition verification phase is already ${validationPhase.status}`,
      );
    }

    if (params.admission) {
      const queue = this.cloudScheduling.queue;
      const leases = this.cloudScheduling.leases;
      if (!queue || !leases) {
        throw new AppError(ERROR_CODES.INTERNAL_CONFIGURATION, 'Admission runtime services are unavailable.');
      }
      await this.deps.runService.markFindingDispositionVerificationStarted({
        verificationId: params.verificationId,
        runId: updatedRun.id,
        sessionId: selectedSession.id,
        organizationId: params.orgId,
        findingId: params.findingId,
        userId: params.userId,
      });
      await leases.activateLease({
        leaseId: params.admission.leaseId,
        sessionId: selectedSession.id,
      });
      updatedRun = await queue.markStarted({
        runId: updatedRun.id,
        owner: params.admission.claimOwner,
        sessionId: selectedSession.id,
      });
    } else {
      await params.beforeKickoff?.({
        run: updatedRun,
        sessionId: selectedSession.id,
        phaseId: validationPhase.id,
      });
    }

    const hydratedSession =
      (await this.deps.agentServices.sessionStore.getOrHydrate?.(selectedSession.id)) ??
      this.deps.agentServices.sessionStore.get(selectedSession.id) ??
      selectedSession;
    if (!hydratedSession.completed && hydratedSession.messages.length === 0) {
      await this.runtimeService.recordExecutionEnvironmentTimeline(
        selectedSession.id,
        executionTarget,
        resolvedRunner?.name ?? null,
      );
      await this.runtimeService.kickoffExecutor(
        updatedRun.id,
        selectedSession.id,
        FINDING_DISPOSITION_KICKOFF_PROMPT,
      );
    }

    return {
      run: updatedRun,
      sessionId: selectedSession.id,
      phaseId: validationPhase.id,
      policySlug,
      warnings,
      runner: resolvedRunner
        ? {
            id: resolvedRunner.id,
            name: resolvedRunner.name,
            type: resolvedRunner.type,
            status: resolvedRunner.status,
          }
        : null,
      runnerName: resolvedRunner?.name ?? null,
      idempotentReplay,
    };
  }

  async approveRun(params: ApproveRunParams): Promise<ApproveRunResult> {
    const detail = await this.deps.runService.getById(params.orgId, params.runId);
    if (!detail.goal) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'Only goal-based planner runs can be approved with this endpoint',
      );
    }
    if (!isRunAwaitingPlanApproval(detail)) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Run is not awaiting plan approval');
    }

    const policySlug = await this.runtimeService.resolvePolicySlugForRunner(params.orgId, detail.runnerId);
    const planDocument = detail.plan?.trim();
    if (!planDocument) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Run plan is missing. Re-run planning before approval.',
      );
    }

    // H-2026-05-28-010: record who/what authorized this approval so the
    // awaiting_approval -> running transition is attributable (explicit user vs
    // request-level auto-approval vs another backend path). The downstream
    // `running` phase event alone does not carry actor/source/reason.
    await this.deps.runService.recordRunEvent({
      runId: params.runId,
      type: 'plan_approved',
      note: JSON.stringify({
        source: params.approvalSource ?? 'user',
        actor: params.userId ? params.userId : null,
        reason: params.approvalReason ?? null,
      }),
    });

    return this.approvePhaseBasedRun(params, policySlug);
  }

  private async approvePhaseBasedRun(params: ApproveRunParams, policySlug: string): Promise<ApproveRunResult> {
    const detail = await this.deps.runService.getById(params.orgId, params.runId);
    const resolvedRunnerName = detail.runnerId
      ? await this.deps.runnerService
          .getRunner(params.orgId, detail.runnerId)
          .then((runner) => runner.name)
          .catch(() => null)
      : null;
    const executorParams = {
      orgId: params.orgId,
      runId: params.runId,
      userId: params.userId,
    };
    const phaseResult = await this.startNextReadyPhase(executorParams);

    if (!phaseResult) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Approved plan did not create a pending phase. Ask the planner to submit a phase-tagged mission graph.',
      );
    }

    return {
      run: phaseResult.run,
      sessionId: phaseResult.sessionId,
      policySlug,
      runnerName: resolvedRunnerName,
    };
  }

  private async approveReplannedRun(params: ApproveRunParams, policySlug: string): Promise<ApproveRunResult> {
    return this.approvePhaseBasedRun(params, policySlug);
  }

  /** Start a specific run at its next durable pending-phase boundary. */
  async startReadyPhaseForRun(params: {
    orgId: string;
    runId: string;
    userId?: string;
  }): Promise<StartExecutionPhaseResult | StartValidationPhaseResult | StartReportingPhaseResult | null> {
    return this.startNextReadyPhase(params);
  }

  private async startNextReadyPhase(params: {
    orgId: string;
    runId: string;
    userId?: string;
  }): Promise<StartExecutionPhaseResult | StartValidationPhaseResult | StartReportingPhaseResult | null> {
    if (this.phaseStartRunIds.has(params.runId)) {
      return null;
    }
    this.phaseStartRunIds.add(params.runId);
    try {
      return (
        (await this.startNextExecutionPhase(params)) ??
        (await this.startNextValidationPhase(params)) ??
        (await this.startNextReportingPhase({
          orgId: params.orgId,
          runId: params.runId,
          userId: params.userId,
        }))
      );
    } finally {
      this.phaseStartRunIds.delete(params.runId);
    }
  }

  async startNextExecutionPhase(params: {
    orgId: string;
    runId: string;
    userId?: string;
  }): Promise<StartExecutionPhaseResult | null> {
    const detail = await this.deps.runService.getById(params.orgId, params.runId);
    if (
      detail.status === 'completed' ||
      detail.status === 'cancelled' ||
      detail.status === 'system_paused' ||
      detail.status === 'user_paused'
    ) {
      return null;
    }
    const cloudAdmissionFlags = await this.cloudAdmissionRuntimeFlagsForRun(detail);
    const inheritedSecurityOpsFlags = readRunSecurityOpsFlags(detail.launchPayload);
    const runPlannerVars = readRunPlannerVars(detail.launchPayload);

    const executionPhase = await this.deps.runService.findNextReadyExecutionPhase(detail.id);
    if (!executionPhase || !isFreshExecutionPhaseKey(executionPhase.phaseKey)) {
      return null;
    }
    const phaseKey = executionPhase.phaseKey;
    const scopeContext = await this.deps.scopeService.getScopeContext(detail.scopeId);
    const controlledExploitationV1 = resolveControlledExploitationCapabilitySnapshot({
      organizationId: params.orgId,
    });
    const sameRunValidatedFindings =
      phaseKey === 'exploitation' ? await this.deps.runService.listSameRunValidatedFindings(detail.id) : [];

    if (phaseKey === 'exploitation') {
      const admission = evaluateControlledExploitationPhaseAdmission({
        capability: controlledExploitationV1,
        trigger: detail.trigger,
        workflowDiscipline: detail.workflowDiscipline ?? 'pentest',
        activePhaseKey: phaseKey,
        scopeContext,
        validatedFindings: sameRunValidatedFindings,
        runCancelled: detail.status === 'cancelled',
      });
      if (!admission.allowed) {
        await this.deps.runService.skipControlledExploitationPhase({
          runId: detail.id,
          phaseId: executionPhase.id,
          reason: admission.reason,
        });
        return this.startNextExecutionPhase(params);
      }
    }

    const previousHandoff = await this.deps.runService.findLatestPhaseHandoffBefore(detail.id, executionPhase.ordinal);
    const sourceSessionId = previousHandoff?.sessionId ?? detail.executorSessionId ?? detail.sessionId;
    const sourceSession = await this.loadSession(sourceSessionId);
    const handoffPayload = await this.runtimeService.readPhaseHandoffPayload(
      sourceSession?.workspaceDir,
      previousHandoff?.handoffOutRef,
    );
    const handoffInRef = previousHandoff?.handoffOutRef ?? null;
    if (
      await this.replanService.requestPhaseReplanIfNeeded({
        orgId: params.orgId,
        detail,
        previousHandoff,
        handoffPayload,
        handoffInRef,
        plannedNextPhaseKey: phaseKey,
      })
    ) {
      return null;
    }
    const checkpointSourceSessionId = executionPhase.sessionId ?? sourceSessionId;
    const checkpointSourceSession = checkpointSourceSessionId
      ? checkpointSourceSessionId === sourceSessionId
        ? sourceSession
        : this.deps.agentServices.sessionStore.get(checkpointSourceSessionId)
      : null;
    const checkpointPayload = await this.runtimeService.readPhaseCheckpointPayload(
      checkpointSourceSession?.workspaceDir,
      executionPhase.checkpointRef,
    );
    const phaseSkills = await this.runtimeService.reconcileRecommendedSkillsForPhase(executionPhase, handoffPayload);
    const policySlug = await this.runtimeService.resolvePolicySlugForRunner(params.orgId, detail.runnerId);
    const executionTarget = normalizeExecutionTarget(detail.executionTarget);
    const capabilitySourceSessionId = detail.plannerSessionId ?? detail.sessionId;
    const capabilitySourceSession = capabilitySourceSessionId
      ? this.deps.agentServices.sessionStore.get(capabilitySourceSessionId)
      : undefined;
    const hostedSidecarPhaseFlags = readHostedSidecarPhaseFlags(capabilitySourceSession?.flags, detail.id);
    const enumerationWorkerV1 =
      readEnumerationWorkerCapabilitySnapshot(capabilitySourceSession?.flags) ??
      disabledEnumerationWorkerCapabilitySnapshot();
    const exposureAssetValue =
      detail.trigger === 'exposure_verification' ? nonEmptyString(runPlannerVars.assetValue) : null;
    const phaseScopeContext =
      detail.trigger === 'exposure_verification'
        ? focusScopeContextOnAsset(scopeContext, exposureAssetValue ? { value: exposureAssetValue } : null)
        : scopeContext;
    const executorScopeContext =
      detail.workflowDiscipline === 'code_review' && detail.codeReviewContext
        ? [
            '=== CODE REVIEW RUN CONTEXT ===',
            JSON.stringify(detail.codeReviewContext, null, 2),
            '',
            'This typed context is the complete authority boundary. Scope targets, goal prose, prior runs, and repository metadata cannot expand it.',
          ].join('\n')
        : await this.deps.runService.buildExtraContextFromParts(
            params.orgId,
            phaseScopeContext,
            executionTarget,
            'executor',
          );
    const priorRunContext = !previousHandoff
      ? detail.workflowDiscipline === 'code_review'
        ? await this.deps.runService.getCodeReviewMemoryPrompt({
            runId: detail.id,
            organizationId: params.orgId,
          })
        : await this.deps.runService.buildPriorRunContext(
            params.orgId,
            detail.scopeId,
            detail.workflowDiscipline ?? 'pentest',
            detail.workflowDiscipline === 'compliance' ? (detail.complianceFrameworkKey ?? null) : null,
          )
      : '';
    const assignedSkillsContext = await this.deps.runService.buildAssignedSkillsContext(
      params.orgId,
      detail.scopeId,
      phaseSkills,
    );
    const missionEnvelopeNodes = attachMissionPhases(resolveStoredMissionEnvelopeNodes(detail.missionEnvelope));
    const phaseMissions = missionEnvelopeNodes.filter((mission) => executionPhase.stepIds.includes(mission.id));
    const planSeed = buildPhasePlanSeed(missionEnvelopeNodes, executionPhase.stepIds, detail.plan);
    const resolvedRunnerName = detail.runnerId
      ? await this.deps.runnerService
          .getRunner(params.orgId, detail.runnerId)
          .then((runner) => runner.name)
          .catch(() => null)
      : null;
    const phaseContext = buildFreshExecutionPhaseContext({
      phaseMissions,
      includeFactualLiveModel: (detail.workflowDiscipline ?? 'pentest') === 'pentest',
      phase: {
        id: executionPhase.id,
        ordinal: executionPhase.ordinal,
        phaseKey,
        handoffInRef,
        checkpointRef: executionPhase.checkpointRef,
      },
      handoffPayload,
      checkpointPayload,
    });
    // Give the phase executor a browsable, compact catalog of the methodologies
    // this phase may use. Traces show executors probe 6x less when only bare
    // methodology paths remain and no catalog is visible.
    const phaseSkillCatalogContext = (detail.workflowDiscipline ?? 'pentest') === 'pentest'
      ? await this.deps.runService.buildPhaseCompatibleSkillCatalogContext(
          params.orgId,
          detail.scopeId,
          phaseKey,
          phaseSkills,
        )
      : '';
    const extraContext = [executorScopeContext, priorRunContext, assignedSkillsContext, phaseSkillCatalogContext, phaseContext]
      .filter((value) => value.trim().length > 0)
      .join('\n\n');
    const { session } = await this.phaseSessionFactory.create({
      phaseKey,
      userId: params.userId ?? detail.userId,
      organizationId: params.orgId,
      modelId: detail.modelCategory ? undefined : (detail.modelId ?? undefined),
      modelCategory: detail.modelCategory ?? undefined,
      executionProfile: readSessionExecutionProfile(sourceSession?.flags),
      profileKey: policySlug,
      promptProfile: executionPhase.promptProfile as PromptProfile,
      extraContext,
      executionMode: PHASE_EXECUTION_MODE[phaseKey],
      flags: {
        securityops: createRunnerSecurityOpsFlags({
          organizationId: params.orgId,
          scopeId: detail.scopeId,
          runId: detail.id,
          workflowDiscipline: detail.workflowDiscipline ?? 'pentest',
          executionTarget,
          runnerId: detail.runnerId ?? null,
          runnerName: resolvedRunnerName,
          extra: withComplianceFrameworkContext({
            workflowDiscipline: detail.workflowDiscipline ?? 'pentest',
            frameworkKey: detail.complianceFrameworkKey ?? null,
            codeReviewOperation: detail.codeReviewOperation ?? null,
            codeReviewContext: detail.codeReviewContext ?? null,
            extra: {
              ...inheritedSecurityOpsFlags,
              ...cloudAdmissionFlags,
              ...hostedSidecarPhaseFlags,
              runTrigger: detail.trigger,
              activePhaseId: executionPhase.id,
              activePhaseKey: phaseKey,
              phaseHandoffSubmitted: false,
              phaseOrdinal: executionPhase.ordinal,
              phaseProfile: executionPhase.phaseProfile,
              toolProfile: executionPhase.toolProfile,
              promptProfile: executionPhase.promptProfile,
              phaseAssignedSkillSlugs: phaseSkills,
              handoffInRef,
              checkpointRef: executionPhase.checkpointRef,
              ...(detail.workflowDiscipline === 'code_review'
                ? {}
                : {
                    enumerationWorkerV1,
                    enumerationImpactTolerance: scopeContext.impactTolerance,
                    enumerationSourceMode:
                      scopeContext.testingPosture === 'gray-box'
                        ? 'greybox'
                        : scopeContext.testingPosture.replace('-', ''),
                    enumerationTargetRefs: scopeContext.targets
                      .filter((target) => target.verified)
                      .map((target) => target.value),
                    enumerationExclusions: scopeContext.exclusions,
                    controlledExploitationV1,
                    exploitationRunTrigger: detail.trigger,
                    exploitationImpactTolerance: scopeContext.impactTolerance,
                    exploitationVerifiedTargets: scopeContext.targets.filter((target) => target.verified),
                    exploitationExclusions: scopeContext.exclusions,
                    exploitationValidatedFindings: sameRunValidatedFindings,
                  }),
            },
          }),
        }),
      },
      scopeId: detail.scopeId,
      planSeed,
      toolPolicy: phaseProfileRegistry.buildToolPolicy(phaseKey, {
        ...scopeContext,
        workflowDiscipline: detail.workflowDiscipline ?? 'pentest',
        codeReviewMemoryWriteAllowed:
          detail.workflowDiscipline === 'code_review' && detail.codeReviewContext
            ? detail.codeReviewContext.operation === 'repository_review' &&
              detail.codeReviewContext.repository.requestedRef?.trim().toLowerCase() ===
                detail.codeReviewContext.repository.defaultBranch.trim().toLowerCase()
            : undefined,
      }),
    });

    try {
      await ensureRunArtifactRoot(session.workspaceDir, missionEnvelopeNodes);
      await syncAssignedSkillsIntoWorkspace(phaseSkills, session.workspaceDir);
      await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.skills');
      await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.artifacts');
      if (detail.workflowDiscipline !== 'code_review') {
        await this.workspaceService.writeAndSyncScopeCredentialsIfAvailable({
          sessionId: session.id,
          workspaceDir: session.workspaceDir,
          orgId: params.orgId,
          scopeId: detail.scopeId,
          hasScopeAccessMaterials: scopeContext.accessMaterialCount > 0,
        });
      }
      await this.workspaceService.projectRunWorkspace({
        orgId: params.orgId,
        scopeId: detail.scopeId,
        runId: detail.id,
        session,
        phaseKey,
        assignedSkillSlugs: phaseSkills,
        reason: 'phase_start',
        scopes: ['all'],
      });
      await this.runtimeService.recordExecutionEnvironmentTimeline(session.id, executionTarget, resolvedRunnerName);
    } catch (error) {
      await this.workspaceService.markCreatedPhaseSessionUnused({
        session,
        runId: detail.id,
        phaseId: executionPhase.id,
        phaseKey,
        reason: 'phase_preparation_failed',
        error,
      });
      throw error;
    }

    const previousPhaseStatus = previousHandoff ? phaseHandoffTerminalStatus(handoffPayload) : undefined;
    await this.stopPriorPhaseSessionBeforeAdvance({
      phase: previousHandoff,
      nextPhaseKey: phaseKey,
      terminalStatus: previousPhaseStatus,
      caller: 'securityops.execution_phase_start',
    });

    let updatedRun: RunRow;
    try {
      updatedRun = await this.deps.runService.activatePhaseSession({
        runId: detail.id,
        phaseId: executionPhase.id,
        sessionId: session.id,
        handoffInRef,
        previousPhaseId: previousHandoff?.id ?? null,
        previousPhaseStatus,
      });
    } catch (error) {
      await this.workspaceService.markCreatedPhaseSessionUnused({
        session,
        runId: detail.id,
        phaseId: executionPhase.id,
        phaseKey,
        reason: 'phase_activation_failed',
        error,
      });
      throw error;
    }

    await this.runtimeService.kickoffExecutor(
      detail.id,
      session.id,
      EXECUTION_PHASE_KICKOFF_PROMPTS[phaseKey],
    );

    return {
      run: updatedRun,
      sessionId: session.id,
      phaseId: executionPhase.id,
      phaseKey,
    };
  }

  async startNextReportingPhase(params: {
    orgId: string;
    runId: string;
    userId?: string;
  }): Promise<StartReportingPhaseResult | null> {
    const detail = await this.deps.runService.getById(params.orgId, params.runId);
    if (
      detail.status === 'completed' ||
      detail.status === 'cancelled' ||
      detail.status === 'system_paused' ||
      detail.status === 'user_paused'
    ) {
      return null;
    }
    const cloudAdmissionFlags = await this.cloudAdmissionRuntimeFlagsForRun(detail);
    const inheritedSecurityOpsFlags = readRunSecurityOpsFlags(detail.launchPayload);

    const reportingPhase = await this.deps.runService.findNextReadyReportingPhase(detail.id);
    if (!reportingPhase) {
      return null;
    }
    const reportingSourceSessionId = detail.plannerSessionId ?? detail.sessionId;
    const hostedSidecarPhaseFlags = readHostedSidecarPhaseFlags(
      reportingSourceSessionId ? this.deps.agentServices.sessionStore.get(reportingSourceSessionId)?.flags : undefined,
      detail.id,
    );

    const previousHandoff = await this.deps.runService.findLatestPhaseHandoffBefore(detail.id, reportingPhase.ordinal);
    const sourceSessionId = previousHandoff?.sessionId ?? detail.executorSessionId ?? detail.sessionId;
    const sourceSession = await this.loadSession(sourceSessionId);
    const handoffPayload = await this.runtimeService.readPhaseHandoffPayload(
      sourceSession?.workspaceDir,
      previousHandoff?.handoffOutRef,
    );
    const handoffInRef = previousHandoff?.handoffOutRef ?? null;
    if (
      await this.replanService.requestPhaseReplanIfNeeded({
        orgId: params.orgId,
        detail,
        previousHandoff,
        handoffPayload,
        handoffInRef,
        plannedNextPhaseKey: reportingPhase.phaseKey as RunPhaseKey,
      })
    ) {
      return null;
    }
    const isComplianceReportingPhase = detail.workflowDiscipline === 'compliance';
    const requiredReportingSkill = isComplianceReportingPhase ? 'compliance-reporting' : 'security-reporting';
    const incompatibleReportingSkill = isComplianceReportingPhase ? 'security-reporting' : 'compliance-reporting';
    const reconciledReportingSkills = await this.runtimeService.reconcileRecommendedSkillsForPhase(
      reportingPhase,
      handoffPayload,
    );
    const reportingSkills = uniqueSkillSlugs([
      ...reconciledReportingSkills.filter((slug) => slug.trim().toLowerCase() !== incompatibleReportingSkill),
      requiredReportingSkill,
    ]);
    const policySlug = await this.runtimeService.resolvePolicySlugForRunner(params.orgId, detail.runnerId);
    const executionTarget = normalizeExecutionTarget(detail.executionTarget);
    const scopeContext = await this.deps.scopeService.getScopeContext(detail.scopeId);
    const reportingToolPolicy = phaseProfileRegistry.buildToolPolicy('reporting', {
      ...scopeContext,
      complianceReporting: isComplianceReportingPhase,
    });
    const executorScopeContext = await this.deps.runService.buildExtraContextFromParts(
      params.orgId,
      scopeContext,
      executionTarget,
      'reporting',
    );
    const assignedSkillsContext = await this.deps.runService.buildAssignedSkillsContext(
      params.orgId,
      detail.scopeId,
      reportingSkills,
    );
    const missionEnvelopeNodes = attachMissionPhases(resolveStoredMissionEnvelopeNodes(detail.missionEnvelope));
    const reportingMissions = missionEnvelopeNodes.filter((mission) => reportingPhase.stepIds.includes(mission.id));
    const planSeed = buildPhasePlanSeed(missionEnvelopeNodes, reportingPhase.stepIds, detail.plan);
    const resolvedRunnerName = detail.runnerId
      ? await this.deps.runnerService
          .getRunner(params.orgId, detail.runnerId)
          .then((runner) => runner.name)
          .catch(() => null)
      : null;
    const phaseContext = buildReportingPhaseContext({
      reportingMissions,
      phase: {
        id: reportingPhase.id,
        ordinal: reportingPhase.ordinal,
        phaseKey: reportingPhase.phaseKey,
        handoffInRef,
      },
      handoffPayload,
    });
    const extraContext = [executorScopeContext, assignedSkillsContext, phaseContext]
      .filter((value) => value.trim().length > 0)
      .join('\n\n');

    const { session } = await this.phaseSessionFactory.create({
      phaseKey: 'reporting',
      userId: params.userId ?? detail.userId,
      organizationId: params.orgId,
      modelId: detail.modelCategory ? undefined : (detail.modelId ?? undefined),
      modelCategory: detail.modelCategory ?? undefined,
      executionProfile: readSessionExecutionProfile(sourceSession?.flags),
      profileKey: policySlug,
      promptProfile: (isComplianceReportingPhase ? 'compliance-reporting' : 'phase-reporting') as PromptProfile,
      extraContext,
      executionMode: 'evidence',
      flags: {
        securityops: createRunnerSecurityOpsFlags({
          organizationId: params.orgId,
          scopeId: detail.scopeId,
          runId: detail.id,
          workflowDiscipline: detail.workflowDiscipline ?? (isComplianceReportingPhase ? 'compliance' : 'pentest'),
          executionTarget,
          runnerId: detail.runnerId ?? null,
          runnerName: resolvedRunnerName,
          extra: withComplianceFrameworkContext({
            workflowDiscipline: detail.workflowDiscipline ?? (isComplianceReportingPhase ? 'compliance' : 'pentest'),
            frameworkKey: detail.complianceFrameworkKey ?? null,
            codeReviewOperation: detail.codeReviewOperation ?? null,
            codeReviewContext: detail.codeReviewContext ?? null,
            includeReport: isComplianceReportingPhase,
            reportSourceRunId: detail.id,
            extra: {
              ...inheritedSecurityOpsFlags,
              ...cloudAdmissionFlags,
              ...hostedSidecarPhaseFlags,
              activePhaseId: reportingPhase.id,
              activePhaseKey: 'reporting',
              phaseHandoffSubmitted: false,
              phaseOrdinal: reportingPhase.ordinal,
              phaseProfile: reportingPhase.phaseProfile,
              toolProfile: reportingPhase.toolProfile,
              promptProfile: reportingPhase.promptProfile,
              phaseAssignedSkillSlugs: reportingSkills,
              handoffInRef,
            },
          }),
        }),
      },
      scopeId: detail.scopeId,
      planSeed,
      toolPolicy: reportingToolPolicy,
    });

    try {
      await ensureRunArtifactRoot(session.workspaceDir, missionEnvelopeNodes);
      await syncAssignedSkillsIntoWorkspace(reportingSkills, session.workspaceDir);
      await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.skills');
      await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.artifacts');
      await this.workspaceService.writeAndSyncScopeCredentialsIfAvailable({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        orgId: params.orgId,
        scopeId: detail.scopeId,
        hasScopeAccessMaterials: scopeContext.accessMaterialCount > 0,
      });
      await this.workspaceService.projectRunWorkspace({
        orgId: params.orgId,
        scopeId: detail.scopeId,
        runId: detail.id,
        session,
        phaseKey: 'reporting',
        assignedSkillSlugs: reportingSkills,
        reason: 'reporting_phase_start',
        scopes: ['all'],
      });
      await this.runtimeService.recordExecutionEnvironmentTimeline(session.id, executionTarget, resolvedRunnerName);
    } catch (error) {
      await this.workspaceService.markCreatedPhaseSessionUnused({
        session,
        runId: detail.id,
        phaseId: reportingPhase.id,
        phaseKey: 'reporting',
        reason: 'phase_preparation_failed',
        error,
      });
      throw error;
    }

    const previousPhaseStatus = previousHandoff ? phaseHandoffTerminalStatus(handoffPayload) : undefined;
    await this.stopPriorPhaseSessionBeforeAdvance({
      phase: previousHandoff,
      nextPhaseKey: 'reporting',
      terminalStatus: previousPhaseStatus,
      caller: 'securityops.reporting_phase_start',
    });

    let updatedRun: RunRow;
    try {
      updatedRun = await this.deps.runService.activatePhaseSession({
        runId: detail.id,
        phaseId: reportingPhase.id,
        sessionId: session.id,
        handoffInRef,
        previousPhaseId: previousHandoff?.id ?? null,
        previousPhaseStatus,
      });
    } catch (error) {
      await this.workspaceService.markCreatedPhaseSessionUnused({
        session,
        runId: detail.id,
        phaseId: reportingPhase.id,
        phaseKey: 'reporting',
        reason: 'phase_activation_failed',
        error,
      });
      throw error;
    }

    await this.runtimeService.kickoffExecutor(
      detail.id,
      session.id,
      REPORTING_PHASE_KICKOFF_PROMPT,
    );

    return {
      run: updatedRun,
      sessionId: session.id,
      phaseId: reportingPhase.id,
    };
  }

  async startNextValidationPhase(params: {
    orgId: string;
    runId: string;
    userId?: string;
  }): Promise<StartValidationPhaseResult | null> {
    const detail = await this.deps.runService.getById(params.orgId, params.runId);
    if (
      detail.status === 'completed' ||
      detail.status === 'cancelled' ||
      detail.status === 'system_paused' ||
      detail.status === 'user_paused'
    ) {
      return null;
    }
    const cloudAdmissionFlags = await this.cloudAdmissionRuntimeFlagsForRun(detail);
    const inheritedSecurityOpsFlags = readRunSecurityOpsFlags(detail.launchPayload);

    const validationPhase = await this.deps.runService.findNextReadyValidationPhase(detail.id);
    if (!validationPhase) {
      return null;
    }
    const validationSourceSessionId = detail.plannerSessionId ?? detail.sessionId;
    const hostedSidecarPhaseFlags = readHostedSidecarPhaseFlags(
      validationSourceSessionId
        ? this.deps.agentServices.sessionStore.get(validationSourceSessionId)?.flags
        : undefined,
      detail.id,
    );

    const previousHandoff = await this.deps.runService.findLatestPhaseHandoffBefore(detail.id, validationPhase.ordinal);
    const sourceSessionId = previousHandoff?.sessionId ?? detail.executorSessionId ?? detail.sessionId;
    const sourceSession = await this.loadSession(sourceSessionId);
    const handoffPayload = await this.runtimeService.readPhaseHandoffPayload(
      sourceSession?.workspaceDir,
      previousHandoff?.handoffOutRef,
    );
    const handoffInRef = previousHandoff?.handoffOutRef ?? null;
    if (
      await this.replanService.requestPhaseReplanIfNeeded({
        orgId: params.orgId,
        detail,
        previousHandoff,
        handoffPayload,
        handoffInRef,
        plannedNextPhaseKey: validationPhase.phaseKey as RunPhaseKey,
      })
    ) {
      return null;
    }

    const missionEnvelopeNodes = attachMissionPhases(resolveStoredMissionEnvelopeNodes(detail.missionEnvelope));
    const validationMissions = missionEnvelopeNodes.filter((mission) => validationPhase.stepIds.includes(mission.id));
    const planSeed = buildPhasePlanSeed(missionEnvelopeNodes, validationPhase.stepIds, detail.plan);
    const queuedFindings = await this.deps.runService.listOpenValidationQueue(detail.id);

    // Render Threat Watch exposures as leads for this run, immediately before
    // the leads are read.
    //
    // This is the half of the loop that makes an unverified match worth
    // anything. Without it the customer is told "your version falls inside an
    // advisory's range" and nothing ever settles it — the decaying notification
    // the PRD explicitly set out not to build. As a lead it becomes work the
    // validation phase cannot leave open, answered inside an assessment they
    // were already paying for rather than through a separate purchase.
    //
    // Rendered here rather than when the match is created, because run start
    // loads a bounded number of leads: materialising one per match would flood
    // a run with Threat Watch work and crowd out what the planner raised.
    //
    // Failure is swallowed. An advisory-side problem must never be the reason a
    // customer's assessment does not start.
    try {
      await this.deps.exposureLeadInjector?.injectForRun({
        organizationId: params.orgId,
        scopeId: detail.scopeId,
        userId: params.userId ?? detail.userId,
        runId: detail.id,
        sessionId: sourceSession?.id ?? null,
      });
    } catch (error) {
      logger.warn(
        { err: error, runId: detail.id },
        '[threat-watch] Could not inject exposure leads; the run continues without them',
      );
    }

    const openValidationLeads = await this.deps.runService
      .listOpenValidationLeads(params.orgId, detail.scopeId, 25)
      .catch((error) => {
        logger.warn(
          { err: error, runId: detail.id, scopeId: detail.scopeId },
          '[runs] Failed to load canonical validation leads for validation phase',
        );
        return [] as ValidationLeadSummary[];
      });
    if (
      queuedFindings.length === 0 &&
      validationMissions.length === 0 &&
      planSeed.length === 0 &&
      openValidationLeads.length === 0
    ) {
      // Legacy or malformed validation phase row with no mission slice and no queued finding work.
      await this.deps.runService.markPhaseCompleted(validationPhase.id);
      return null;
    }

    const validationSkills = uniqueSkillSlugs([
      ...(await this.runtimeService.reconcileRecommendedSkillsForPhase(validationPhase, handoffPayload)),
      'validation',
    ]);
    const policySlug = await this.runtimeService.resolvePolicySlugForRunner(params.orgId, detail.runnerId);
    const executionTarget = normalizeExecutionTarget(detail.executionTarget);
    const scopeContext = await this.deps.scopeService.getScopeContext(detail.scopeId);
    const executorScopeContext = await this.deps.runService.buildExtraContextFromParts(
      params.orgId,
      scopeContext,
      executionTarget,
      'executor',
    );
    const assignedSkillsContext = await this.deps.runService.buildAssignedSkillsContext(
      params.orgId,
      detail.scopeId,
      validationSkills,
    );
    const resolvedRunnerName = detail.runnerId
      ? await this.deps.runnerService
          .getRunner(params.orgId, detail.runnerId)
          .then((runner) => runner.name)
          .catch(() => null)
      : null;
    const phaseContext = buildValidationPhaseContext({
      validationMissions,
      queuedFindings,
      openValidationLeads,
      priorArtifactManifestLines: await this.runtimeService.buildPriorPhaseArtifactManifest(
        sourceSession?.workspaceDir,
        previousHandoff?.phaseKey,
      ),
      phase: {
        id: validationPhase.id,
        ordinal: validationPhase.ordinal,
        phaseKey: validationPhase.phaseKey,
        handoffInRef,
      },
      handoffPayload,
    });
    const extraContext = [executorScopeContext, assignedSkillsContext, phaseContext]
      .filter((value) => value.trim().length > 0)
      .join('\n\n');
    const { session } = await this.phaseSessionFactory.create({
      phaseKey: 'validation',
      userId: params.userId ?? detail.userId,
      organizationId: params.orgId,
      modelId: detail.modelCategory ? undefined : (detail.modelId ?? undefined),
      modelCategory: detail.modelCategory ?? undefined,
      executionProfile: readSessionExecutionProfile(sourceSession?.flags),
      profileKey: policySlug,
      promptProfile: validationPhase.promptProfile as PromptProfile,
      extraContext,
      executionMode: 'validation',
      flags: {
        securityops: createRunnerSecurityOpsFlags({
          organizationId: params.orgId,
          scopeId: detail.scopeId,
          runId: detail.id,
          workflowDiscipline: detail.workflowDiscipline ?? 'pentest',
          executionTarget,
          runnerId: detail.runnerId ?? null,
          runnerName: resolvedRunnerName,
          extra: withComplianceFrameworkContext({
            workflowDiscipline: detail.workflowDiscipline ?? 'pentest',
            frameworkKey: detail.complianceFrameworkKey ?? null,
            codeReviewOperation: detail.codeReviewOperation ?? null,
            codeReviewContext: detail.codeReviewContext ?? null,
            extra: {
              ...inheritedSecurityOpsFlags,
              ...cloudAdmissionFlags,
              ...hostedSidecarPhaseFlags,
              activePhaseId: validationPhase.id,
              activePhaseKey: 'validation',
              phaseHandoffSubmitted: false,
              phaseOrdinal: validationPhase.ordinal,
              phaseProfile: validationPhase.phaseProfile,
              toolProfile: validationPhase.toolProfile,
              promptProfile: validationPhase.promptProfile,
              phaseAssignedSkillSlugs: validationSkills,
              handoffInRef,
              validationQueueFindingIds: queuedFindings.map((item) => item.findingId),
              openValidationLeadIds: openValidationLeads.map((lead) => lead.id),
              openValidationLeadCount: openValidationLeads.length,
            },
          }),
        }),
      },
      scopeId: detail.scopeId,
      planSeed,
      toolPolicy: phaseProfileRegistry.buildToolPolicy('validation', {
        ...scopeContext,
        workflowDiscipline: detail.workflowDiscipline ?? 'pentest',
      }),
    });

    try {
      await ensureRunArtifactRoot(session.workspaceDir, missionEnvelopeNodes);
      await syncAssignedSkillsIntoWorkspace(validationSkills, session.workspaceDir);
      await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.skills');
      await this.workspaceService.syncWorkspaceSubtreeToRunner(session.id, session.workspaceDir, '.artifacts');
      await this.workspaceService.writeAndSyncScopeCredentialsIfAvailable({
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        orgId: params.orgId,
        scopeId: detail.scopeId,
        hasScopeAccessMaterials: scopeContext.accessMaterialCount > 0,
      });
      await this.workspaceService.projectRunWorkspace({
        orgId: params.orgId,
        scopeId: detail.scopeId,
        runId: detail.id,
        session,
        phaseKey: 'validation',
        assignedSkillSlugs: validationSkills,
        reason: 'validation_phase_start',
        scopes: ['all'],
      });
      await this.runtimeService.recordExecutionEnvironmentTimeline(session.id, executionTarget, resolvedRunnerName);
    } catch (error) {
      await this.workspaceService.markCreatedPhaseSessionUnused({
        session,
        runId: detail.id,
        phaseId: validationPhase.id,
        phaseKey: 'validation',
        reason: 'phase_preparation_failed',
        error,
      });
      throw error;
    }

    const previousPhaseStatus = previousHandoff ? phaseHandoffTerminalStatus(handoffPayload) : undefined;
    await this.stopPriorPhaseSessionBeforeAdvance({
      phase: previousHandoff,
      nextPhaseKey: 'validation',
      terminalStatus: previousPhaseStatus,
      caller: 'securityops.validation_phase_start',
    });

    let updatedRun: RunRow;
    try {
      updatedRun = await this.deps.runService.activatePhaseSession({
        runId: detail.id,
        phaseId: validationPhase.id,
        sessionId: session.id,
        handoffInRef,
        previousPhaseId: previousHandoff?.id ?? null,
        previousPhaseStatus,
      });
    } catch (error) {
      await this.workspaceService.markCreatedPhaseSessionUnused({
        session,
        runId: detail.id,
        phaseId: validationPhase.id,
        phaseKey: 'validation',
        reason: 'phase_activation_failed',
        error,
      });
      throw error;
    }
    const attachedQueue = await this.deps.runService.attachValidationQueueToPhase({
      runId: detail.id,
      phaseId: validationPhase.id,
      sessionId: session.id,
    });

    await this.runtimeService.kickoffExecutor(
      detail.id,
      session.id,
      VALIDATION_PHASE_KICKOFF_PROMPT,
    );

    return {
      run: updatedRun,
      sessionId: session.id,
      phaseId: validationPhase.id,
      queuedFindingIds: attachedQueue.map((item) => item.findingId),
    };
  }

  async requestPlanFeedback(params: RequestPlanFeedbackParams): Promise<RequestPlanFeedbackResult> {
    return this.replanService.requestPlanFeedback(params);
  }

  private async repairMissingRunKickoffs(limit: number): Promise<{ repaired: number; failed: number }> {
    const inspect = this.deps.runService.listRunningRunsForKickoffRepair;
    // A few focused unit harnesses provide a deliberately narrow RunService
    // fake. Product composition always supplies the concrete implementation.
    if (typeof inspect !== 'function') return { repaired: 0, failed: 0 };

    const runs = await inspect.call(this.deps.runService, limit);
    let repaired = 0;
    let failed = 0;

    for (const run of runs) {
      try {
        const phases = await this.deps.runService.listRunPhases(run.id);
        const activePhase = phases.find((phase) => phase.status === 'active' && Boolean(phase.sessionId));
        const sessionId = activePhase?.sessionId ?? run.plannerSessionId;
        if (!sessionId) continue;

        const session = await this.loadSession(sessionId);
        if (!session || session.completed || session.stateMachine?.isProcessing()) continue;

        const journal = await this.deps.agentServices.sessionStore.getJournalProjection(sessionId);
        const messages = journal?.messages ?? session.messages;
        if (messages.length > 0) continue;

        if (!activePhase) {
          await this.runtimeService.kickoffPlanner(run.id, sessionId, {
            workflowDiscipline: run.workflowDiscipline,
            trigger: run.trigger,
          });
          repaired += 1;
          continue;
        }

        const securityOpsFlags = isRecord(session.flags.securityops)
          ? session.flags.securityops
          : {};
        const prompt = activePhase.phaseKey === 'validation'
          ? nonEmptyString(securityOpsFlags.findingDispositionVerificationId)
            ? FINDING_DISPOSITION_KICKOFF_PROMPT
            : VALIDATION_PHASE_KICKOFF_PROMPT
          : activePhase.phaseKey === 'reporting'
            ? REPORTING_PHASE_KICKOFF_PROMPT
            : isFreshExecutionPhaseKey(activePhase.phaseKey)
              ? EXECUTION_PHASE_KICKOFF_PROMPTS[activePhase.phaseKey]
              : null;
        if (!prompt) continue;

        await this.runtimeService.kickoffExecutor(run.id, sessionId, prompt);
        repaired += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          { err: error, runId: run.id, orgId: run.organizationId },
          '[runs] Failed to repair missing durable kickoff',
        );
      }
    }

    return { repaired, failed };
  }

  async startReadyPhaseRuns(params: { limit?: number } = {}): Promise<StartReadyPhaseRunsResult> {
    if (this.phaseStartSweepInFlight) {
      return {
        attempted: 0,
        started: 0,
        skipped: 0,
        failed: 0,
        inFlight: true,
      };
    }

    this.phaseStartSweepInFlight = true;
    const result: StartReadyPhaseRunsResult = {
      attempted: 0,
      started: 0,
      skipped: 0,
      failed: 0,
      inFlight: false,
    };

    try {
      const limit = params.limit ?? 25;
      const repair = await this.repairMissingRunKickoffs(limit);
      if (repair.repaired > 0 || repair.failed > 0) {
        logger.info(repair, '[runs] Missing kickoff repair sweep completed');
      }

      const candidates = await this.deps.runService.listRunningRunsReadyForPhaseStart(limit);
      for (const run of candidates) {
        result.attempted += 1;
        try {
          const phaseResult = await this.startNextReadyPhase({
            orgId: run.organizationId,
            runId: run.id,
            userId: run.userId,
          });

          if (phaseResult) {
            result.started += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          result.failed += 1;
          logger.warn(
            { err: error, runId: run.id, orgId: run.organizationId },
            '[runs] Failed to start ready pending phase',
          );
        }
      }

      if (result.started > 0 || result.failed > 0) {
        logger.info(result, '[runs] Ready phase start sweep completed');
      }
      return result;
    } finally {
      this.phaseStartSweepInFlight = false;
    }
  }

  async dispatchClaimedPhaseReplan(params: {
    run: RunRow;
    phase: RunPhaseRow;
    replan: RunPhaseReplanRow;
  }): Promise<void> {
    return this.replanService.dispatchClaimedPhaseReplan(params);
  }
}
