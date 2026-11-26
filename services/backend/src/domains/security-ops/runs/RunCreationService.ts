import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import {
  assets,
  runEvents,
  runs,
  type CodeReviewContext,
  type CodeReviewOperation,
  type RunRow,
  type RunAdmissionPurpose,
  type RunSchedulingClass,
  type RunWorkflowDiscipline,
  type RunTrigger,
} from '@/db/schema';
import type { ScopeContext } from '@/domains/security-ops/scopes/ScopeService';
import { isCloudBlockedIpv4CidrTarget } from '@/domains/security-ops/scopes/networkTargetPolicy';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { publishLiveEvent } from '@/app/adapters/events/liveEventBus';
import type { ComplianceFrameworkKey, ModelCategory } from '@null-ai/contracts';
import {
  DEFAULT_EXECUTION_TARGET,
  type ExecutionTarget,
} from './executionTargets';
import {
  PLAN_CONCURRENT_RUN_STATUSES,
  RUN_ACTIVE_STATUSES,
  VULNERABILITY_GOAL_HINTS,
  evaluateRunPrerequisites,
  goalMatchesAnyHint,
  normalizeAssignedSkillSlugs,
  normalizeGoal,
  type CreateRunRecordResult,
  type RunPrerequisiteWarning,
} from './RunLifecycleHelpers';
import { validateRunWorkflowIdentity } from './codeReviewRunContext';

