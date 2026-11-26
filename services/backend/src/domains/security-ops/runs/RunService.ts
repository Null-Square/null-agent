import type { DatabaseClient } from '@/db/client';
import {
  agentSessions,
  codeReviewReports,
  findingDispositionVerifications,
  findingEvents,
  inventoryNotes,
  runEvents,
  runPhases,
  runs,
  type CodeReviewContext,
  type CodeReviewOperation,
  type RunEventRow,
  type RunAdmissionPurpose,
  type RunPhaseRow,
  type RunPhaseReplanRow,
  type RunRow,
  type RunSchedulingClass,
  type RunWorkflowDiscipline,
  type RunTrigger,
} from '@/db/schema';
import { workCancellationRegistry } from '@/domains/agent-brain/application/orchestration/services/WorkContinuationGuard';
import type { MissionEnvelopeNode } from '@/domains/agent-brain/domain/workers/missionEnvelope';
import {
  UsageRecordRepository,
  type UsageSummaryRow,
} from '@/domains/platform/subscriptions/infrastructure/UsageRecordRepository';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import {
  CodeReviewMemoryService,
  type CodeReviewMemorySnapshot,
} from '@/domains/security-ops/code-review/CodeReviewMemoryService';
import type { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { FailedEventService } from '@/domains/security-ops/resilience/FailedEventService';
import type { ScopeContext, ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { logger } from '@/shared/logger';
import { publishLiveEvent } from '@/app/adapters/events/liveEventBus';
import type { ComplianceFrameworkKey, ModelCategory } from '@null-ai/contracts';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { RunPhaseStatus } from './PhaseProfileRegistry';
import {
  AUTO_GENERATED_RUN_DIGEST_TITLE,
  RUN_DIGEST_FALLBACK_EVENT_NOTE,
  RUN_DIGEST_LOW_QUALITY_EVENT_NOTE,
  RunContextService,
  getRunDigestQuality,
  isFallbackRunDigest,
  type PhaseDiscoveryReplanSignals,
  type RunServiceSkillContextPort,
  type StrategicMemoryNote,
  type ValidationLeadSummary,
} from './RunContextService';
import { RunCreationService } from './RunCreationService';
import {
  DEFAULT_MAX_CONCURRENT_RUNS_PER_SCOPE,
  DEFAULT_RUN_IDEMPOTENCY_BUCKET_MS,
  DEFAULT_RUN_INACTIVITY_FAIL_MS,
  RUN_ACTIVE_STATUSES,
  buildRunIdempotencyKey,
  buildRunUsageSummary,
  chooseRelatedRunStatus,
  hasRunsStatusCheckViolation,
  isRuntimeOnlyRunStatus,
  mapSessionSnapshotToRunStatus,
  resolvePositiveInt,
  resolveRunUsageSessionRefs,
  type CreateRunRecordResult,
  type RunDetail,
  type RunListItem,
  type RunPrerequisiteWarning,
  type RunServiceOptions,
  type RunUsageSummary,
  type SessionRuntimeStatusPort,
} from './RunLifecycleHelpers';
import { RunPhaseRepository } from './RunPhaseRepository';
import {
  RunPhaseWorkflowService,
  type PhaseHandoffReconciliationEvent,
} from './RunPhaseWorkflowService';
import { RunReadService } from './RunReadService';
import { RunRuntimeStatusService } from './RunRuntimeStatusService';
import type { ValidationQueueOutcome } from './ValidationQueueRepository';
import {
  DEFAULT_EXECUTION_TARGET,
  type ExecutionTarget,
} from './executionTargets';
import type { CodeReviewManifestFile } from './codeReviewRunContext';
import {
  RUN_TERMINAL_STATUSES,
} from './lifecyclePredicates';
export {
  buildExecutionEnvironmentContext,
  buildRunContext,
  buildScopeRunContext,
  resolvePolicyForRunnerType
} from './RunContextService';
export type {
  PhaseDiscoveryReplanSignals,
  RunServiceSkillContextPort,
  StrategicMemoryNote,
  ValidationLeadSummary
} from './RunContextService';
export {
  buildRunIdempotencyKey,
  buildRunUsageSummary,
  collectTerminalPhaseSessionIds,
  decodeFindingLifecycleRunNote,
  deriveRunDisplayState,
  encodeFindingLifecycleRunNote,
  evaluateRunPrerequisites,
  isRunAwaitingPlanApproval,
  mapSessionSnapshotToRunStatus,
  resolveRunUsageSessionRefs
} from './RunLifecycleHelpers';
export type {
  CreateRunParams,
  CreateRunRecordResult,
  EvaluateRunPrerequisitesInput,
  EvaluateRunPrerequisitesResult,
  FindingLifecycleMode,
  FindingLifecycleRunNote,
  RunDetail,
  RunDisplayState,
  RunDisplayStatus,
  RunIdempotencyInput,
  RunInteractionType,
  RunListItem,
  RunPauseReason,
  RunPrerequisiteWarning,
  RunPrerequisiteWarningCode,
  RunServiceOptions,
  RunUsagePhaseBreakdown,
  RunUsagePhaseSummary,
  RunUsageSummary,
  RunUsageTotals,
  SessionRuntimeSnapshot,
  SessionRuntimeStatusPort
} from './RunLifecycleHelpers';
export type { PhaseHandoffReconciliationEvent } from './RunPhaseWorkflowService';

// ============================================================================
// Types
// ============================================================================

export interface RunServiceDeps {
  sessionStatusPort?: SessionRuntimeStatusPort;
  skillContextService?: RunServiceSkillContextPort;
  usageRecordRepository?: UsageRecordRepository;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ============================================================================
// Service
// ============================================================================

/**
 * A run's status just moved, so every list showing it is now stale. Called
 * from each site that writes `runs.status` — there is no single chokepoint,
 * and a missed one shows the customer a run frozen at its last status until
 * they refresh by hand.
 */
const announceRunChanged = (run: Pick<RunRow, 'id' | 'organizationId' | 'scopeId'>): void => {
  publishLiveEvent(run.organizationId, {
    kind: 'run.changed',
    scopeId: run.scopeId,
    runId: run.id,
  });
};

export class RunService {
  private readonly maxConcurrentRunsPerScope: number;
  private readonly runInactivityFailMs: number;
  private readonly idempotencyBucketMs: number;
  private readonly sessionStatusPort?: SessionRuntimeStatusPort;
  private readonly usageRecordRepository: UsageRecordRepository;
  private readonly runCreationService: RunCreationService;
  private readonly runReadService: RunReadService;
  private readonly runPhaseRepository: RunPhaseRepository;
  private readonly phaseWorkflowService: RunPhaseWorkflowService;
  private readonly runContextService: RunContextService;
  private readonly runtimeStatusService: RunRuntimeStatusService;
  private readonly codeReviewMemoryService: CodeReviewMemoryService;

  constructor(
    private readonly db: DatabaseClient,
    private readonly orgService: OrganizationService,
    _scopeService: ScopeService,
    deps: RunServiceDeps = {},
    options?: RunServiceOptions,
  ) {
    this.sessionStatusPort = deps.sessionStatusPort;
    this.usageRecordRepository = deps.usageRecordRepository ?? new UsageRecordRepository(this.db);
    this.runPhaseRepository = new RunPhaseRepository(this.db);
    this.runReadService = new RunReadService(this.db, this.runPhaseRepository);
    this.phaseWorkflowService = new RunPhaseWorkflowService(this.db, {
      runPhaseRepository: this.runPhaseRepository,
    });
    this.runContextService = new RunContextService(this.db, {
      orgService: this.orgService,
      skillContextService: deps.skillContextService,
    });
    this.maxConcurrentRunsPerScope = resolvePositiveInt(
      options?.maxConcurrentRunsPerScope,
      DEFAULT_MAX_CONCURRENT_RUNS_PER_SCOPE,
    );
    this.runInactivityFailMs = resolvePositiveInt(
      options?.runInactivityFailMs,
      DEFAULT_RUN_INACTIVITY_FAIL_MS,
    );
    this.idempotencyBucketMs = resolvePositiveInt(
      options?.idempotencyBucketMs,
      DEFAULT_RUN_IDEMPOTENCY_BUCKET_MS,
    );
    this.runCreationService = new RunCreationService(this.db, this.maxConcurrentRunsPerScope);
    this.runtimeStatusService = new RunRuntimeStatusService({
      runPhaseRepository: this.runPhaseRepository,
      sessionStatusPort: this.sessionStatusPort,
      runInactivityFailMs: this.runInactivityFailMs,
    });
    this.codeReviewMemoryService = new CodeReviewMemoryService(this.db);
  }

  buildCodeReviewMemorySnapshot(params: {
    organizationId: string;
    scopeId: string;
    userId: string;
    context: CodeReviewContext;
    manifestFiles: readonly CodeReviewManifestFile[];
    repositoryBrief?: string | null;
  }): Promise<CodeReviewMemorySnapshot> {
    return this.codeReviewMemoryService.buildSnapshot(params);
  }

  persistCodeReviewMemorySnapshot(params: {
    runId: string;
    organizationId: string;
    scopeId: string;
    context: CodeReviewContext;
    snapshot: CodeReviewMemorySnapshot;
  }): Promise<void> {
    return this.codeReviewMemoryService.persistRunSnapshot(params);
  }

  getCodeReviewMemoryPrompt(params: {
    runId: string;
    organizationId: string;
  }): Promise<string> {
    return this.codeReviewMemoryService.getRunSnapshotPrompt(params);
  }

  private async markRunSessionsCancelled(runId: string, reason: string): Promise<void> {
    const trimmedRunId = runId.trim();
    if (!trimmedRunId) {
      return;
    }
    workCancellationRegistry.markRunCancelled(trimmedRunId);

    const [flagRows, phaseRows] = await Promise.all([
      this.db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(
          or(
            sql`(${agentSessions.metadata} #>> '{flags,securityops,runId}') = ${trimmedRunId}`,
            sql`(${agentSessions.metadata} #>> '{coordination,runId}') = ${trimmedRunId}`,
          ),
        ),
      this.runPhaseRepository.listSessionIdsByRunId(trimmedRunId),
    ]);
    const sessionIds = Array.from(
      new Set([
        ...flagRows.map((row) => row.id),
        ...phaseRows,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)),
    );
    for (const sessionId of sessionIds) {
      workCancellationRegistry.markSessionCancelled(sessionId);
    }
    if (sessionIds.length === 0) {
      return;
    }

    const now = new Date();
    const blockedMeta = {
      reason,
      runId: trimmedRunId,
      cancelledAt: now.toISOString(),
    };
    await this.db
      .update(agentSessions)
      .set({
        blockedReason: 'aborted_by_user',
        metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ blockedMeta })}::jsonb`,
        updatedAt: now,
      })
      .where(inArray(agentSessions.id, sessionIds));
  }

  private async resolveRunBySessionId(
    sessionId: string,
  ): Promise<{ run: RunRow; relatedSession: boolean } | null> {
    const [trackedRun] = await this.db
      .select()
      .from(runs)
      .where(
        or(
          eq(runs.sessionId, sessionId),
          eq(runs.plannerSessionId, sessionId),
          eq(runs.executorSessionId, sessionId),
        ),
      )
      .limit(1);

    if (trackedRun) {
      return { run: trackedRun, relatedSession: false };
    }

    const phase = await this.runPhaseRepository.findActiveBySessionId(sessionId);
    if (phase) {
      const [run] = await this.db
        .select()
        .from(runs)
        .where(eq(runs.id, phase.runId))
        .limit(1);

      return run ? { run, relatedSession: true } : null;
    }

    const findById = this.sessionStatusPort?.findById;
    if (typeof findById !== 'function') {
      return null;
    }

    const row = await findById.call(this.sessionStatusPort, sessionId);
    const metadata = isRecord(row?.metadata) ? row.metadata : null;
    const flags = metadata && isRecord(metadata.flags) ? metadata.flags : null;
    const securityops = flags && isRecord(flags.securityops) ? flags.securityops : null;
    const runId = typeof securityops?.runId === 'string' ? securityops.runId.trim() : '';
    if (!runId) {
      return null;
    }

    const [run] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    return run ? { run, relatedSession: true } : null;
  }

  async list(
    orgId: string,
    filters?: { scopeId?: string; status?: string; statuses?: string[]; trigger?: string; limit?: number },
  ): Promise<RunListItem[]> {
    await this.reconcileActiveRuns(orgId);

    const conditions = [eq(runs.organizationId, orgId)];

    if (filters?.scopeId) {
      conditions.push(eq(runs.scopeId, filters.scopeId));
    }
    const statusFilters = (filters?.statuses ?? (filters?.status ? [filters.status] : []))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const useFailedFallbackForStatus = statusFilters.some((value) => isRuntimeOnlyRunStatus(value));

    if (statusFilters.length === 1) {
      const [statusFilter] = statusFilters;
      if (useFailedFallbackForStatus) {
        conditions.push(inArray(runs.status, [statusFilter, 'failed']));
      } else {
        conditions.push(eq(runs.status, statusFilter));
      }
    } else if (statusFilters.length > 1) {
      const expanded = useFailedFallbackForStatus
        ? Array.from(new Set([...statusFilters, 'failed']))
        : statusFilters;
      conditions.push(inArray(runs.status, expanded));
    }
    if (filters?.trigger) {
      // The filter arrives as a free string from HTTP query params, so it is
      // narrowed here rather than trusted; an unrecognised value simply matches
      // nothing instead of widening the column's type.
      conditions.push(eq(runs.trigger, filters.trigger as RunTrigger));
    }

    const query = this.db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt));

    const normalizedLimit =
      typeof filters?.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0
        ? Math.floor(filters.limit)
        : null;

    const listedRuns =
      normalizedLimit !== null
        ? await query.limit(useFailedFallbackForStatus ? normalizedLimit * 2 : normalizedLimit)
        : await query;

    // Reads expose the persisted business-run aggregate. Session execution is
    // a separate projection and must never overwrite run status during list hydration.
    const runtimeHydratedRuns = listedRuns;
    const filteredRuns = statusFilters.length > 0
      ? runtimeHydratedRuns.filter((run) => statusFilters.includes(run.status))
      : runtimeHydratedRuns;

    if (normalizedLimit !== null) {
      return filteredRuns.slice(0, normalizedLimit);
    }

    return filteredRuns;
  }

  getScopeConcurrencyLimit(): number {
    return this.maxConcurrentRunsPerScope;
  }

  buildRunIdempotencyKey(
    scopeId: string,
    params: {
      goal?: string;
      modelId?: string;
      modelCategory?: ModelCategory;
      executionTarget?: ExecutionTarget;
      workflowDiscipline?: RunWorkflowDiscipline;
      workflowIdentity?: string;
      stable?: boolean;
    },
    now?: Date,
  ): string {
    return buildRunIdempotencyKey({
      scopeId,
      goal: params.goal,
      modelId: params.modelId,
      modelCategory: params.modelCategory,
      executionTarget: params.executionTarget,
      workflowDiscipline: params.workflowDiscipline,
      workflowIdentity: params.workflowIdentity,
      stable: params.stable,
      now,
      bucketMs: this.idempotencyBucketMs,
    });
  }

  async getByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<RunRow | null> {
    return this.runCreationService.getByIdempotencyKey(orgId, idempotencyKey);
  }

  async enforceScopeConcurrencyLimit(
    orgId: string,
    scopeId: string,
    workflowDiscipline: RunWorkflowDiscipline = 'pentest',
  ): Promise<void> {
    return this.runCreationService.enforceScopeConcurrencyLimit(orgId, scopeId, workflowDiscipline);
  }

  async countPlanConcurrentRuns(orgId: string): Promise<number> {
    return this.runCreationService.countPlanConcurrentRuns(orgId);
  }

  /**
   * Create a new run: validates scope, builds context, creates session, inserts run + event.
   * Returns `{ run, created }` where `created=false` indicates idempotent replay.
   *
   * NOTE: The actual SessionService.createSession() call is deferred to the caller (router)
   * because SessionService has complex DI that we don't want to duplicate here.
   * Instead, the router creates the session first, then calls createRunRecord().
   */
  async createRunRecord(params: {
    orgId: string;
    scopeId: string;
    userId: string;
    sessionId?: string | null;
    goal: string;
    title?: string | null;
    modelId?: string | null;
    modelCategory?: ModelCategory | null;
    plan?: string | null;
    missionEnvelope?: unknown;
    plannerSessionId?: string | null;
    executorSessionId?: string | null;
    assignedSkillSlugs?: string[] | null;
    workflowDiscipline?: RunWorkflowDiscipline;
    codeReviewOperation?: CodeReviewOperation | null;
    codeReviewContext?: CodeReviewContext | null;
    complianceFrameworkKey?: ComplianceFrameworkKey | null;
    trigger: RunTrigger;
    executionTarget?: ExecutionTarget;
    runnerId?: string | null;
    initialStatus?: 'queued' | 'running';
    idempotencyKey?: string | null;
    replaceFailedIdempotentRun?: boolean;
    maxConcurrentRuns?: number | null;
    maxQueuedBacklog?: number | null;
    admissionPurpose?: RunAdmissionPurpose | null;
    schedulingClass?: RunSchedulingClass | null;
    capacityProfile?: 'control' | 'standard' | 'heavy' | null;
    capacityProfileVersion?: number | null;
    launchPayload?: Record<string, unknown> | null;
  }): Promise<CreateRunRecordResult> {
    return this.runCreationService.createRunRecord(params);
  }

  async attachSessionToAdmittedRun(params: {
    runId: string;
    claimOwner: string;
    admissionEpoch: number;
    sessionId: string;
    modelId?: string | null;
    modelCategory?: ModelCategory | null;
    sessionRole?: 'planner' | 'executor';
  }): Promise<RunRow> {
    return this.runCreationService.attachSessionToAdmittedRun(params);
  }

  async markPlanningComplete(
    runId: string,
    plan: string,
    assignedSkillSlugs?: string[] | null,
    plannerSessionId?: string,
    missionEnvelope?: unknown | null,
  ): Promise<RunRow> {
    return this.phaseWorkflowService.markPlanningComplete(
      runId,
      plan,
      assignedSkillSlugs,
      plannerSessionId,
      missionEnvelope,
    );
  }

  async findNextReadyReportingPhase(runId: string) {
    return this.phaseWorkflowService.findNextReadyReportingPhase(runId);
  }

  async replaceRunPhasesForReportOnlyRun(params: {
    runId: string;
    missions: readonly MissionEnvelopeNode[];
  }) {
    return this.phaseWorkflowService.replaceRunPhasesForReportOnlyRun(params);
  }

  async listRunPhases(runId: string): Promise<RunPhaseRow[]> {
    return this.runPhaseRepository.listByRunId(runId);
  }

  async findNextReadyValidationPhase(runId: string) {
    return this.phaseWorkflowService.findNextReadyValidationPhase(runId);
  }

  async listRunningRunsReadyForPhaseStart(limit = 50): Promise<RunRow[]> {
    return this.phaseWorkflowService.listRunningRunsReadyForPhaseStart(limit);
  }

  /**
   * Small durable-repair read model: running Runs whose planner or active
   * phase may need its first journal input restored after a process crash.
   */
  async listRunningRunsForKickoffRepair(limit = 50): Promise<RunRow[]> {
    return this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.status, 'running'),
          or(
            sql`${runs.plannerSessionId} IS NOT NULL`,
            sql`exists (
              select 1 from ${runPhases}
              where ${runPhases.runId} = ${runs.id}
                and ${runPhases.status} = 'active'
                and ${runPhases.sessionId} is not null
            )`,
          ),
        ),
      )
      .orderBy(desc(runs.updatedAt))
      .limit(Math.max(1, limit));
  }

  async markPhaseCompleted(phaseId: string) {
    return this.phaseWorkflowService.markPhaseCompleted(phaseId);
  }

  async skipControlledExploitationPhase(params: {
    runId: string;
    phaseId: string;
    reason: string;
  }) {
    return this.phaseWorkflowService.skipControlledExploitationPhase(params);
  }

  async listSameRunValidatedFindings(runId: string) {
    return this.phaseWorkflowService.listSameRunValidatedFindings(runId);
  }

  async updatePhaseAssignedSkills(phaseId: string, assignedSkillSlugs: readonly string[]) {
    return this.phaseWorkflowService.updatePhaseAssignedSkills(phaseId, assignedSkillSlugs);
  }

  async hasPhaseSessionHistory(runId: string): Promise<boolean> {
    return this.phaseWorkflowService.hasPhaseSessionHistory(runId);
  }

  async requestPhaseReplan(params: {
    orgId: string;
    runId: string;
    phaseId: string;
    phaseStatus: Extract<RunPhaseStatus, 'completed' | 'blocked' | 'failed'>;
    handoffRef?: string | null;
    reason?: string | null;
  }): Promise<RunRow> {
    return this.phaseWorkflowService.requestPhaseReplan(params);
  }

  async findNextReadyExecutionPhase(runId: string) {
    return this.phaseWorkflowService.findNextReadyExecutionPhase(runId);
  }

  async findLatestPhaseHandoffBefore(runId: string, ordinal: number) {
    return this.phaseWorkflowService.findLatestPhaseHandoffBefore(runId, ordinal);
  }

  async listOpenValidationQueue(runId: string) {
    return this.phaseWorkflowService.listOpenValidationQueue(runId);
  }

  async attachValidationQueueToPhase(params: {
    runId: string;
    phaseId: string;
    sessionId: string;
  }) {
    return this.phaseWorkflowService.attachValidationQueueToPhase(params);
  }

  async completeValidationQueueFinding(params: {
    runId: string;
    findingId: string;
    outcome: ValidationQueueOutcome;
    sessionId?: string | null;
    resultRef?: string | null;
  }) {
    return this.phaseWorkflowService.completeValidationQueueFinding(params);
  }

  async activatePhaseSession(params: {
    runId: string;
    phaseId: string;
    sessionId: string;
    handoffInRef?: string | null;
    previousPhaseId?: string | null;
    previousPhaseStatus?: Extract<RunPhaseStatus, 'completed' | 'blocked' | 'failed'>;
  }): Promise<RunRow> {
    return this.phaseWorkflowService.activatePhaseSession(params);
  }

  /**
   * Record a run lifecycle event. Used for observability of transitions that the
   * status column alone cannot attribute, e.g. who/what authorized a plan approval
   * continuation (H-2026-05-28-010). `note` is stored verbatim; callers that need
   * structure should pass a JSON string.
   */
  async recordRunEvent(params: { runId: string; type: string; note?: string | null }): Promise<void> {
    await this.db.insert(runEvents).values({
      runId: params.runId,
      type: params.type,
      ...(typeof params.note === 'string' && params.note.length > 0 ? { note: params.note } : {}),
    });
  }

  /**
   * Bind the durable finding-verification request to the session that actually
   * won cloud admission. This is idempotent because an admission retry may
   * reach this point again after a process crash.
   */
  async markFindingDispositionVerificationStarted(params: {
    verificationId: string;
    runId: string;
    sessionId: string;
    organizationId: string;
    findingId: string;
    userId: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [verification] = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.id, params.verificationId),
            eq(findingDispositionVerifications.organizationId, params.organizationId),
            eq(findingDispositionVerifications.findingId, params.findingId),
          ),
        )
        .limit(1)
        .for('update');
      if (!verification) {
        throw new Error('Finding disposition verification no longer exists');
      }
      if (verification.runId && verification.runId !== params.runId) {
        throw new Error('Finding disposition verification is linked to a different Run');
      }
      if (!['launching', 'running'].includes(verification.status)) {
        throw new Error(`Finding disposition verification is already ${verification.status}`);
      }
      const alreadyBound = verification.sessionId === params.sessionId;
      const now = new Date();
      await tx
        .update(findingDispositionVerifications)
        .set({
          status: 'running',
          runId: params.runId,
          sessionId: params.sessionId,
          waitReason: null,
          failureCode: null,
          failureReason: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          startedAt: verification.startedAt ?? now,
          updatedAt: now,
        })
        .where(eq(findingDispositionVerifications.id, params.verificationId));
      if (!alreadyBound) {
        await tx.insert(findingEvents).values({
          organizationId: params.organizationId,
          userId: params.userId,
          findingId: params.findingId,
          type: 'disposition_verification_started',
          note: `Verification ${params.verificationId} started in Run ${params.runId}`,
          createdAt: now,
        });
      }
    });
  }

  async resetFindingDispositionVerificationLaunch(params: {
    verificationId: string;
    runId: string;
  }): Promise<void> {
    await this.db
      .update(findingDispositionVerifications)
      .set({
        status: 'running',
        sessionId: null,
        waitReason: 'waiting_for_capacity',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(findingDispositionVerifications.id, params.verificationId),
          eq(findingDispositionVerifications.runId, params.runId),
          eq(findingDispositionVerifications.status, 'running'),
        ),
      );
  }

  /**
   * Build extra context from an already-fetched ScopeContext (avoids duplicate DB call).
   */
  async buildExtraContextFromParts(
    orgId: string,
    scopeContext: ScopeContext,
    executionTarget: ExecutionTarget = DEFAULT_EXECUTION_TARGET,
    recipient: 'planner' | 'executor' | 'reporting' = 'planner',
  ): Promise<string> {
    return this.runContextService.buildExtraContextFromParts(
      orgId,
      scopeContext,
      executionTarget,
      recipient,
    );
  }

  async buildAssignedSkillsContext(
    orgId: string,
    scopeId: string,
    assignedSkillSlugs: readonly string[] | null | undefined,
  ): Promise<string> {
    return this.runContextService.buildAssignedSkillsContext(orgId, scopeId, assignedSkillSlugs);
  }

  async buildPhaseCompatibleSkillCatalogContext(
    orgId: string,
    scopeId: string,
    phaseKey: Parameters<RunContextService['buildPhaseCompatibleSkillCatalogContext']>[2],
    assignedSkillSlugs: readonly string[] | null | undefined,
  ): Promise<string> {
    return this.runContextService.buildPhaseCompatibleSkillCatalogContext(orgId, scopeId, phaseKey, assignedSkillSlugs);
  }


  async getStrategicNotesForMemorySeed(
    orgId: string,
    scopeId: string,
    workflowDiscipline: RunWorkflowDiscipline = 'pentest',
    complianceFrameworkKey?: ComplianceFrameworkKey | null,
  ): Promise<StrategicMemoryNote[]> {
    return this.runContextService.getStrategicNotesForMemorySeed(
      orgId,
      scopeId,
      workflowDiscipline,
      complianceFrameworkKey,
    );
  }

  async buildPriorRunContext(
    orgId: string,
    scopeId: string,
    workflowDiscipline: RunWorkflowDiscipline = 'pentest',
    complianceFrameworkKey?: ComplianceFrameworkKey | null,
  ): Promise<string> {
    return this.runContextService.buildPriorRunContext(
      orgId,
      scopeId,
      workflowDiscipline,
      complianceFrameworkKey,
    );
  }

  async listOpenValidationLeads(
    orgId: string,
    scopeId: string,
    limit = 25,
  ): Promise<ValidationLeadSummary[]> {
    return this.runContextService.listOpenValidationLeads(orgId, scopeId, limit);
  }

  async getPhaseDiscoveryReplanSignals(params: {
    orgId: string;
    scopeId: string;
    since?: Date | null;
  }): Promise<PhaseDiscoveryReplanSignals> {
    return this.runContextService.getPhaseDiscoveryReplanSignals(params);
  }

  async recordPhaseHandoffReconciliation(event: PhaseHandoffReconciliationEvent): Promise<void> {
    return this.phaseWorkflowService.recordPhaseHandoffReconciliation(event);
  }

  async hasAppliedPhaseReplan(params: { runId: string; phaseId: string }): Promise<boolean> {
    return this.phaseWorkflowService.hasAppliedPhaseReplan(params);
  }

  async hasOpenPhaseReplan(params: { runId: string; phaseId: string }): Promise<boolean> {
    return this.phaseWorkflowService.hasOpenPhaseReplan(params);
  }

  async findOpenPhaseReplan(params: { runId: string; phaseId: string }): Promise<RunPhaseReplanRow | null> {
    return this.phaseWorkflowService.findOpenPhaseReplan(params);
  }

  async enforceRunPrerequisites(params: {
    orgId: string;
    scopeId: string;
    goal: string;
    scopeContext: ScopeContext;
    executionTarget?: ExecutionTarget;
    networkActivityRequired?: boolean;
  }): Promise<RunPrerequisiteWarning[]> {
    return this.runCreationService.enforceRunPrerequisites(params);
  }

  async getById(orgId: string, runId: string): Promise<RunDetail> {
    const [rawRun] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, orgId)))
      .limit(1);

    if (!rawRun) {
      throw new Error('Run not found');
    }

    // GET is deliberately side-effect free. Reconciliation runs through the
    // explicit monitor/event paths, never because an operator opened a page.
    const run = rawRun;

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));

    const usageSummary = await this.getRunUsageSummary(run);

    return { ...run, eventsCount: count, usageSummary };
  }

  async cancel(
    orgId: string,
    runId: string,
    reason = 'run_cancelled_by_operator',
  ): Promise<void> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, orgId)))
      .limit(1);

    if (!run) {
      throw new Error('Run not found');
    }

    const updatedRun = await this.updateRunStatus(run, 'cancelled');
    if (updatedRun.status === 'cancelled') {
      const phaseCancellationError = reason === 'run_cancelled_by_operator'
        ? 'Run cancelled by operator before phase completion'
        : `Run cancelled before phase completion: ${reason}`;
      await this.runPhaseRepository.abortUnfinishedForRun({
        runId,
        lastError: phaseCancellationError,
      });
      await this.markRunSessionsCancelled(runId, reason);
    }
  }

  async transitionStatus(
    orgId: string,
    runId: string,
    nextStatus: 'queued' | 'running' | 'user_paused' | 'system_paused' | 'completed' | 'failed' | 'cancelled',
  ): Promise<RunRow> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, orgId)))
      .limit(1);

    if (!run) {
      throw new Error('Run not found');
    }

    return this.updateRunStatus(run, nextStatus);
  }

  async transitionStatusIfCurrent(params: {
    orgId: string;
    runId: string;
    expectedStatuses: Array<RunRow['status']>;
    nextStatus: RunRow['status'];
  }): Promise<RunRow | null> {
    const now = new Date();
    const [updated] = await this.db
      .update(runs)
      .set({
        status: params.nextStatus,
        ...(params.nextStatus === 'running' ? { completedAt: null } : {}),
        ...(['completed', 'failed', 'cancelled'].includes(params.nextStatus) ? { completedAt: now } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(runs.id, params.runId),
        eq(runs.organizationId, params.orgId),
        sql`${runs.status} NOT IN ('completed', 'failed', 'cancelled')`,
        inArray(runs.status, params.expectedStatuses),
        ne(runs.status, params.nextStatus),
      ))
      .returning();
    if (!updated) return null;
    await this.db.insert(runEvents).values({ runId: updated.id, type: params.nextStatus });
    announceRunChanged(updated);
    return updated;
  }

  async authorizeRecoveryExecution(params: {
    orgId: string;
    runId: string;
    allowedStatuses: Array<RunRow['status']>;
  }): Promise<RunRow | null> {
    const now = new Date();
    const [updated] = await this.db
      .update(runs)
      .set({ status: 'running', completedAt: null, updatedAt: now })
      .where(and(
        eq(runs.id, params.runId),
        eq(runs.organizationId, params.orgId),
        sql`${runs.status} NOT IN ('queued', 'completed', 'failed', 'cancelled')`,
        inArray(runs.status, params.allowedStatuses),
      ))
      .returning();
    if (!updated) return null;
    await this.db.insert(runEvents).values({ runId: updated.id, type: 'system_recovery_started' });
    announceRunChanged(updated);
    return updated;
  }

  async getEvents(runId: string): Promise<RunEventRow[]> {
    return this.runReadService.getEvents(runId);
  }

  async getFindings(runId: string): Promise<unknown[]> {
    return this.runReadService.getFindings(runId);
  }

  async getInventoryDiff(runId: string): Promise<{ added: unknown[]; removed: unknown[] }> {
    return this.runReadService.getInventoryDiff(runId);
  }

  // ---- Status tracking hooks ----

  async onSessionStatusChange(sessionId: string, newStatus: string): Promise<void> {
    const resolved = await this.resolveRunBySessionId(sessionId);
    if (!resolved) return; // Not a tracked run (e.g. interactive chat)
    const { run, relatedSession } = resolved;
    const sessionPhase = await this.runPhaseRepository.findLatestBySessionId(sessionId);
    const activePhase = sessionPhase?.status === 'active' ? sessionPhase : null;

    if (
      sessionPhase &&
      sessionPhase.status !== 'active' &&
      ['completed', 'failed', 'error', 'cancelled', 'aborted', 'timed_out', 'timeout'].includes(newStatus)
    ) {
      return;
    }

    let runStatus: string;
    switch (newStatus) {
      case 'active':
      case 'processing':
      case 'running':
        runStatus = 'running';
        break;
      case 'credits_exhausted':
      case 'user_paused':
      case 'awaiting_user':
      case 'awaiting_approval':
      case 'runner_unavailable':
      case 'system_paused':
        runStatus = newStatus;
        break;
      case 'completed':
        runStatus = activePhase?.status === 'active' ? 'failed' : 'completed';
        break;
      case 'blocked':
        runStatus = 'failed';
        break;
      case 'timed_out':
      case 'timeout':
      case 'failed':
      case 'error':
        runStatus = 'failed';
        break;
      case 'cancelled':
      case 'aborted':
        runStatus = 'cancelled';
        break;
      default:
        return;
    }

    const terminalPhaseStatus = this.resolveSessionPhaseTerminalStatus(activePhase?.status, newStatus);
    if (activePhase && terminalPhaseStatus) {
      await this.runPhaseRepository.updateStatus({
        phaseId: activePhase.id,
        status: terminalPhaseStatus.status,
        lastError: terminalPhaseStatus.lastError,
      });
    }

    if (
      relatedSession &&
      !isRuntimeOnlyRunStatus(runStatus)
    ) {
      return;
    }

    runStatus = await this.runtimeStatusService.normalizeGoalPlannerCompletionStatusForRuntime(run, runStatus) ?? runStatus;

    if (RUN_TERMINAL_STATUSES.has(run.status)) return;

    await this.updateRunStatus(run, runStatus);
  }

  private resolveSessionPhaseTerminalStatus(
    currentPhaseStatus: string | undefined,
    sessionStatus: string,
  ): { status: Extract<RunPhaseStatus, 'blocked' | 'failed' | 'timed_out' | 'aborted'>; lastError: string } | null {
    if (currentPhaseStatus !== 'active') {
      return null;
    }

    switch (sessionStatus) {
      case 'completed':
        return {
          status: 'failed',
          lastError: 'Phase session completed without submit_phase_handoff',
        };
      case 'blocked':
        return {
          status: 'blocked',
          lastError: 'Phase session blocked before submit_phase_handoff',
        };
      case 'timed_out':
      case 'timeout':
        return {
          status: 'timed_out',
          lastError: 'Phase session timed out before submit_phase_handoff',
        };
      case 'cancelled':
      case 'aborted':
        return {
          status: 'aborted',
          lastError: 'Phase session aborted before submit_phase_handoff',
        };
      case 'failed':
      case 'error':
        return {
          status: 'failed',
          lastError: 'Phase session failed before submit_phase_handoff',
        };
      default:
        return null;
    }
  }

  async incrementFindingsCount(runId: string): Promise<void> {
    await this.db
      .update(runs)
      .set({
        findingsCount: sql`${runs.findingsCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
  }

  async incrementInventoryAdded(runId: string): Promise<void> {
    await this.db
      .update(runs)
      .set({
        inventoryAdded: sql`${runs.inventoryAdded} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
  }

  async reconcileBySessionId(sessionId: string): Promise<RunRow | null> {
    const resolved = await this.resolveRunBySessionId(sessionId);
    if (!resolved) return null;
    return this.reconcileRun(resolved.run);
  }

  async reconcileActiveRuns(orgId: string): Promise<void> {
    if (!this.sessionStatusPort) return;

    const activeRuns = await this.db.select().from(runs).where(and(eq(runs.organizationId, orgId), inArray(runs.status, RUN_ACTIVE_STATUSES)));
    await this.reconcileRuns(activeRuns);
  }

  async reconcileAllActiveRuns(): Promise<void> {
    if (!this.sessionStatusPort) return;

    const activeRuns = await this.db.select().from(runs).where(inArray(runs.status, RUN_ACTIVE_STATUSES));
    await this.reconcileRuns(activeRuns);
  }

  private async reconcileRuns(activeRuns: RunRow[]): Promise<void> {
    if (activeRuns.length === 0) return;
    for (const run of activeRuns) {
      try {
        await this.reconcileRun(run);
      } catch (error) {
        logger.warn(
          { err: error, runId: run.id, sessionId: run.sessionId },
          '[runs] Reconciliation skipped for one run',
        );
      }
    }
  }

  private async reconcileRun(run: RunRow): Promise<RunRow> {
    if (!run.sessionId || !this.sessionStatusPort || RUN_TERMINAL_STATUSES.has(run.status)) {
      return run;
    }

    const snapshot = await this.runtimeStatusService.getSessionRuntimeSnapshot(run.sessionId);
    if (!snapshot) return run;

    const nowMs = Date.now();
    const primaryStatus = mapSessionSnapshotToRunStatus(
      snapshot,
      run.status,
      run.startedAt,
      nowMs,
      this.runInactivityFailMs,
    );
    const relatedStatuses = await this.runtimeStatusService.getRelatedRunStatuses(run, nowMs);
    const nextStatus = chooseRelatedRunStatus(primaryStatus, relatedStatuses);
    const normalizedNextStatus = await this.runtimeStatusService.normalizeGoalPlannerCompletionStatusForRuntime(run, nextStatus);
    if (normalizedNextStatus === 'completed' && await this.runPhaseRepository.hasOpenPhases(run.id)) {
      return run.status === 'running' ? run : this.updateRunStatus(run, 'running');
    }
    if (!normalizedNextStatus || normalizedNextStatus === run.status) {
      return run;
    }

    return this.updateRunStatus(run, normalizedNextStatus);
  }

  private async getRunUsageSummary(
    run: Pick<RunRow, 'id' | 'sessionId' | 'plannerSessionId' | 'executorSessionId'>,
  ): Promise<RunUsageSummary> {
    // Load phase rows once so we can both extend the session-id set and emit
    // per-phase usage breakdowns in the summary.
    const phaseRows = await this.runPhaseRepository.listByRunId(run.id);
    const phaseSessionIds = phaseRows
      .map((row) => row.sessionId)
      .filter((id): id is string => Boolean(id));

    const additionalSessionIds = Array.from(new Set([
      ...phaseSessionIds,
      ...(await this.runtimeStatusService.listAdditionalRunSessionIds(run.id, resolveRunUsageSessionRefs(run).sessionIds)),
    ]));
    const refs = resolveRunUsageSessionRefs(run, additionalSessionIds);
    if (refs.sessionIds.length === 0) {
      return buildRunUsageSummary(run, new Map(), additionalSessionIds, phaseRows);
    }

    const summaries = await Promise.all(
      refs.sessionIds.map(async (sessionId) => [sessionId, await this.usageRecordRepository.summarizeSession(sessionId)] as const),
    );
    const summaryBySessionId = new Map(
      summaries
        .filter((entry): entry is readonly [string, UsageSummaryRow] => Boolean(entry[1]))
        .map(([sessionId, summary]) => [sessionId, summary]),
    );

    return buildRunUsageSummary(run, summaryBySessionId, additionalSessionIds, phaseRows);
  }

  private async collectRunNoteSessionIds(run: RunRow): Promise<string[]> {
    const ids = new Set<string>();
    if (typeof run.sessionId === 'string' && run.sessionId.length > 0) {
      ids.add(run.sessionId);
    }
    if (typeof run.plannerSessionId === 'string' && run.plannerSessionId.length > 0) {
      ids.add(run.plannerSessionId);
    }
    if (typeof run.executorSessionId === 'string' && run.executorSessionId.length > 0) {
      ids.add(run.executorSessionId);
    }
    for (const phaseSessionId of await this.runPhaseRepository.listSessionIdsByRunId(run.id)) {
      ids.add(phaseSessionId);
    }
    return Array.from(ids);
  }

  private isLowValueRunDigest(note: Pick<StrategicMemoryNote, 'title' | 'data'>): boolean {
    return getRunDigestQuality(isRecord(note.data) ? note.data : {}) === 'thin';
  }

  private async emitRunDigestQualitySignal(
    run: Pick<RunRow, 'id' | 'organizationId' | 'scopeId'>,
    sessionId: string | null,
    note: string,
  ): Promise<void> {
    await this.db.insert(runEvents).values({
      runId: run.id,
      type: 'system',
      note,
    });

    logger.warn(
      { runId: run.id, organizationId: run.organizationId, scopeId: run.scopeId, sessionId, note },
      '[runs] Degraded run.digest quality detected',
    );
  }

  private async ensureRunDigestOnCompletion(run: RunRow): Promise<void> {
    const sessionIds = await this.collectRunNoteSessionIds(run);
    if (sessionIds.length === 0) {
      return;
    }
    const digestSessionId = run.executorSessionId ?? run.sessionId;
    if (!digestSessionId) {
      return;
    }

    if (run.workflowDiscipline === 'code_review' && run.codeReviewContext) {
      const [report] = await this.db
        .select({
          executiveSummary: codeReviewReports.executiveSummary,
        })
        .from(codeReviewReports)
        .where(
          and(
            eq(codeReviewReports.organizationId, run.organizationId),
            eq(codeReviewReports.runId, run.id),
          ),
        )
        .limit(1);
      await this.codeReviewMemoryService.upsertRunDigest({
        organizationId: run.organizationId,
        scopeId: run.scopeId,
        runId: run.id,
        sessionId: digestSessionId,
        userId: run.userId,
        context: run.codeReviewContext,
        goal: run.goal,
        outcome: report?.executiveSummary ?? 'Code Review completed.',
      });
      return;
    }

    const [existingDigest] = await this.db
      .select({ id: inventoryNotes.id, title: inventoryNotes.title, data: inventoryNotes.data, sessionId: inventoryNotes.sessionId })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.organizationId, run.organizationId),
          eq(inventoryNotes.scopeId, run.scopeId),
          eq(inventoryNotes.ntype, 'run.digest'),
          inArray(inventoryNotes.sessionId, sessionIds),
        ),
      )
      .limit(1);

    if (existingDigest) {
      if (this.isLowValueRunDigest(existingDigest)) {
        await this.emitRunDigestQualitySignal(
          run,
          existingDigest.sessionId ?? null,
          isFallbackRunDigest(existingDigest) ? RUN_DIGEST_FALLBACK_EVENT_NOTE : RUN_DIGEST_LOW_QUALITY_EVENT_NOTE,
        );
      }
      return;
    }

    await this.db.insert(inventoryNotes).values({
      userId: run.userId,
      organizationId: run.organizationId,
      scopeId: run.scopeId,
      sessionId: digestSessionId,
      ntype: 'run.digest',
      title: AUTO_GENERATED_RUN_DIGEST_TITLE,
      data: {
        goal: run.goal,
        outcome: 'completed',
      },
      dedupeKey: `run-digest-fallback:${run.id}:${digestSessionId}`,
    });
    await this.emitRunDigestQualitySignal(run, digestSessionId, RUN_DIGEST_FALLBACK_EVENT_NOTE);
  }

  private async updateRunStatus(run: RunRow, nextStatus: string): Promise<RunRow> {
    if (run.status === nextStatus) {
      return run;
    }

    if (RUN_TERMINAL_STATUSES.has(run.status)) {
      return run;
    }

    const now = new Date();
    let updated: RunRow | undefined;
    try {
      [updated] = await this.db
        .update(runs)
        .set({
          status: nextStatus,
          ...(nextStatus === 'running' && !run.startedAt ? { startedAt: now } : {}),
          ...((nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled') ? { completedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(runs.id, run.id))
        .returning();
    } catch (error) {
      if (isRuntimeOnlyRunStatus(nextStatus) && hasRunsStatusCheckViolation(error)) {
        logger.warn(
          { err: error, runId: run.id, requestedStatus: nextStatus },
          '[runs] Returning runtime-only status without persistence due to runs_status_check constraint',
        );
        return {
          ...run,
          status: nextStatus as RunRow['status'],
          updatedAt: now,
        };
      }
      throw error;
    }

    if (updated) {
      await this.db.insert(runEvents).values({
        runId: run.id,
        type: nextStatus,
      });
      announceRunChanged(updated);

      if (nextStatus === 'completed') {
        try {
          await this.ensureRunDigestOnCompletion(updated);
        } catch (error) {
          logger.warn(
            { err: error, runId: updated.id, sessionId: updated.sessionId },
            '[runs] Auto run.digest fallback hook failed',
          );
        }

        const runCompletedEventPayload = {
          runId: updated.id,
          scopeId: updated.scopeId,
          goal: updated.goal,
          status: updated.status,
        };
        const failedEventService = new FailedEventService(this.db);
        const automationService = new AutomationService({ db: this.db });

        try {
          await automationService.evaluateEvent(updated.organizationId, {
            type: 'run_completed',
            payload: runCompletedEventPayload,
          });
        } catch (error) {
          logger.error(
            { err: error, runId: updated.id, organizationId: updated.organizationId },
            '[runs] Run-completed automation hook failed',
          );
          await failedEventService.recordFailure({
            organizationId: updated.organizationId,
            eventType: 'automation.evaluate_event',
            payload: {
              channel: 'automation',
              source: 'runs.run_completed',
              eventType: 'run_completed',
              eventPayload: runCompletedEventPayload,
            },
            error,
          });
        }
      }

      return updated;
    }

    return run;
  }

}
