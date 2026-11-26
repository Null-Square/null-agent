import {
  buildOmittedMissionObligationsMessage,
  findOmittedMissionObligations,
} from './missionObligations';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import {
  assets,
  findings,
  runEvents,
  runPhases,
  runValidationQueue,
  runs,
  scopes,
  scopeTargets,
  type RunPhaseReplanRow,
  type RunRow,
} from '@/db/schema';
import {
  normalizeMissionEnvelopeNodes,
  type MissionEnvelopeNode,
} from '@/domains/agent-brain/domain/workers/missionEnvelope';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { publishLiveEvent } from '@/app/adapters/events/liveEventBus';
import { extractRunTitleFromPlan, validateRunTitleFromPlan } from './planTitle';
import { RUN_REPLAN_BLOCKED_STATUSES } from './lifecyclePredicates';
import type { RunPhaseStatus } from './PhaseProfileRegistry';
import { RunPhaseRepository } from './RunPhaseRepository';
import { RunPhaseReplanRepository } from './RunPhaseReplanRepository';
import {
  ValidationQueueRepository,
  type ValidationQueueOutcome,
} from './ValidationQueueRepository';
import { resolveControlledExploitationCapabilitySnapshot } from './exploitationCapability';
import { shouldAutoApproveInitialPlan } from './runPlanApprovalPolicy';

/**
 * A run's status just moved, so every list showing it is now stale.
 *
 * The phase workflow writes `runs.status` directly instead of going through
 * `RunService.transitionStatusIfCurrent`, so these paths have to announce for
 * themselves. `awaiting_approval` matters most of the three: that is the agent
 * asking the customer for a decision, and it is the worst possible thing to
 * leave sitting behind a manual page refresh.
 */
const announceRunChanged = (run: Pick<RunRow, 'id' | 'organizationId' | 'scopeId'>): void => {
  publishLiveEvent(run.organizationId, {
    kind: 'run.changed',
    scopeId: run.scopeId,
    runId: run.id,
  });
};

export interface PhaseHandoffReconciliationEvent {
  runId: string;
  phaseId: string;
  phaseKey: string;
  accepted: string[];
  rejected: string[];
  injected: string[];
  replanned: boolean;
  reason?: string;
}

interface RunPhaseWorkflowServiceDeps {
  runPhaseRepository?: RunPhaseRepository;
  runPhaseReplanRepository?: RunPhaseReplanRepository;
  validationQueueRepository?: ValidationQueueRepository;
}

const normalizeAssignedSkillSlugs = (skillSlugs?: string[] | null): string[] | null => {
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

const resolveMissionEnvelopeNodes = (value: unknown): MissionEnvelopeNode[] => {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'missions' in value) {
    return normalizeMissionEnvelopeNodes((value as { missions?: unknown }).missions);
  }
  return normalizeMissionEnvelopeNodes(value);
};

const isReadyEarlierPhaseStatus = (status: string): boolean =>
  status === 'completed' ||
  status === 'blocked' ||
  status === 'failed' ||
  status === 'timed_out' ||
  status === 'aborted' ||
  status === 'handoff_submitted';

export class RunPhaseWorkflowService {
  private readonly runPhaseRepository: RunPhaseRepository;
  private readonly runPhaseReplanRepository: RunPhaseReplanRepository;
  private readonly validationQueueRepository: ValidationQueueRepository;

  constructor(
    private readonly db: DatabaseClient,
    deps: RunPhaseWorkflowServiceDeps = {},
  ) {
    this.runPhaseRepository = deps.runPhaseRepository ?? new RunPhaseRepository(this.db);
    this.runPhaseReplanRepository = deps.runPhaseReplanRepository ?? new RunPhaseReplanRepository(this.db);
    this.validationQueueRepository = deps.validationQueueRepository ?? new ValidationQueueRepository(this.db);
  }