export class RunCreationService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly maxConcurrentRunsPerScope: number,
  ) {}

  async getByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<RunRow | null> {
    const normalized = idempotencyKey.trim();
    if (!normalized) return null;

    const [existing] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.organizationId, orgId), eq(runs.idempotencyKey, normalized)))
      .limit(1);

    return existing ?? null;
  }

  async enforceScopeConcurrencyLimit(
    orgId: string,
    scopeId: string,
    workflowDiscipline: RunWorkflowDiscipline = 'pentest',
  ): Promise<void> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          eq(runs.organizationId, orgId),
          eq(runs.scopeId, scopeId),
          eq(runs.workflowDiscipline, workflowDiscipline),
          inArray(runs.status, RUN_ACTIVE_STATUSES),
        ),
      );

    const activeCount = Number(row?.count ?? 0);
    if (activeCount < this.maxConcurrentRunsPerScope) {
      return;
    }

    throw new AppError(
      ERROR_CODES.RESOURCE_LIMIT_REACHED,
      `Scope ${workflowDiscipline} run limit reached (${this.maxConcurrentRunsPerScope} concurrent runs). Wait for an active ${workflowDiscipline} run to finish.`,
    );
  }

  async countPlanConcurrentRuns(orgId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          eq(runs.organizationId, orgId),
          or(
            inArray(runs.status, PLAN_CONCURRENT_RUN_STATUSES),
            and(eq(runs.status, 'queued'), sql`${runs.admittedAt} IS NOT NULL`),
          ),
        ),
      );

    return Number(row?.count ?? 0);
  }

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
    const now = new Date();
    const initialStatus = params.initialStatus ?? 'queued';
    const idempotencyKey = params.idempotencyKey?.trim() || null;
    const normalizedGoal = params.goal.trim();
    if (!normalizedGoal) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'goal is required');
    }
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
    const values = {
      organizationId: params.orgId,
      scopeId: params.scopeId,
      userId: params.userId,
      sessionId: params.sessionId,
      modelId: params.modelId?.trim() || null,
      modelCategory: params.modelCategory ?? null,
      title: params.title?.trim() || null,
      goal: normalizedGoal,
      plan: params.plan?.trim() || null,
      missionEnvelope: params.missionEnvelope ?? null,
      plannerSessionId: params.plannerSessionId ?? null,
      executorSessionId: params.executorSessionId ?? null,
      assignedSkillSlugs: normalizeAssignedSkillSlugs(params.assignedSkillSlugs),
      workflowDiscipline,
      codeReviewOperation: params.codeReviewOperation ?? null,
      codeReviewContext: params.codeReviewContext ?? null,
      complianceFrameworkKey: params.complianceFrameworkKey ?? null,
      trigger: params.trigger,
      idempotencyKey,
      executionTarget: params.executionTarget ?? DEFAULT_EXECUTION_TARGET,
      status: initialStatus,
      runnerId: params.runnerId ?? null,
      admissionEpoch: initialStatus === 'queued' ? 1 : 0,
      admissionPurpose: params.admissionPurpose ?? (initialStatus === 'queued' ? 'planning' : null),
      schedulingClass: params.schedulingClass ?? null,
      capacityProfile: params.capacityProfile ?? (initialStatus === 'queued' ? 'control' : null),
      capacityProfileVersion: params.capacityProfileVersion ?? (initialStatus === 'queued' ? 1 : null),
      launchPayload: params.launchPayload ?? null,
      ...(initialStatus === 'running'
        ? { startedAt: now, epochStartedAt: now }
        : { queuedAt: now, eligibleAt: now, capacityWaitReason: 'waiting_for_admission' }),
    };

    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`run-submit:org:${params.orgId}`}, 0))`,
      );
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`run-submit:scope:${params.scopeId}:${workflowDiscipline}`}, 0))`,
      );

      if (idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.organizationId, params.orgId), eq(runs.idempotencyKey, idempotencyKey)))
          .limit(1);
        if (existing) {
          if (!params.replaceFailedIdempotentRun || existing.status !== 'failed') {
            return { run: existing, created: false };
          }

          // Keep the failed Run terminal. Free the scheduler's stable key so
          // this same allowance can create a distinct replacement Run.
          const [retired] = await tx
            .update(runs)
            .set({
              idempotencyKey: `${idempotencyKey}:failed:${existing.id}`,
              updatedAt: now,
            })
            .where(and(
              eq(runs.id, existing.id),
              eq(runs.organizationId, params.orgId),
              eq(runs.idempotencyKey, idempotencyKey),
              eq(runs.status, 'failed'),
            ))
            .returning({ id: runs.id });
          if (!retired) {
            throw new AppError(
              ERROR_CODES.INTERNAL_UNEXPECTED,
              'Failed Run changed while its replacement was being created',
            );
          }
        }
      }

      const [scopeRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, params.orgId),
            eq(runs.scopeId, params.scopeId),
            eq(runs.workflowDiscipline, workflowDiscipline),
            inArray(runs.status, RUN_ACTIVE_STATUSES),
          ),
        );
      const scopeCount = Number(scopeRow?.count ?? 0);
      if (scopeCount >= this.maxConcurrentRunsPerScope) {
        throw new AppError(
          ERROR_CODES.RESOURCE_LIMIT_REACHED,
          `Scope ${workflowDiscipline} run limit reached (${this.maxConcurrentRunsPerScope} concurrent runs). Wait for an active ${workflowDiscipline} run to finish.`,
        );
      }

      if (initialStatus === 'running' && params.maxConcurrentRuns !== null && params.maxConcurrentRuns !== undefined) {
        const [planRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, params.orgId),
              or(
                inArray(runs.status, PLAN_CONCURRENT_RUN_STATUSES),
                and(eq(runs.status, 'queued'), sql`${runs.admittedAt} IS NOT NULL`),
              ),
            ),
          );
        const activeCount = Number(planRow?.count ?? 0);
        if (activeCount >= params.maxConcurrentRuns) {
          throw new AppError(ERROR_CODES.RESOURCE_LIMIT_REACHED, 'Concurrent run limit reached for your plan', {
            httpStatus: 429,
            context: {
              feature: 'maxConcurrentRuns',
              limit: params.maxConcurrentRuns,
              activeRuns: activeCount,
            },
          });
        }
      }

      if (initialStatus === 'queued' && params.maxQueuedBacklog !== null && params.maxQueuedBacklog !== undefined) {
        const [backlogRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, params.orgId),
              eq(runs.status, 'queued'),
              sql`${runs.admittedAt} IS NULL`,
            ),
          );
        const backlogCount = Number(backlogRow?.count ?? 0);
        if (backlogCount >= params.maxQueuedBacklog) {
          throw new AppError(ERROR_CODES.RESOURCE_LIMIT_REACHED, 'Queued run backlog limit reached for your plan', {
            httpStatus: 429,
            context: {
              feature: 'maxQueuedRuns',
              limit: params.maxQueuedBacklog,
              queuedRuns: backlogCount,
            },
          });
        }
      }

      const [run] = idempotencyKey
        ? await tx
            .insert(runs)
            .values(values)
            .onConflictDoNothing({ target: [runs.organizationId, runs.idempotencyKey] })
            .returning()
        : await tx.insert(runs).values(values).returning();

      if (!run && idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.organizationId, params.orgId), eq(runs.idempotencyKey, idempotencyKey)))
          .limit(1);
        if (existing) return { run: existing, created: false };
      }
      if (!run) {
        throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to create run');
      }

      await tx.insert(runEvents).values([
        { runId: run.id, type: initialStatus },
        { runId: run.id, type: initialStatus === 'queued' ? 'run.queued' : 'run.started' },
      ]);
      return { run, created: true };
    });

    // After the commit, never inside it: the browser answers this event with a
    // refetch, and a refetch that overtakes the commit reads the rows as they
    // were before the insert and caches them. Idempotent replays return
    // `created: false` and are silent — nothing appeared, so nothing is stale.
    if (result.created) {
      publishLiveEvent(params.orgId, {
        kind: 'run.created',
        scopeId: result.run.scopeId,
        runId: result.run.id,
      });
    }
    return result;
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
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .update(runs)
        .set({
          sessionId: params.sessionId,
          ...(params.sessionRole === 'executor'
            ? { executorSessionId: params.sessionId }
            : { plannerSessionId: params.sessionId }),
          modelId: params.modelId?.trim() || null,
          modelCategory: params.modelCategory ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(runs.id, params.runId),
            eq(runs.status, 'queued'),
            eq(runs.claimOwner, params.claimOwner),
            eq(runs.admissionEpoch, params.admissionEpoch),
            sql`${runs.admittedAt} IS NOT NULL`,
          ),
        )
        .returning();
      if (!run) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'The queued run admission claim changed before its session was attached.',
          { httpStatus: 409 },
        );
      }
      await tx.insert(runEvents).values({
        runId: run.id,
        type: 'run.session_attached',
        note: `epoch=${params.admissionEpoch}`,
      });
      return run;
    });
  }

  async enforceRunPrerequisites(params: {
    orgId: string;
    scopeId: string;
    goal: string;
    scopeContext: ScopeContext;
    executionTarget?: ExecutionTarget;
    networkActivityRequired?: boolean;
  }): Promise<RunPrerequisiteWarning[]> {
    const totalTargetsCount = params.scopeContext.targets.length;
    const verifiedTargetsCount = params.scopeContext.targets.filter((target) => target.verified).length;
    const cloudBlockedTargetValues = params.scopeContext.targets
      .filter((target) => target.verified && target.type === 'cidr' && isCloudBlockedIpv4CidrTarget(target.value))
      .map((target) => target.value);
    const normalizedGoal = normalizeGoal(params.goal);

    let assetsCount = 0;
    if (goalMatchesAnyHint(normalizedGoal, VULNERABILITY_GOAL_HINTS)) {
      const [assetCountRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(assets)
        .where(and(eq(assets.organizationId, params.orgId), eq(assets.scopeId, params.scopeId)));
      assetsCount = Number(assetCountRow?.count ?? 0);
    }

    const evaluation = evaluateRunPrerequisites({
      goal: normalizedGoal,
      totalTargetsCount,
      verifiedTargetsCount,
      assetsCount,
      executionTarget: params.executionTarget,
      cloudBlockedTargetValues,
      networkActivityRequired: params.networkActivityRequired,
      scopeTargets: params.scopeContext.targets,
    });

    if (evaluation.blockMessage) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        evaluation.blockMessage,
        {
          context: {
            scopeId: params.scopeId,
            goal: normalizedGoal,
            totalTargetsCount,
            verifiedTargetsCount,
            assetsCount,
            executionTarget: params.executionTarget ?? DEFAULT_EXECUTION_TARGET,
            cloudBlockedTargetValues,
            networkActivityRequired: params.networkActivityRequired ?? true,
          },
        },
      );
    }

    return evaluation.warnings;
  }
}