  async markPlanningComplete(
    runId: string,
    plan: string,
    assignedSkillSlugs?: string[] | null,
    plannerSessionId?: string,
    missionEnvelope?: unknown | null,
  ): Promise<RunRow> {
    const trimmedPlan = plan.trim();
    if (!trimmedPlan) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'plan is required');
    }
    const titleValidationError = validateRunTitleFromPlan(trimmedPlan);
    if (titleValidationError) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, titleValidationError);
    }
    const nextTitle = extractRunTitleFromPlan(trimmedPlan);
    if (!nextTitle) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'run title could not be derived from plan');
    }

    const [run] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (!run) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Run not found');
    }
    if (!run.goal) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'submit_plan is only valid for goal-based runs');
    }
    if (run.executorSessionId && run.status !== 'system_paused' && run.status !== 'awaiting_approval') {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Planner handoff is already complete for this run');
    }
    if (plannerSessionId && run.plannerSessionId && run.plannerSessionId !== plannerSessionId) {
      throw new AppError(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, 'Planner session does not match the run planner session');
    }

    const hasPhaseHistory = await this.runPhaseRepository.hasSessionHistory(runId);
    const autoResumeReplan = hasPhaseHistory;
    if (autoResumeReplan && RUN_REPLAN_BLOCKED_STATUSES.has(run.status)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Cannot apply a revised phase plan to a run in terminal state "${run.status}".`,
      );
    }
    const autoApproveInitialPlan = !autoResumeReplan && shouldAutoApproveInitialPlan(run);
    const missionNodes = resolveMissionEnvelopeNodes(missionEnvelope);
    if (autoResumeReplan) {
      // D13 - the same rule `submit_plan` refuses with locally. This stays as the backstop
      // for any caller that reaches the workflow without going through the tool.
      const existingPhases = await this.runPhaseRepository.listByRunId(runId);
      const omittedMissionIds = findOmittedMissionObligations(
        existingPhases,
        missionNodes.map((mission) => mission.id),
      );
      if (omittedMissionIds.length > 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          buildOmittedMissionObligationsMessage(omittedMissionIds),
        );
      }
    }
    const nextStatus = autoResumeReplan || autoApproveInitialPlan ? 'running' : 'awaiting_approval';
    const now = new Date();
    const [updated] = await this.db
      .update(runs)
      .set({
        status: nextStatus,
        // The run title is derived from the plan's H1 on the initial planning pass only.
        // On resume/replan (autoResumeReplan) the planner can be re-engaged with a
        // "continue" nudge and re-submit a degenerate H1 (e.g. "Continue"), which would
        // otherwise overwrite the established assessment title and leak into the report
        // name. Preserve the existing title across resumes/replans.
        title: autoResumeReplan ? (run.title ?? nextTitle) : nextTitle,
        plan: trimmedPlan,
        missionEnvelope: missionEnvelope ?? null,
        assignedSkillSlugs: normalizeAssignedSkillSlugs(assignedSkillSlugs),
        updatedAt: now,
      })
      .where(eq(runs.id, runId))
      .returning();

    if (!updated) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Run not found');
    }

    await this.db.insert(runEvents).values([
      ...(autoApproveInitialPlan
        ? [{
            runId,
            type: 'plan_approved',
            note: JSON.stringify({
              source: 'auto',
              actor: run.userId,
              reason: 'auto_approve_on_planning',
            }),
          }]
        : []),
      {
        runId,
        type: nextStatus,
        note: autoResumeReplan ? 'planner_replan_applied' : 'planner_completed',
      },
    ]);

    const capability = resolveControlledExploitationCapabilitySnapshot({
      organizationId: run.organizationId,
    });
    const [scope] = await this.db
      .select({ impactTolerance: scopes.impactTolerance })
      .from(scopes)
      .where(eq(scopes.id, run.scopeId))
      .limit(1);
    const [verifiedTarget] = await this.db
      .select({ id: scopeTargets.id })
      .from(scopeTargets)
      .where(and(eq(scopeTargets.scopeId, run.scopeId), eq(scopeTargets.verified, true)))
      .limit(1);
    const mayInsertExploitation =
      capability.enabled &&
      run.trigger === 'manual' &&
      run.workflowDiscipline === 'pentest' &&
      scope?.impactTolerance !== 'non_destructive' &&
      Boolean(verifiedTarget);
    const admittedMissionNodes = mayInsertExploitation
      ? missionNodes
      : missionNodes.filter((mission) => mission.phase !== 'exploitation');
    if (hasPhaseHistory) {
      await this.runPhaseRepository.replaceFuturePlanPhases({
        runId,
        missions: admittedMissionNodes,
      });
      await this.runPhaseReplanRepository.markOpenForRunApplied(runId);
    } else {
      await this.runPhaseRepository.replacePlanPhases({
        runId,
        missions: admittedMissionNodes,
      });
    }

    announceRunChanged(updated);
    return updated;
  }

  async findNextReadyReportingPhase(runId: string) {
    return this.runPhaseRepository.findNextReadyPendingPhase({
      runId,
      phaseKey: 'reporting',
    });
  }

  async replaceRunPhasesForReportOnlyRun(params: {
    runId: string;
    missions: readonly MissionEnvelopeNode[];
  }) {
    return this.runPhaseRepository.replacePlanPhases({
      runId: params.runId,
      missions: params.missions,
    });
  }

  async findNextReadyValidationPhase(runId: string) {
    return this.runPhaseRepository.findNextReadyPendingPhase({
      runId,
      phaseKey: 'validation',
    });
  }

  async listRunningRunsReadyForPhaseStart(limit = 50): Promise<RunRow[]> {
    const activeRuns = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.status, 'running'),
          sql`exists (
            select 1 from ${runPhases}
            where ${runPhases.runId} = ${runs.id}
              and ${runPhases.status} = 'pending'
          )`,
          sql`not exists (
            select 1 from ${runPhases}
            where ${runPhases.runId} = ${runs.id}
              and ${runPhases.status} = 'active'
          )`,
        ),
      )
      .orderBy(desc(runs.updatedAt))
      .limit(Math.max(1, limit * 4));

    const readyRuns: RunRow[] = [];
    for (const run of activeRuns) {
      const phases = await this.runPhaseRepository.listByRunId(run.id);
      const ready = phases.some((phase) => {
        if (phase.status !== 'pending') {
          return false;
        }
        return phases
          .filter((candidate) => candidate.ordinal < phase.ordinal)
          .every((candidate) => isReadyEarlierPhaseStatus(candidate.status));
      });
      if (ready) {
        readyRuns.push(run);
      }
      if (readyRuns.length >= limit) {
        break;
      }
    }

    return readyRuns;
  }

  async markPhaseCompleted(phaseId: string) {
    return this.runPhaseRepository.updateStatus({ phaseId, status: 'completed' });
  }

  async skipControlledExploitationPhase(params: {
    runId: string;
    phaseId: string;
    reason: string;
  }) {
    const typedReason = `controlled_exploitation_skipped:${params.reason}`;
    const phase = await this.runPhaseRepository.updateStatus({
      phaseId: params.phaseId,
      status: 'completed',
      lastError: typedReason,
    });
    await this.db.insert(runEvents).values({
      runId: params.runId,
      type: 'exploitation_phase_skipped',
      note: JSON.stringify({
        schemaVersion: 1,
        phaseId: params.phaseId,
        decision: 'skipped',
        reason: params.reason,
      }),
    });
    return phase;
  }

  async listSameRunValidatedFindings(runId: string) {
    const rows = await this.db
      .select({
        findingId: findings.id,
        assetId: findings.assetId,
        assetKind: assets.kind,
        assetValue: assets.value,
        title: findings.title,
      })
      .from(runValidationQueue)
      .innerJoin(findings, eq(findings.id, runValidationQueue.findingId))
      .innerJoin(assets, eq(assets.id, findings.assetId))
      .where(and(
        eq(runValidationQueue.runId, runId),
        eq(runValidationQueue.status, 'validated'),
        eq(runValidationQueue.outcome, 'validated'),
        inArray(findings.state, ['confirmed', 'resolved', 'accepted']),
        eq(findings.sourceKind, 'assessment'),
      ));
    return rows
      .filter((row): row is typeof row & { assetId: string } => Boolean(row.assetId))
      .map((row) => ({ ...row, assetId: row.assetId }));
  }

  async updatePhaseAssignedSkills(phaseId: string, assignedSkillSlugs: readonly string[]) {
    return this.runPhaseRepository.updateAssignedSkillSlugs({ phaseId, assignedSkillSlugs });
  }

  async hasPhaseSessionHistory(runId: string): Promise<boolean> {
    return this.runPhaseRepository.hasSessionHistory(runId);
  }

  async requestPhaseReplan(params: {
    orgId: string;
    runId: string;
    phaseId: string;
    phaseStatus: Extract<RunPhaseStatus, 'completed' | 'blocked' | 'failed'>;
    handoffRef?: string | null;
    reason?: string | null;
  }): Promise<RunRow> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, params.runId), eq(runs.organizationId, params.orgId)))
      .limit(1);

    if (!run) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Run not found');
    }
    if (!run.goal) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Phase replanning requires a goal-based run');
    }
    if (!run.plannerSessionId) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Phase replanning requires the original planner session',
      );
    }
    if (RUN_REPLAN_BLOCKED_STATUSES.has(run.status)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Cannot request phase replanning for a run in terminal state "${run.status}".`,
      );
    }
    const updatedPhase = await this.runPhaseRepository.updateStatus({
      phaseId: params.phaseId,
      status: params.phaseStatus,
      ...(params.handoffRef !== undefined ? { handoffOutRef: params.handoffRef } : {}),
    });
    if (!updatedPhase) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Run phase not found');
    }

    const replan = await this.runPhaseReplanRepository.open({
      runId: params.runId,
      phaseId: params.phaseId,
      requestedPhaseStatus: params.phaseStatus,
      handoffRef: params.handoffRef ?? null,
      reason: params.reason ?? null,
    });
    if (!replan.created) {
      return run;
    }

    const now = new Date();
    const [updated] = await this.db
      .update(runs)
      .set({
        status: 'running',
        sessionId: run.plannerSessionId,
        executorSessionId: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(runs.id, params.runId))
      .returning();

    if (!updated) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Run not found');
    }

    await this.db.insert(runEvents).values({
      runId: params.runId,
      type: 'replan_pending',
      note: JSON.stringify({
        reason: 'phase_replan_requested',
        phaseId: params.phaseId,
        phaseStatus: params.phaseStatus,
        handoffRef: params.handoffRef ?? null,
        requestReason: params.reason ?? null,
      }),
    });

    announceRunChanged(updated);
    return updated;
  }

  async findNextReadyExecutionPhase(runId: string) {
    return this.runPhaseRepository.findNextReadyPendingPhaseIn({
      runId,
      phaseKeys: [
        'recon',
        'enumeration',
        'exploitation',
        'evidence',
        'control_assessment',
        'review_mapping',
        'review_analysis',
        'review_validation',
        'review_reporting',
      ],
    });
  }

  async findLatestPhaseHandoffBefore(runId: string, ordinal: number) {
    return this.runPhaseRepository.findLatestHandoffBefore({ runId, ordinal });
  }

  async listOpenValidationQueue(runId: string) {
    return this.validationQueueRepository.listOpenByRunId(runId);
  }

  async attachValidationQueueToPhase(params: {
    runId: string;
    phaseId: string;
    sessionId: string;
  }) {
    return this.validationQueueRepository.attachOpenQueueToPhase(params);
  }

  async completeValidationQueueFinding(params: {
    runId: string;
    findingId: string;
    outcome: ValidationQueueOutcome;
    sessionId?: string | null;
    resultRef?: string | null;
  }) {
    return this.validationQueueRepository.completeFinding(params);
  }

  async activatePhaseSession(params: {
    runId: string;
    phaseId: string;
    sessionId: string;
    handoffInRef?: string | null;
    previousPhaseId?: string | null;
    previousPhaseStatus?: Extract<RunPhaseStatus, 'completed' | 'blocked' | 'failed'>;
  }): Promise<RunRow> {
    const now = new Date();

    if (params.previousPhaseId && params.previousPhaseStatus) {
      await this.runPhaseRepository.updateStatus({
        phaseId: params.previousPhaseId,
        status: params.previousPhaseStatus,
      });
    }

    const activatedPhase = await this.runPhaseRepository.activatePhase({
      phaseId: params.phaseId,
      sessionId: params.sessionId,
      handoffInRef: params.handoffInRef,
    });
    if (!activatedPhase) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Phase is no longer pending or already has an active session for this run phase',
      );
    }

    const [updated] = await this.db
      .update(runs)
      .set({
        status: 'running',
        sessionId: params.sessionId,
        executorSessionId: params.sessionId,
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(runs.id, params.runId))
      .returning();

    if (!updated) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Run not found');
    }

    await this.db.insert(runEvents).values({
      runId: params.runId,
      type: 'running',
      note: 'phase_session_started',
    });

    announceRunChanged(updated);
    return updated;
  }

  async recordPhaseHandoffReconciliation(event: PhaseHandoffReconciliationEvent): Promise<void> {
    await this.db.insert(runEvents).values({
      runId: event.runId,
      type: 'phase_handoff_reconciliation',
      note: JSON.stringify({
        phaseId: event.phaseId,
        phaseKey: event.phaseKey,
        accepted: event.accepted,
        rejected: event.rejected,
        injected: event.injected,
        replanned: event.replanned,
        ...(event.reason ? { reason: event.reason } : {}),
      }),
    });
  }

  async hasAppliedPhaseReplan(params: { runId: string; phaseId: string }): Promise<boolean> {
    return this.runPhaseReplanRepository.hasApplied(params);
  }

  async hasOpenPhaseReplan(params: { runId: string; phaseId: string }): Promise<boolean> {
    return this.runPhaseReplanRepository.hasOpen(params);
  }

  async findOpenPhaseReplan(params: { runId: string; phaseId: string }): Promise<RunPhaseReplanRow | null> {
    return this.runPhaseReplanRepository.findOpen(params);
  }

}
