import { phaseProfileRegistry } from '@/domains/security-ops/runs/PhaseProfileRegistry';
import { sha256Hex } from '@/shared/utils/hash';
import { syncAssignedSkillsIntoWorkspace } from '@/domains/security-ops/runs/skillWorkspaceSync';
import { logger } from '@/shared/logger';
import { v4 as uuidv4 } from 'uuid';
import { MemoryManager } from '../../domain/helpers/MemoryManager';
import type {
  SessionFlags,
  SessionState,
  Message,
  ToolAccessPolicy,
  WorkerResultArtifact,
  WorkerTaskBudget,
  WorkerTaskRecord,
  WorkerToolPreflightEntry,
} from '../../domain/types';
import { parseAssignedSkillsFromExtraContext } from '../../domain/workers/delegationActivation';
import {
  deriveWorkerTaskStatus,
  getWorkerTemplate,
  isWorkerSession,
  resolveWorkerExecutableTools,
  type WorkerTemplate,
} from '../../domain/workers/workerContracts';
import {
  computeEnumerationMissionFingerprint,
  enumerationArtifactRootForTask,
  ENUMERATION_RESULT_ARTIFACT_TYPE,
  isEnumerationMissionEnvelope,
  resolveEnumerationContinuationAdmission,
  resolveEnumerationInfrastructureRetryAdmission,
} from '../../domain/workers/enumerationContracts';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { SessionStore } from '../core/SessionStore';
import { stopProcessing } from '../orchestration/utils/sessionProcessing';
import { ToolPolicyChecker } from '../tools/ToolPolicyChecker';
import {
  enumerationWorkerAdmissionTotal,
  skillToolCompatibilityRejectionTotal,
} from '@/shared/metrics/prometheusMetrics';
import { getEnumerationWorkerAdmissionState } from '@/domains/security-ops/runs/enumerationCapability';
import { getControlledExploitationAdmissionState } from '@/domains/security-ops/runs/exploitationCapability';
import { isValidIpv4Cidr } from '@/domains/security-ops/scopes/networkTargetPolicy';
import {
  decideScopeTargetRef,
  type ScopeNamespaceRule,
} from '@/domains/security-ops/scopes/scopeBoundaryPolicy';
import {
  evaluateAttackWorkerAdmission,
  type ControlledExploitationValidatedFinding,
} from '@/domains/security-ops/runs/controlledExploitationAdmission';
import { EnumerationWorkerSkillResolver } from '@/domains/security-ops/skills/EnumerationWorkerSkillResolver';

import type {
  ContinueWorkerInput,
  RuntimeDeps,
  SharedStateSyncResult,
  SpawnWorkerInput,
  StopWorkerInput,
  WaitForWorkerInput,
  WorkerTaskOperationResult,
} from './worker/WorkerDelegationShared';
import {
  PARENT_CONTINUATION_TASK_STATUSES,
  DEFAULT_WAIT_TIMEOUT_MS,
  EMPTY_SHARED_STATE_SYNC,
  LIVE_WORKER_TASK_STATUSES,
  MAX_WAIT_TIMEOUT_MS,
  MISSING_FINDING_SUBMISSION_WARNING,
  TERMINAL_WORKER_TASK_STATUSES,
  WAIT_POLL_INTERVAL_MS,
  WORKER_PARENT_POLICY_REASON,
  WORKSPACE_PREFIX,
  asWorkspaceRelativePath,
  buildFallbackArtifact,
  buildParentContinuationPrompt,
  buildWorkerContinuationPrompt,
  buildWorkerExtraContext,
  buildWorkerKickoffPrompt,
  buildWorkerToolPreflight,
  clampConfidence,
  cloneArtifact,
  cloneFlags,
  cloneMemory,
  cloneTask,
  compactText,
  formatBlockedReason,
  getActivePhaseKey,
  getPhaseAssignedSkillSlugs,
  getReportedFindingIds,
  inferSharedStateCandidates,
  isConfirmedValidationArtifact,
  normalizeWaveIndex,
  now,
  sleep,
  unique,
  uniqueSkillSlugs,
  workerSkillLoader,
} from './worker/WorkerDelegationShared';
import { WorkerPolicyResolver } from './worker/WorkerPolicyResolver';

export type {
  ContinueWorkerInput,
  RuntimeDeps,
  SharedStateCandidate,
  SharedStateSyncResult,
  SpawnWorkerInput,
  StopWorkerInput,
  WaitForWorkerInput,
  WorkerTaskOperationResult,
} from './worker/WorkerDelegationShared';

export type WorkerCapacityCoordinator = {
  acquireWorkerCapacity(params: {
    runId: string;
    workerTaskId: string;
  }): Promise<
    { admitted: true; leaseId: string | null; includedInBundle: boolean } | { admitted: false; reason: string }
  >;
  releaseWorkerCapacity(params: { runId: string; workerTaskId: string; reason: string }): Promise<void>;
};

/**
 * Resolve a concrete enumeration mission against the verified scope roots.
 *
 * Scope authorization flows downward: an authorized domain covers that name
 * and its descendants, while a subdomain never authorizes a parent or sibling.
 * CIDR roots cover contained IPv4 mission targets.  This deliberately ignores
 * URL paths, schemes, and ports because those are mission-level constraints,
 * not separate customer authorization grants.
 */
export const isEnumerationTargetAuthorized = (
  candidateTargetRef: string,
  authorizedTargetRef: string,
  exclusions: ScopeNamespaceRule[] = [],
): boolean => decideScopeTargetRef({
  targetRef: candidateTargetRef,
  roots: [{
    type: isValidIpv4Cidr(authorizedTargetRef.trim()) ? 'cidr' : 'domain',
    value: authorizedTargetRef,
  }],
  exclusions,
}).allowed;

export class WorkerDelegationService {
  private readonly log = logger.child({ scope: 'WorkerDelegationService' });
  private readonly policyResolver: WorkerPolicyResolver;
  private readonly enumerationSkillResolver = new EnumerationWorkerSkillResolver();
  private readonly activeWorkerTaskLoops = new Map<string, Promise<WorkerTaskRecord>>();
  private runtime?: RuntimeDeps;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly policyChecker: ToolPolicyChecker = new ToolPolicyChecker(),
    private readonly traceRecorder?: SessionTraceRecorder,
    private readonly capacityCoordinator?: WorkerCapacityCoordinator,
  ) {
    this.policyResolver = new WorkerPolicyResolver(this.sessionStore, this.policyChecker);
  }

  bindRuntime(runtime: RuntimeDeps): void {
    this.runtime = runtime;
  }

  listWorkerTasks(parentSessionId: string): WorkerTaskRecord[] {
    const session = this.sessionStore.get(parentSessionId);
    return Array.isArray(session?.workerTasks) ? session.workerTasks.map(cloneTask) : [];
  }

  async syncWorkerTasks(parentSessionId: string): Promise<WorkerTaskRecord[]> {
    const tasks = this.listWorkerTasks(parentSessionId);
    const synced: WorkerTaskRecord[] = [];
    for (const task of tasks) {
      try {
        synced.push(await this.syncWorkerState(parentSessionId, task.taskId));
      } catch (error) {
        this.log.warn(
          {
            err: error,
            parentSessionId,
            taskId: task.taskId,
            workerSessionId: task.workerSessionId,
          },
          'Failed to sync worker task state before lifecycle decision',
        );
        synced.push(task);
      }
    }
    return synced;
  }

  private isLiveWorkerTask(task: WorkerTaskRecord): boolean {
    return LIVE_WORKER_TASK_STATUSES.has(task.status);
  }

  private isLiveSidecarTask(task: WorkerTaskRecord): boolean {
    return (
      this.isLiveWorkerTask(task) &&
      task.executionMode === 'background' &&
      (task.dependencyMode ?? 'sidecar') === 'sidecar'
    );
  }

  async waitForWorker(input: WaitForWorkerInput): Promise<WorkerTaskOperationResult> {
    const timeoutMs = Math.max(
      1_000,
      Math.min(Math.trunc(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS), MAX_WAIT_TIMEOUT_MS),
    );
    const taskId = typeof input.taskId === 'string' && input.taskId.trim().length > 0 ? input.taskId.trim() : undefined;
    if (!taskId) {
      return this.waitForAnyWorkerEvent(input.parentSessionId, timeoutMs, input.signal);
    }

    const startedAt = now();
    await this.syncWorkerTasks(input.parentSessionId);
    let baseline = this.requireParentTask(input.parentSessionId, taskId);

    if (this.isWorkerTaskSettled(baseline)) {
      return {
        task: baseline,
        artifact: baseline.artifact ? cloneArtifact(baseline.artifact) : undefined,
        sessionId: baseline.workerSessionId,
      };
    }

    await this.writeTrace(
      input.parentSessionId,
      this.requireSession(input.parentSessionId).turn ?? 0,
      'worker.task.wait_started',
      this.buildTaskTracePayload(baseline, {
        timeoutMs,
      }),
      `waiting for worker task ${baseline.taskId}`,
    );

    while (now() - startedAt < timeoutMs) {
      if (input.signal?.aborted) {
        throw new Error('wait_aborted');
      }

      const current = await this.syncWorkerState(input.parentSessionId, taskId);
      if (this.didWorkerObservableStateChange(baseline, current) || this.isWorkerTaskSettled(current)) {
        await this.writeTrace(
          input.parentSessionId,
          this.requireSession(input.parentSessionId).turn ?? 0,
          'worker.task.wait_finished',
          this.buildTaskTracePayload(current, {
            waitedMs: now() - startedAt,
          }),
          `worker wait finished for ${current.taskId}`,
        );
        return {
          task: current,
          artifact: current.artifact ? cloneArtifact(current.artifact) : undefined,
          sessionId: current.workerSessionId,
        };
      }

      baseline = current;
      await sleep(WAIT_POLL_INTERVAL_MS, input.signal);
    }

    const timedOutTask = await this.syncWorkerState(input.parentSessionId, taskId);
    await this.writeTrace(
      input.parentSessionId,
      this.requireSession(input.parentSessionId).turn ?? 0,
      'worker.task.wait_timed_out',
      this.buildTaskTracePayload(timedOutTask, {
        timeoutMs,
      }),
      `worker wait timed out for ${timedOutTask.taskId}`,
      'warn',
    );

    return {
      task: timedOutTask,
      artifact: timedOutTask.artifact ? cloneArtifact(timedOutTask.artifact) : undefined,
      sessionId: timedOutTask.workerSessionId,
    };
  }

  private async waitForAnyWorkerEvent(
    parentSessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WorkerTaskOperationResult> {
    const startedAt = now();
    const syncedInitialTasks = await this.syncWorkerTasks(parentSessionId);
    const initialTasks = syncedInitialTasks.filter((task) => this.isLiveWorkerTask(task));
    if (initialTasks.length === 0) {
      const settledTask = syncedInitialTasks.find((task) => this.isWorkerTaskSettled(task));
      if (settledTask) {
        return {
          task: settledTask,
          artifact: settledTask.artifact ? cloneArtifact(settledTask.artifact) : undefined,
          sessionId: settledTask.workerSessionId,
        };
      }
      throw new Error('wait_for_worker requires at least one active worker when taskId is omitted.');
    }

    const baselineByTaskId = new Map(initialTasks.map((task) => [task.taskId, task]));
    await this.writeTrace(
      parentSessionId,
      this.requireSession(parentSessionId).turn ?? 0,
      'worker.tasks.wait_started',
      {
        waitMode: 'any',
        timeoutMs,
        taskIds: initialTasks.map((task) => task.taskId),
        liveWorkerCount: initialTasks.length,
      },
      'waiting for any active worker to change state',
    );

    while (now() - startedAt < timeoutMs) {
      if (signal?.aborted) {
        throw new Error('wait_aborted');
      }

      const currentTasks = await this.syncWorkerTasks(parentSessionId);
      const currentByTaskId = new Map(currentTasks.map((task) => [task.taskId, task]));

      for (const [trackedTaskId, baselineTask] of baselineByTaskId.entries()) {
        const current = currentByTaskId.get(trackedTaskId) ?? baselineTask;
        if (this.didWorkerObservableStateChange(baselineTask, current) || this.isWorkerTaskSettled(current)) {
          await this.writeTrace(
            parentSessionId,
            this.requireSession(parentSessionId).turn ?? 0,
            'worker.tasks.wait_finished',
            this.buildTaskTracePayload(current, {
              waitMode: 'any',
              waitedMs: now() - startedAt,
              observedTaskId: current.taskId,
            }),
            `worker wait finished after ${current.taskId} changed state`,
          );
          return {
            task: current,
            artifact: current.artifact ? cloneArtifact(current.artifact) : undefined,
            sessionId: current.workerSessionId,
          };
        }
        baselineByTaskId.set(trackedTaskId, current);
      }

      await sleep(WAIT_POLL_INTERVAL_MS, signal);
    }

    const latestTasks = await this.syncWorkerTasks(parentSessionId);
    const timeoutFallbackTask =
      latestTasks.find((task) => baselineByTaskId.has(task.taskId)) ?? Array.from(baselineByTaskId.values())[0];
    await this.writeTrace(
      parentSessionId,
      this.requireSession(parentSessionId).turn ?? 0,
      'worker.tasks.wait_timed_out',
      this.buildTaskTracePayload(timeoutFallbackTask, {
        waitMode: 'any',
        timeoutMs,
        trackedTaskIds: Array.from(baselineByTaskId.keys()),
      }),
      'worker wait timed out without any active worker state change',
      'warn',
    );

    return {
      task: timeoutFallbackTask,
      artifact: timeoutFallbackTask.artifact ? cloneArtifact(timeoutFallbackTask.artifact) : undefined,
      sessionId: timeoutFallbackTask.workerSessionId,
    };
  }

  async spawnWorker(input: SpawnWorkerInput): Promise<WorkerTaskOperationResult> {
    const runtime = this.requireRuntime();
    const parentSession = this.requireSession(input.parentSessionId);
    if (isWorkerSession(parentSession)) {
      throw new Error('Recursive delegation is not allowed for worker sessions.');
    }

    const template = getWorkerTemplate(input.workerType);
    this.policyResolver.assertPhaseWorkerAllowed(parentSession, input.workerType, input.mission);
    const planStepId = this.policyResolver.resolveLinkedPlanStepId(parentSession, input.planStepId);
    if (input.workerType === 'enumeration_worker') {
      this.assertEnumerationSpawnEnvelope(parentSession, input, planStepId);
    }
    if (input.workerType === 'attack_worker') {
      this.assertAttackSpawnEnvelope(parentSession, input, planStepId);
    }
    const taskId = uuidv4();
    const enumerationWriteScope =
      input.workerType === 'enumeration_worker' ? enumerationArtifactRootForTask(taskId) : undefined;
    const attackWriteScope =
      input.workerType === 'attack_worker' ? `/workspace/.artifacts/workers/attack/${taskId}` : undefined;
    if (
      enumerationWriteScope &&
      Array.isArray(input.writeScope) &&
      input.writeScope.length > 0 &&
      (input.writeScope.length !== 1 ||
        input.writeScope[0].trim().replace(/\\/gu, '/').replace(/\/+$/u, '') !== enumerationWriteScope)
    ) {
      throw new Error(
        `enumeration_worker artifact_scope_mismatch: writeScope is server-assigned as ${enumerationWriteScope}`,
      );
    }
    if (
      attackWriteScope &&
      Array.isArray(input.writeScope) &&
      input.writeScope.length > 0 &&
      (input.writeScope.length !== 1 ||
        input.writeScope[0].trim().replace(/\\/gu, '/').replace(/\/+$/u, '') !== attackWriteScope)
    ) {
      throw new Error(`attack_worker artifact_scope_mismatch: writeScope is server-assigned as ${attackWriteScope}`);
    }
    const requestedWriteScope =
      enumerationWriteScope || attackWriteScope
        ? [enumerationWriteScope ?? attackWriteScope!]
        : Array.isArray(input.writeScope) && input.writeScope.length > 0
          ? input.writeScope
          : input.workerType === 'compliance_control_worker'
            ? ['/workspace/.artifacts/phases/control_assessment']
            : [];
    const normalizedWriteScope =
      requestedWriteScope.length > 0
        ? Array.from(
            new Set(
              requestedWriteScope
                .filter((value): value is string => typeof value === 'string')
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            ),
          )
        : [];
    const toolResolution = resolveWorkerExecutableTools(template.allowedTools, normalizedWriteScope);
    const allowedTools =
      input.workerType === 'attack_worker'
        ? toolResolution.executableTools
        : this.policyResolver.getAllowedWorkerTools(parentSession.toolPolicy, toolResolution.executableTools);
    if (allowedTools.length === 0) {
      throw new Error(
        `Worker ${input.workerType} cannot be started because no allowed tools remain after policy narrowing.`,
      );
    }
    const parentPolicyWithheldTools = toolResolution.executableTools
      .filter((tool) => !allowedTools.includes(tool))
      .map<WorkerToolPreflightEntry>((tool) => ({
        tool,
        reason: WORKER_PARENT_POLICY_REASON,
      }));
    const toolPreflight = buildWorkerToolPreflight(allowedTools, allowedTools, [
      ...toolResolution.withheldTools,
      ...parentPolicyWithheldTools,
    ]);

    const workerToolPolicy = this.policyResolver.buildWorkerPolicy(parentSession.toolPolicy, allowedTools);
    const executionMode = input.executionMode ?? 'background';
    const dependencyMode =
      input.dependencyMode ?? (executionMode === 'blocking' ? 'dependency' : template.preferredDependencyMode);
    const budget =
      input.workerType === 'enumeration_worker' && input.mission?.enumeration
        ? { ...input.mission.enumeration.budgets }
        : input.workerType === 'attack_worker' && input.mission?.attack
          ? {
              maxToolCalls: input.mission.attack.toolBudget,
              maxTargetRequests: input.mission.attack.requestBudget,
              maxRequestConcurrency: input.mission.attack.maxRequestConcurrency,
              maxWallSeconds: input.mission.attack.timeBudgetSeconds,
            }
          : this.resolveBudget(template, input.budget);
    const taskRecord: WorkerTaskRecord = {
      taskId,
      parentSessionId: parentSession.id,
      workerSessionId: '',
      workerType: input.workerType,
      status: 'pending',
      ...(planStepId ? { planStepId } : {}),
      ...(input.mission ? { mission: input.mission } : {}),
      reason: input.reason.trim(),
      task: input.task.trim(),
      expectedArtifactType: input.expectedArtifactType?.trim() || template.defaultArtifactType,
      executionMode,
      dependencyMode,
      continuationMode: input.continuationMode ?? 'spawn',
      ...(normalizedWriteScope.length > 0 ? { writeScope: normalizedWriteScope } : {}),
      toolPolicy: workerToolPolicy,
      toolPreflight,
      ...(budget ? { budget } : {}),
      ...(input.workerType === 'enumeration_worker' || input.workerType === 'attack_worker'
        ? {
            continuationCount: 0,
            retryIndex: 0,
            targetRequestsUsed: 0,
            deadlineAt: now() + (budget?.maxWallSeconds ?? (input.workerType === 'attack_worker' ? 600 : 360)) * 1_000,
            ...(input.workerType === 'attack_worker'
              ? {
                  lastStatusReason: 'controlled_exploitation_admitted',
                }
              : {}),
            ...(getEnumerationWorkerAdmissionState(parentSession.flags).snapshot &&
            input.workerType === 'enumeration_worker'
              ? {
                  enumerationCapability: getEnumerationWorkerAdmissionState(parentSession.flags).snapshot,
                }
              : {}),
          }
        : {}),
      createdAt: now(),
      lastUpdatedAt: now(),
    };
    const runId = this.resolveSecurityOpsRunId(parentSession);
    let capacityAcquired = false;
    let capacityLeaseId: string | null = null;
    const enumerationFingerprint = taskRecord.mission?.enumeration?.missionFingerprint;
    try {
      if (runId && this.capacityCoordinator) {
        const capacity = await this.capacityCoordinator.acquireWorkerCapacity({
          runId,
          workerTaskId: taskId,
        });
        if (!capacity.admitted) {
          throw new Error(
            `${capacity.reason}: wait for an active worker to finish, then issue a new spawn_worker call`,
          );
        }
        capacityAcquired = true;
        capacityLeaseId = capacity.leaseId;
      }
      const workerSkillSlugs = await this.resolveWorkerSkillSlugs(parentSession, taskRecord, workerToolPolicy);
      const childFlags = this.cloneInheritedFlags(parentSession.flags);
      const childSecurityOps =
        childFlags.securityops && typeof childFlags.securityops === 'object'
          ? (childFlags.securityops as Record<string, unknown>)
          : undefined;
      if (childSecurityOps) {
        childFlags.securityops = {
          ...childSecurityOps,
          phaseAssignedSkillSlugs: workerSkillSlugs,
        };
      }
      const scopedChildSecurityOps =
        childFlags.securityops && typeof childFlags.securityops === 'object'
          ? (childFlags.securityops as Record<string, unknown>)
          : undefined;
      const inheritedAdmission =
        scopedChildSecurityOps?.cloudAdmission && typeof scopedChildSecurityOps.cloudAdmission === 'object'
          ? (scopedChildSecurityOps.cloudAdmission as Record<string, unknown>)
          : undefined;
      if (scopedChildSecurityOps && inheritedAdmission) {
        childFlags.securityops = {
          ...scopedChildSecurityOps,
          cloudAdmission: {
            ...inheritedAdmission,
            ...(capacityLeaseId ? { leaseId: capacityLeaseId } : {}),
            workerTaskId: taskId,
          },
        };
      }
      const childPromptProfile =
        input.workerType === 'compliance_control_worker' ||
        (childFlags.securityops as Record<string, unknown> | undefined)?.workflowDiscipline === 'compliance'
          ? 'phase-control-assessment'
          : 'executor';

      if (input.workerType === 'enumeration_worker' && enumerationFingerprint) {
        await this.reserveEnumerationMissionFingerprint(parentSession.id, enumerationFingerprint, taskId);
      }
      const childSession = await this.sessionStore.create({
        userId: parentSession.userId,
        profileKey: parentSession.profileKey,
        extraContext: buildWorkerExtraContext(parentSession, taskRecord, template),
        flags: childFlags,
        scopeId: parentSession.scopeId,
        agentType: 'executor',
        promptProfile: childPromptProfile,
        toolPolicy: workerToolPolicy,
        mode: 'automated',
        executionMode: template.executionMode,
        coordination: {
          role: 'worker',
          parentSessionId: parentSession.id,
          parentTaskId: taskId,
          workerType: input.workerType,
          expectedArtifactType: taskRecord.expectedArtifactType,
          writeScope: taskRecord.writeScope,
          executionMode,
          dependencyMode,
          continuationMode: taskRecord.continuationMode,
          maxToolCalls: budget?.maxToolCalls,
          maxTargetRequests: budget?.maxTargetRequests,
          targetRequestsUsed: 0,
          maxRequestConcurrency: budget?.maxRequestConcurrency,
          activeTargetRequests: 0,
          deadlineAt: taskRecord.deadlineAt,
        },
        modelName: parentSession.modelName,
        modelContextWindow: parentSession.modelContextWindow,
        modelMaxOutputTokens: parentSession.modelMaxOutputTokens,
        sandboxProfile: parentSession.sandboxProfile,
        sandboxImage: parentSession.sandboxImage,
        task: {
          id: taskId,
          title: `${template.label}: ${input.reason.trim()}`,
          category: 'worker',
          summary: input.reason.trim(),
          vars: {
            parentSessionId: parentSession.id,
            workerType: input.workerType,
            expectedArtifactType: taskRecord.expectedArtifactType,
            ...(taskRecord.mission ? { mission: taskRecord.mission } : {}),
            ...(planStepId ? { planStepId } : {}),
          },
          starterPrompt: buildWorkerKickoffPrompt(taskRecord, template),
        },
      });

      taskRecord.workerSessionId = childSession.id;
      taskRecord.status = 'running';
      taskRecord.startedAt = now();
      taskRecord.lastUpdatedAt = now();

      // Classify which delegation wave this spawn belongs to. The opening wave is
      // every spawn issued before any prior worker has settled. Once a later wave
      // starts, additional spawns in that same still-running wave should keep the
      // same wave index instead of jumping by the number of settled workers.
      const priorTasks = Array.isArray(parentSession.workerTasks) ? parentSession.workerTasks : [];
      const priorSettled = priorTasks.filter(
        (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
      ).length;
      const priorRunning = priorTasks.filter((t) => t.status === 'running' || t.status === 'pending').length;
      const isOpeningWave = priorSettled === 0;
      const maxRecordedWaveIndex = priorTasks.reduce(
        (max, task) => Math.max(max, normalizeWaveIndex(task.waveIndex)),
        0,
      );
      const maxRunningWaveIndex = priorTasks
        .filter((task) => task.status === 'running' || task.status === 'pending')
        .reduce<number | undefined>((max, task) => {
          const index = normalizeWaveIndex(task.waveIndex);
          return max === undefined ? index : Math.max(max, index);
        }, undefined);
      const maxSettledWaveIndex = priorTasks
        .filter((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
        .reduce<number | undefined>((max, task) => {
          const index = normalizeWaveIndex(task.waveIndex);
          return max === undefined ? index : Math.max(max, index);
        }, undefined);
      const waveIndex = isOpeningWave
        ? 0
        : maxRunningWaveIndex !== undefined && maxRunningWaveIndex > (maxSettledWaveIndex ?? -1)
          ? maxRunningWaveIndex
          : maxRecordedWaveIndex + 1;
      taskRecord.waveIndex = waveIndex;
      const waveContext = {
        waveIndex,
        openingWave: isOpeningWave,
        priorSettledWorkers: priorSettled,
        priorRunningWorkers: priorRunning,
        concurrentWorkerCount: priorRunning + 1,
        executionMode,
        dependencyMode,
      };

      const workspaceSync = await this.prepareSharedWorkerWorkspace(childSession, workerSkillSlugs);
      await runtime.agentEngine.initializeSession({
        session: childSession,
        sandboxImage: childSession.sandboxImage,
      });

      await this.upsertParentTask(parentSession.id, taskRecord);
      await this.writeTrace(
        parentSession.id,
        parentSession.turn ?? 0,
        'worker.task.spawned',
        this.buildTaskTracePayload(taskRecord, {
          childSessionId: childSession.id,
          parentSessionId: parentSession.id,
          waveContext,
        }),
        `spawned ${taskRecord.workerType} task ${taskRecord.taskId} (wave ${waveIndex}${isOpeningWave ? ', opening' : ''})`,
      );
      await this.writeTrace(
        parentSession.id,
        parentSession.turn ?? 0,
        'worker.wave.spawned',
        {
          taskId: taskRecord.taskId,
          workerType: taskRecord.workerType,
          parentSessionId: parentSession.id,
          ...waveContext,
        },
        `wave ${waveIndex}: ${taskRecord.workerType}${isOpeningWave ? ' (opening)' : ''} — concurrent=${waveContext.concurrentWorkerCount}`,
        'debug',
      );
      await this.writeTrace(
        childSession.id,
        childSession.turn ?? 0,
        'worker.session.started',
        this.buildTaskTracePayload(taskRecord, {
          childSessionId: childSession.id,
          parentSessionId: parentSession.id,
          inheritedSkills: workspaceSync.syncedSkillSlugs,
          inheritedSkillVersions: workspaceSync.syncedSkills,
          credentialsInherited: workspaceSync.credentialsInherited,
        }),
        `worker session started for ${taskRecord.workerType}`,
      );

      if (executionMode === 'background') {
        void this.runWorkerTaskLoop(taskRecord, buildWorkerKickoffPrompt(taskRecord, template)).catch((error) =>
          this.handleBackgroundWorkerFailure(parentSession.id, taskId, error),
        );
        return {
          task: cloneTask(taskRecord),
          sessionId: childSession.id,
        };
      }

      const syncedTask = await this.runWorkerTaskLoop(taskRecord, buildWorkerKickoffPrompt(taskRecord, template));
      return {
        task: syncedTask,
        artifact: syncedTask.artifact ? cloneArtifact(syncedTask.artifact) : undefined,
        sessionId: childSession.id,
      };
    } finally {
      await this.releaseEnumerationMissionReservation(parentSession.id, enumerationFingerprint, taskId);
      if (
        capacityAcquired &&
        runId &&
        !(this.sessionStore.get(parentSession.id)?.workerTasks ?? []).some((task) => task.taskId === taskId)
      ) {
        await this.capacityCoordinator
          ?.releaseWorkerCapacity({
            runId,
            workerTaskId: taskId,
            reason: 'worker_spawn_failed',
          })
          .catch((error) => {
            this.log.error({ err: error, runId, taskId }, 'Failed to release worker capacity after spawn failure');
          });
      }
    }
  }

  async continueWorker(input: ContinueWorkerInput): Promise<WorkerTaskOperationResult> {
    this.requireRuntime();
    let task = await this.syncWorkerState(input.parentSessionId, input.taskId);
    const childSession = this.requireSession(task.workerSessionId);

    if (childSession.stateMachine?.isProcessing()) {
      const synced = await this.syncWorkerState(input.parentSessionId, task.taskId);
      return {
        task: synced,
        artifact: synced.artifact ? cloneArtifact(synced.artifact) : undefined,
        sessionId: task.workerSessionId,
      };
    }

    if (task.status === 'completed' || task.status === 'cancelled') {
      return {
        task: cloneTask(task),
        artifact: task.artifact ? cloneArtifact(task.artifact) : undefined,
        sessionId: task.workerSessionId,
      };
    }

    const instruction =
      typeof input.instruction === 'string' && input.instruction.trim().length > 0 ? input.instruction.trim() : '';
    if (task.workerType === 'enumeration_worker') {
      if (task.status === 'failed') {
        throw new Error('enumeration_worker continuation_terminal_failure');
      }
      if ((task.continuationCount ?? 0) >= 1) {
        throw new Error('enumeration_worker continuation_limit_reached');
      }
      if (!instruction) {
        throw new Error(
          'enumeration_worker continuation_requires a resolved prerequisite, narrowed technique, or bounded hypothesis',
        );
      }
      const continuationAdmission = resolveEnumerationContinuationAdmission(task, now());
      if (!continuationAdmission.allowed) {
        throw new Error(`enumeration_worker continuation_${continuationAdmission.reason ?? 'denied'}`);
      }
      task = await this.updateParentTask(input.parentSessionId, task.taskId, (record) => {
        record.continuationCount = (record.continuationCount ?? 0) + 1;
        record.continuationMode = 'continue';
        record.lastUpdatedAt = now();
        return record;
      });
    }
    await this.writeTrace(
      input.parentSessionId,
      this.requireSession(input.parentSessionId).turn ?? 0,
      'worker.task.continue_requested',
      this.buildTaskTracePayload(task, {
        instructionLength: instruction.length,
        ...(task.workerType === 'enumeration_worker'
          ? {
              remainingTargetRequests: (task.budget?.maxTargetRequests ?? 0) - (task.targetRequestsUsed ?? 0),
              remainingWallMs: (task.deadlineAt ?? 0) - now(),
              priorAttemptCount: task.enumerationAttempts?.length ?? 0,
            }
          : {}),
      }),
      `continue requested for ${task.taskId}`,
    );
    const continuationPrompt =
      task.workerType === 'enumeration_worker'
        ? buildWorkerContinuationPrompt(task, instruction)
        : instruction || buildWorkerContinuationPrompt(task);
    if (task.executionMode === 'background') {
      void this.runWorkerTaskLoop(task, continuationPrompt).catch((error) =>
        this.handleBackgroundWorkerFailure(input.parentSessionId, task.taskId, error),
      );
      return {
        task: task,
        artifact: task.artifact ? cloneArtifact(task.artifact) : undefined,
        sessionId: task.workerSessionId,
      };
    }

    const syncedTask = await this.runWorkerTaskLoop(task, continuationPrompt);
    return {
      task: syncedTask,
      artifact: syncedTask.artifact ? cloneArtifact(syncedTask.artifact) : undefined,
      sessionId: task.workerSessionId,
    };
  }

  async stopWorker(input: StopWorkerInput): Promise<WorkerTaskOperationResult> {
    const task = await this.syncWorkerState(input.parentSessionId, input.taskId);
    const childSession = this.requireSession(task.workerSessionId);

    if (TERMINAL_WORKER_TASK_STATUSES.has(task.status)) {
      return {
        task,
        artifact: task.artifact ? cloneArtifact(task.artifact) : undefined,
        sessionId: task.workerSessionId,
      };
    }

    if (childSession.stateMachine?.isProcessing()) {
      await this.sessionStore.abortCurrentTurnAsync(childSession.id, input.reason ?? 'worker_cancelled');
    }

    const liveChild = this.requireSession(childSession.id);
    const wasProcessing = liveChild.stateMachine?.isProcessing() ?? false;
    let cancelledEnumerationAttempts = liveChild.coordination?.enumerationAttempts;
    if (task.workerType === 'enumeration_worker' && liveChild.coordination?.role === 'worker') {
      const cancelledAt = now();
      const attempts = [...(liveChild.coordination.enumerationAttempts ?? [])];
      const seenFingerprints = new Set(attempts.map((attempt) => attempt.reservationFingerprint));
      for (const reservation of Object.values(liveChild.coordination.enumerationAttemptReservations ?? {})) {
        if (!seenFingerprints.has(reservation.reservationFingerprint)) {
          attempts.push({
            ...reservation,
            status: 'failed',
            completedAt: cancelledAt,
          });
          seenFingerprints.add(reservation.reservationFingerprint);
        }
      }
      liveChild.coordination.enumerationAttempts = attempts;
      delete liveChild.coordination.enumerationAttemptReservations;
      liveChild.coordination.activeTargetRequests = 0;
      liveChild.blockedReason = 'worker_cancelled';
      cancelledEnumerationAttempts = attempts;
    }
    if (wasProcessing) {
      liveChild.blockedReason = 'worker_cancelled';
      stopProcessing(liveChild, {
        reason: 'worker_cancelled',
        turnNumber: liveChild.turn,
        caller: 'WorkerDelegationService',
      });
    }
    if (wasProcessing || task.workerType === 'enumeration_worker') {
      await this.sessionStore.setAsync(liveChild.id, liveChild, 'worker_cancelled');
    }

    const updatedTask = await this.updateParentTask(input.parentSessionId, task.taskId, (record) => {
      record.status = 'cancelled';
      record.completedAt = now();
      record.lastUpdatedAt = now();
      record.lastStatusReason = input.reason?.trim() || 'Worker cancelled by parent session.';
      if (record.workerType === 'enumeration_worker') {
        record.enumerationAttempts = cancelledEnumerationAttempts ?? [];
        record.targetRequestsUsed = liveChild.coordination?.targetRequestsUsed ?? 0;
      }
      return record;
    });
    await this.writeTrace(
      input.parentSessionId,
      this.requireSession(input.parentSessionId).turn ?? 0,
      'worker.task.cancelled',
      this.buildTaskTracePayload(updatedTask),
      `cancelled worker task ${updatedTask.taskId}`,
      'warn',
    );
    await this.writeTrace(
      task.workerSessionId,
      liveChild.turn ?? 0,
      'worker.session.cancelled',
      this.buildTaskTracePayload(updatedTask),
      `worker session cancelled for ${updatedTask.taskId}`,
      'warn',
    );

    return {
      task: updatedTask,
      sessionId: task.workerSessionId,
    };
  }

  private resolveBudget(
    template: WorkerTemplate,
    inputBudget: WorkerTaskBudget | undefined,
  ): WorkerTaskBudget | undefined {
    const requestedMaxToolCalls =
      typeof inputBudget?.maxToolCalls === 'number' ? Math.max(1, Math.trunc(inputBudget.maxToolCalls)) : undefined;
    if (!requestedMaxToolCalls) {
      return undefined;
    }

    return {
      maxToolCalls: Math.min(requestedMaxToolCalls, template.maxBudget.maxToolCalls ?? requestedMaxToolCalls),
    };
  }

  private assertEnumerationSpawnEnvelope(
    parentSession: SessionState,
    input: SpawnWorkerInput,
    planStepId: string | undefined,
  ): void {
    const admission = getEnumerationWorkerAdmissionState(parentSession.flags);
    if (!admission.allowed) {
      enumerationWorkerAdmissionTotal.inc({
        decision: 'rejected',
        reason: admission.reason,
        cohort: admission.snapshot?.cohort ?? 'missing',
        policy_version: String(admission.snapshot?.policyVersion ?? 'missing'),
        catalog_version: admission.snapshot?.catalogVersion ?? 'missing',
      });
      throw new Error(`enumeration_worker admission_${admission.reason}`);
    }
    enumerationWorkerAdmissionTotal.inc({
      decision: 'accepted',
      reason: 'enabled',
      cohort: admission.snapshot?.cohort ?? 'missing',
      policy_version: String(admission.snapshot?.policyVersion ?? 'missing'),
      catalog_version: admission.snapshot?.catalogVersion ?? 'missing',
    });
    if (!isEnumerationMissionEnvelope(input.mission)) {
      throw new Error('enumeration_worker mission_invalid: enumeration_hunt_v1 is required');
    }
    const mission = input.mission;
    const enumeration = mission.enumeration;
    if (
      mission.phase !== 'enumeration' ||
      mission.expectedArtifact !== ENUMERATION_RESULT_ARTIFACT_TYPE ||
      (input.expectedArtifactType && input.expectedArtifactType !== ENUMERATION_RESULT_ARTIFACT_TYPE) ||
      mission.revalidatesFindingId
    ) {
      throw new Error(
        'enumeration_worker mission_boundary_invalid: phase=enumeration, expectedArtifact=enumeration_result/v1, and no revalidatesFindingId are required',
      );
    }
    if (!planStepId) {
      throw new Error('enumeration_worker plan_step_missing');
    }
    const planStep = parentSession.plan.find((step) => step.id === planStepId);
    if (!planStep || !['pending', 'running'].includes(planStep.status)) {
      throw new Error('enumeration_worker plan_step_not_ready: linked step must exist and be pending or running');
    }
    if (
      !planStep.mission?.enumeration ||
      planStep.mission.enumeration.missionFingerprint !== enumeration.missionFingerprint
    ) {
      throw new Error(
        'enumeration_worker plan_step_mission_mismatch: the linked step must carry the same enumeration mission',
      );
    }

    const securityops =
      parentSession.flags?.securityops &&
      typeof parentSession.flags.securityops === 'object' &&
      !Array.isArray(parentSession.flags.securityops)
        ? (parentSession.flags.securityops as Record<string, unknown>)
        : {};
    const activePhaseId = typeof securityops.activePhaseId === 'string' ? securityops.activePhaseId : undefined;
    if (!activePhaseId || enumeration.phaseAttemptId !== activePhaseId) {
      throw new Error('enumeration_worker phase_attempt_mismatch: mission phaseAttemptId must match the active phase');
    }
    const runId = typeof securityops.runId === 'string' ? securityops.runId : undefined;
    if (!runId) {
      throw new Error('enumeration_worker run_context_missing');
    }
    const computedFingerprint = computeEnumerationMissionFingerprint(runId, enumeration);
    if (computedFingerprint !== enumeration.missionFingerprint) {
      throw new Error(`enumeration_worker mission_fingerprint_mismatch: expected ${computedFingerprint}`);
    }

    const assignedSkills = mission.assignedSkills ?? [];
    const selectedSkills = [enumeration.primarySkill.slug, ...enumeration.supportingSkills.map((skill) => skill.slug)];
    if (
      assignedSkills.length !== selectedSkills.length ||
      assignedSkills.some((slug, index) => slug !== selectedSkills[index])
    ) {
      throw new Error(
        'enumeration_worker assigned_skills_mismatch: assignedSkills must equal primary plus supporting skill slugs in order',
      );
    }
    const runtimeSourceMode =
      typeof securityops.enumerationSourceMode === 'string' ? securityops.enumerationSourceMode : undefined;
    if (!runtimeSourceMode || runtimeSourceMode !== enumeration.sourceMode) {
      throw new Error(
        `enumeration_worker source_mode_mismatch: mission=${enumeration.sourceMode}, run=${runtimeSourceMode ?? 'missing'}`,
      );
    }
    const runImpact =
      typeof securityops.enumerationImpactTolerance === 'string' ? securityops.enumerationImpactTolerance : undefined;
    if (!runImpact || !['non_destructive', 'poc', 'full'].includes(runImpact)) {
      throw new Error('enumeration_worker impact_context_missing');
    }
    if (runImpact === 'non_destructive' && enumeration.impactCeiling !== 'non_destructive') {
      throw new Error('enumeration_worker impact_denied');
    }
    const allowedTargetRefs = Array.isArray(securityops.enumerationTargetRefs)
      ? securityops.enumerationTargetRefs.filter((value): value is string => typeof value === 'string')
      : [];
    const exclusions = Array.isArray(securityops.enumerationExclusions)
      ? securityops.enumerationExclusions.filter((value): value is ScopeNamespaceRule =>
          typeof value === 'object' && value !== null &&
          ['domain', 'cidr'].includes(String((value as { type?: unknown }).type)) &&
          typeof (value as { value?: unknown }).value === 'string',
        )
      : [];
    if (
      allowedTargetRefs.length === 0 ||
      !allowedTargetRefs.some(
        (targetRef) => isEnumerationTargetAuthorized(enumeration.targetRef, targetRef, exclusions),
      )
    ) {
      throw new Error(`enumeration_worker target_not_allowlisted: ${enumeration.targetRef}`);
    }
    if (
      enumeration.surface.refs.some(
        (ref) => /[*?]/u.test(ref) || ref.includes(String.fromCharCode(0)) || ref.includes('..'),
      )
    ) {
      throw new Error('enumeration_worker surface_ref_unsafe');
    }
    if (
      enumeration.surface.kind === 'path_prefix_set' &&
      enumeration.surface.refs.some((ref) => !ref.startsWith('/'))
    ) {
      throw new Error('enumeration_worker path_prefix_invalid');
    }
    if (
      enumeration.surface.kind === 'repository_path_set' &&
      enumeration.surface.refs.some((ref) => ref.startsWith('/') || ref.endsWith('/'))
    ) {
      throw new Error('enumeration_worker repository_path_invalid');
    }

    const activeTasks = (parentSession.workerTasks ?? []).filter((task) =>
      ['pending', 'running', 'blocked', 'awaiting_input', 'awaiting_approval'].includes(task.status),
    );
    for (const task of activeTasks) {
      const activeMission = task.mission?.enumeration;
      if (!activeMission || activeMission.targetRef !== enumeration.targetRef) {
        continue;
      }
      const overlap = activeMission.surface.refs.some((ref) => enumeration.surface.refs.includes(ref));
      const explicitlyParallel =
        Boolean(task.planStepId) &&
        (mission.parallelSafeWith ?? []).includes(task.planStepId as string) &&
        (task.mission?.parallelSafeWith ?? []).includes(planStepId);
      if (overlap && !explicitlyParallel) {
        throw new Error(`enumeration_worker surface_conflict: overlaps active task ${task.taskId}`);
      }
    }
  }

  private assertAttackSpawnEnvelope(
    parentSession: SessionState,
    input: SpawnWorkerInput,
    planStepId: string | undefined,
  ): void {
    const liveAdmission = getControlledExploitationAdmissionState(parentSession.flags);
    if (!liveAdmission.allowed) {
      throw new Error(`attack_worker admission_${liveAdmission.reason}`);
    }
    const mission = input.mission;
    if (
      mission?.phase !== 'exploitation' ||
      !mission.attack ||
      mission.expectedArtifact !== 'attack_result/v1' ||
      (input.expectedArtifactType && input.expectedArtifactType !== 'attack_result/v1')
    ) {
      throw new Error(
        'attack_worker mission_invalid: phase=exploitation, attack_mission/v1, and expectedArtifact=attack_result/v1 are required',
      );
    }
    if (!planStepId) {
      throw new Error('attack_worker plan_step_missing');
    }
    const planStep = parentSession.plan.find((step) => step.id === planStepId);
    if (!planStep || !['pending', 'running'].includes(planStep.status)) {
      throw new Error('attack_worker plan_step_not_ready');
    }

    const securityops =
      parentSession.flags?.securityops &&
      typeof parentSession.flags.securityops === 'object' &&
      !Array.isArray(parentSession.flags.securityops)
        ? (parentSession.flags.securityops as Record<string, unknown>)
        : {};
    const validatedFindings = Array.isArray(securityops.exploitationValidatedFindings)
      ? securityops.exploitationValidatedFindings.filter(
          (value): value is ControlledExploitationValidatedFinding =>
            Boolean(value) &&
            typeof value === 'object' &&
            typeof (value as ControlledExploitationValidatedFinding).findingId === 'string' &&
            typeof (value as ControlledExploitationValidatedFinding).assetValue === 'string',
        )
      : [];
    const verifiedTargets = Array.isArray(securityops.exploitationVerifiedTargets)
      ? securityops.exploitationVerifiedTargets.filter(
          (value): value is { type: string; value: string; verified: boolean } =>
            Boolean(value) &&
            typeof value === 'object' &&
            typeof (value as { value?: unknown }).value === 'string' &&
            (value as { verified?: unknown }).verified === true,
        )
      : [];
    const exclusions = Array.isArray(securityops.exploitationExclusions)
      ? securityops.exploitationExclusions.filter((value): value is ScopeNamespaceRule =>
          Boolean(value) &&
          typeof value === 'object' &&
          ['domain', 'cidr'].includes(String((value as ScopeNamespaceRule).type)) &&
          typeof (value as ScopeNamespaceRule).value === 'string',
        )
      : [];
    const existingAttackWorkers = (parentSession.workerTasks ?? []).filter(
      (task) => task.workerType === 'attack_worker',
    ).length;
    const phaseAllowed =
      securityops.activePhaseKey === 'exploitation' &&
      securityops.workflowDiscipline === 'pentest' &&
      securityops.exploitationRunTrigger === 'manual' &&
      securityops.exploitationImpactTolerance === 'full';
    const decision = evaluateAttackWorkerAdmission({
      phaseDecision: {
        allowed: phaseAllowed,
        reason: phaseAllowed ? 'admitted' : 'wrong_phase',
      },
      mission: mission.attack,
      validatedFindings,
      verifiedTargets,
      exclusions,
      activeAttackWorkerCount: existingAttackWorkers,
    });
    if (!decision.allowed) {
      throw new Error(`attack_worker admission_${decision.reason}`);
    }
  }

  private async reserveEnumerationMissionFingerprint(
    parentSessionId: string,
    fingerprint: string,
    taskId: string,
  ): Promise<void> {
    const outcome = await this.sessionStore.updateSessionAsync(
      parentSessionId,
      (
        parent,
      ): {
        state: 'reserved' | 'duplicate' | 'active_cap_reached';
        existingTaskId?: string;
        activeCount?: number;
        activeCap?: number;
      } => {
        const existingTask = (parent.workerTasks ?? []).find(
          (task) => task.mission?.enumeration?.missionFingerprint === fingerprint,
        );
        if (existingTask) {
          return { state: 'duplicate', existingTaskId: existingTask.taskId };
        }
        if (!parent.coordination) {
          parent.coordination = { role: 'direct' };
        }
        const reservations = parent.coordination.enumerationMissionReservations ?? {};
        const existingReservation = reservations[fingerprint];
        if (existingReservation) {
          return {
            state: 'duplicate',
            existingTaskId: existingReservation.taskId,
          };
        }
        const liveTaskIds = new Set(
          (parent.workerTasks ?? [])
            .filter((task) => LIVE_WORKER_TASK_STATUSES.has(task.status))
            .map((task) => task.taskId),
        );
        const creatingTaskIds = new Set(
          Object.values(reservations)
            .map((reservation) => reservation.taskId)
            .filter((reservedTaskId) => !liveTaskIds.has(reservedTaskId)),
        );
        const securityops =
          parent.flags?.securityops &&
          typeof parent.flags.securityops === 'object' &&
          !Array.isArray(parent.flags.securityops)
            ? (parent.flags.securityops as Record<string, unknown>)
            : undefined;
        const activeCap =
          typeof securityops?.maxActiveWorkers === 'number' && Number.isFinite(securityops.maxActiveWorkers)
            ? Math.max(1, Math.floor(securityops.maxActiveWorkers))
            : 4;
        const activeCount = liveTaskIds.size + creatingTaskIds.size;
        if (activeCount >= activeCap) {
          return { state: 'active_cap_reached', activeCount, activeCap };
        }
        reservations[fingerprint] = { taskId, reservedAt: now() };
        parent.coordination.enumerationMissionReservations = reservations;
        return { state: 'reserved' };
      },
    );
    if (!outcome || outcome.state === 'duplicate') {
      throw new Error(
        `enumeration_worker mission_duplicate: ${fingerprint} already belongs to ${outcome?.existingTaskId ?? 'another reservation'}`,
      );
    }
    if (outcome.state === 'active_cap_reached') {
      throw new Error(
        `enumeration_worker active_cap_reached: ${outcome.activeCount ?? 0}/${outcome.activeCap ?? 0} workers active or starting`,
      );
    }
  }

  private async releaseEnumerationMissionReservation(
    parentSessionId: string,
    fingerprint: string | undefined,
    taskId: string,
  ): Promise<void> {
    if (!fingerprint) {
      return;
    }
    await this.sessionStore.updateSessionAsync(parentSessionId, (parent) => {
      const reservations = parent.coordination?.enumerationMissionReservations;
      if (reservations?.[fingerprint]?.taskId !== taskId) {
        return;
      }
      delete reservations[fingerprint];
      if (Object.keys(reservations).length === 0 && parent.coordination) {
        delete parent.coordination.enumerationMissionReservations;
      }
    });
  }

  private isWorkerTaskSettled(task: WorkerTaskRecord): boolean {
    if (task.artifact) {
      return true;
    }
    return (
      TERMINAL_WORKER_TASK_STATUSES.has(task.status) ||
      task.status === 'blocked' ||
      task.status === 'awaiting_approval' ||
      task.status === 'awaiting_input'
    );
  }

  private didWorkerObservableStateChange(previousTask: WorkerTaskRecord, nextTask: WorkerTaskRecord): boolean {
    return (
      previousTask.status !== nextTask.status ||
      previousTask.summary !== nextTask.summary ||
      previousTask.lastStatusReason !== nextTask.lastStatusReason ||
      Boolean(previousTask.artifact) !== Boolean(nextTask.artifact)
    );
  }

  private async maybeReopenLinkedPlanStep(
    parentSessionId: string,
    task: WorkerTaskRecord,
    sharedStateSync: SharedStateSyncResult,
  ): Promise<{ reopened: boolean; stepId?: string }> {
    const planStepId =
      typeof task.planStepId === 'string' && task.planStepId.trim().length > 0 ? task.planStepId.trim() : undefined;
    if (!planStepId || !task.artifact) {
      return { reopened: false };
    }

    const parentSession = this.requireSession(parentSessionId);
    const linkedStep = parentSession.plan.find((candidate) => candidate.id === planStepId);
    if (!linkedStep || linkedStep.status !== 'blocked') {
      return { reopened: false, stepId: planStepId };
    }
    if (
      typeof linkedStep.blockedReason === 'string' &&
      /waiting for (user input|approval)/iu.test(linkedStep.blockedReason)
    ) {
      return { reopened: false, stepId: planStepId };
    }

    await this.sessionStore.updatePlanStepAsync(parentSessionId, planStepId, {
      ...linkedStep,
      status: 'running',
      blockedReason: undefined,
      startedAt: linkedStep.startedAt ?? now(),
    });

    const latestParentSession = this.requireSession(parentSessionId);
    const currentPlanStep =
      typeof latestParentSession.currentPlanStepId === 'string'
        ? latestParentSession.plan.find((candidate) => candidate.id === latestParentSession.currentPlanStepId)
        : undefined;
    if (!currentPlanStep || currentPlanStep.status !== 'running') {
      await this.sessionStore.updateCurrentPlanStepIdAsync(parentSessionId, planStepId);
    }

    await this.writeTrace(
      parentSessionId,
      latestParentSession.turn ?? 0,
      'worker.plan_step_reopened',
      this.buildTaskTracePayload(task, {
        stepId: planStepId,
        sharedStateAdded: sharedStateSync.addedDescriptions,
        sharedStateUpdated: sharedStateSync.updatedDescriptions,
      }),
      `reopened blocked plan step ${planStepId} after worker ${task.taskId} produced a usable result`,
      'info',
    );

    return { reopened: true, stepId: planStepId };
  }

  private runWorkerTaskLoop(task: WorkerTaskRecord, initialPrompt: string): Promise<WorkerTaskRecord> {
    const activeLoop = this.activeWorkerTaskLoops.get(task.taskId);
    if (activeLoop) {
      return activeLoop;
    }

    const ownedLoop = this.executeWorkerTaskLoop(task, initialPrompt).finally(() => {
      this.activeWorkerTaskLoops.delete(task.taskId);
    });
    this.activeWorkerTaskLoops.set(task.taskId, ownedLoop);
    return ownedLoop;
  }

  private async executeWorkerTaskLoop(task: WorkerTaskRecord, initialPrompt: string): Promise<WorkerTaskRecord> {
    let currentTask = cloneTask(task);
    let prompt = initialPrompt.trim().length > 0 ? initialPrompt : buildWorkerContinuationPrompt(currentTask);

    while (true) {
      const childTurnBefore = this.requireSession(currentTask.workerSessionId).turn ?? 0;
      currentTask = await this.runWorkerTurn(currentTask, prompt);

      if (this.isWorkerTaskSettled(currentTask)) {
        return currentTask;
      }

      const liveChild = this.requireSession(currentTask.workerSessionId);
      if (liveChild.stateMachine?.isProcessing()) {
        await this.writeTrace(
          currentTask.parentSessionId,
          this.requireSession(currentTask.parentSessionId).turn ?? 0,
          'worker.task.loop_yielded',
          this.buildTaskTracePayload(currentTask, {
            reason: 'worker_session_owned_by_another_turn',
            childTurnBefore,
            childTurnAfter: liveChild.turn ?? 0,
          }),
          `worker loop yielded because another turn owns ${currentTask.taskId}`,
          'warn',
        );
        return currentTask;
      }

      const retryDelayMs = liveChild.flags?.error_retry?.retryAfterMs;
      if (typeof retryDelayMs === 'number' && Number.isFinite(retryDelayMs) && retryDelayMs > 0) {
        await this.writeTrace(
          currentTask.parentSessionId,
          this.requireSession(currentTask.parentSessionId).turn ?? 0,
          'worker.task.retry_wait_started',
          this.buildTaskTracePayload(currentTask, {
            retryDelayMs,
            retryCount: liveChild.flags?.error_retry?.retryCount,
          }),
          `worker retry waiting ${retryDelayMs}ms for ${currentTask.taskId}`,
          'warn',
        );
        await sleep(retryDelayMs);
        prompt = buildWorkerContinuationPrompt(currentTask);
        continue;
      }

      const childTurnAfter = liveChild.turn ?? 0;
      if (childTurnAfter <= childTurnBefore) {
        await this.writeTrace(
          currentTask.parentSessionId,
          this.requireSession(currentTask.parentSessionId).turn ?? 0,
          'worker.task.loop_yielded',
          this.buildTaskTracePayload(currentTask, {
            reason: 'worker_turn_made_no_observable_progress',
            childTurnBefore,
            childTurnAfter,
          }),
          `worker loop yielded after a no-progress turn for ${currentTask.taskId}`,
          'warn',
        );
        return currentTask;
      }

      prompt = buildWorkerContinuationPrompt(currentTask);
    }
  }

  private async runWorkerTurn(task: WorkerTaskRecord, prompt: string): Promise<WorkerTaskRecord> {
    const runtime = this.requireRuntime();
    const childSession = this.requireSession(task.workerSessionId);
    if (task.workerType === 'enumeration_worker') {
      const parentSession = this.requireSession(task.parentSessionId);
      const admission = getEnumerationWorkerAdmissionState(parentSession.flags);
      const activePhaseKey = getActivePhaseKey(parentSession.flags);
      if (!admission.allowed || activePhaseKey !== 'enumeration') {
        const stopped = await this.stopWorker({
          parentSessionId: task.parentSessionId,
          taskId: task.taskId,
          reason: !admission.allowed
            ? `enumeration_worker ${admission.reason}`
            : `enumeration_worker cancelled because active phase changed to ${activePhaseKey ?? 'none'}`,
        });
        return stopped.task;
      }
    }
    const remainingMs = (task.deadlineAt ?? now()) - now();
    if ((task.workerType === 'enumeration_worker' || task.workerType === 'attack_worker') && remainingMs <= 0) {
      childSession.blockedReason = 'wall_timeout';
      await this.sessionStore.setAsync(childSession.id, childSession, 'worker_wall_timeout');
      return this.syncWorkerState(task.parentSessionId, task.taskId);
    }
    this.policyResolver.assertWorkerCanRunTurn(task.parentSessionId, task, childSession);
    await this.writeTrace(
      task.parentSessionId,
      this.requireSession(task.parentSessionId).turn ?? 0,
      'worker.task.turn_started',
      this.buildTaskTracePayload(task, {
        childTurnBefore: childSession.turn ?? 0,
        promptLength: prompt.trim().length,
      }),
      `worker turn started for ${task.taskId}`,
    );
    let wallTimeout: ReturnType<typeof setTimeout> | undefined;
    let wallTimedOut = false;
    if (task.deadlineAt) {
      wallTimeout = setTimeout(
        () => {
          wallTimedOut = true;
          void this.sessionStore.abortCurrentTurnAsync(childSession.id, 'wall_timeout');
        },
        Math.max(1, task.deadlineAt - now()),
      );
    }
    try {
      await runtime.orchestrator.processMessage(task.workerSessionId, prompt, undefined);
    } catch (error) {
      if (!wallTimedOut) {
        throw error;
      }
    } finally {
      if (wallTimeout) {
        clearTimeout(wallTimeout);
      }
    }
    if (wallTimedOut) {
      const liveChild = this.requireSession(childSession.id);
      liveChild.blockedReason = 'wall_timeout';
      if (liveChild.stateMachine?.isProcessing()) {
        stopProcessing(liveChild, {
          reason: 'wall_timeout',
          turnNumber: liveChild.turn,
          caller: 'WorkerDelegationService',
        });
      }
      await this.sessionStore.setAsync(liveChild.id, liveChild, 'worker_wall_timeout');
    }
    return this.syncWorkerState(task.parentSessionId, task.taskId);
  }

  private async syncWorkerState(parentSessionId: string, taskId: string): Promise<WorkerTaskRecord> {
    const parentTask = this.requireParentTask(parentSessionId, taskId);
    const workerSession = this.requireSession(parentTask.workerSessionId);
    const status = deriveWorkerTaskStatus(workerSession);
    let artifact = workerSession.workerResult ? cloneArtifact(workerSession.workerResult) : undefined;

    if (!artifact && status === 'completed') {
      artifact = buildFallbackArtifact(workerSession, parentTask);
      await this.sessionStore.recordSessionCompletedAsync(
        workerSession.id,
        'worker_fallback_result',
      );
      workerSession.workerResult = cloneArtifact(artifact);
      workerSession.completed = true;
      workerSession.blockedReason = undefined;
      workerSession.flags = {
        ...(workerSession.flags ?? {}),
        session: {
          ...((workerSession.flags?.session as Record<string, unknown> | undefined) ?? {}),
          completed: true,
        },
      };
      await this.sessionStore.setAsync(workerSession.id, workerSession, 'worker_fallback_result');
    }

    if (artifact) {
      const sharedWorkspaceArtifact = this.normalizeSharedWorkspaceArtifact(workerSession, artifact);
      if (JSON.stringify(sharedWorkspaceArtifact) !== JSON.stringify(workerSession.workerResult ?? {})) {
        workerSession.workerResult = cloneArtifact(sharedWorkspaceArtifact);
        await this.sessionStore.setAsync(workerSession.id, workerSession, 'worker_result_shared_workspace_normalized');
      }
      artifact = sharedWorkspaceArtifact;
    }
    const sharedStateSync = artifact
      ? await this.syncWorkerArtifactSharedState(parentSessionId, parentTask, artifact)
      : EMPTY_SHARED_STATE_SYNC;
    const missingFindingSubmission =
      Boolean(artifact) &&
      isConfirmedValidationArtifact(parentTask, artifact) &&
      getReportedFindingIds(workerSession).length === 0;

    const updatedTask = await this.updateParentTask(parentSessionId, taskId, (record) => {
      record.status = artifact ? 'completed' : status;
      record.lastUpdatedAt = now();
      if (TERMINAL_WORKER_TASK_STATUSES.has(record.status)) {
        record.completedAt = record.completedAt ?? now();
      } else {
        delete record.completedAt;
      }
      if (artifact) {
        record.artifact = cloneArtifact(artifact);
        record.summary = artifact.summary;
        record.lastStatusReason = missingFindingSubmission
          ? MISSING_FINDING_SUBMISSION_WARNING
          : 'Worker completed and submitted an artifact.';
        delete record.lastError;
      } else if (workerSession.pendingApproval) {
        record.lastStatusReason = 'Worker is awaiting approval.';
        delete record.lastError;
      } else if (status === 'blocked' && workerSession.blockedReason) {
        record.lastStatusReason = `Worker blocked by inherited parent state: ${formatBlockedReason(workerSession.blockedReason)}.`;
        delete record.lastError;
      } else if (workerSession.blockedReason) {
        record.lastStatusReason = `Worker blocked: ${workerSession.blockedReason}`;
        record.lastError = workerSession.blockedReason;
      } else {
        delete record.lastError;
      }
      return record;
    });

    if (TERMINAL_WORKER_TASK_STATUSES.has(updatedTask.status)) {
      const parentSession = this.requireSession(parentSessionId);
      const runId = this.resolveSecurityOpsRunId(parentSession);
      if (runId && this.capacityCoordinator) {
        const runtime = this.requireRuntime();
        // Do not free the slot until the worker sandbox teardown succeeds.
        await runtime.agentEngine.destroySandbox(workerSession);
        await this.capacityCoordinator.releaseWorkerCapacity({
          runId,
          workerTaskId: updatedTask.taskId,
          reason: `worker_${updatedTask.status}`,
        });
      }
    }

    const artifactArrived = !parentTask.artifact && Boolean(updatedTask.artifact);
    const statusChanged = parentTask.status !== updatedTask.status;
    const reasonChanged = parentTask.lastStatusReason !== updatedTask.lastStatusReason;
    if (artifactArrived || statusChanged || reasonChanged) {
      await this.writeTrace(
        parentSessionId,
        this.requireSession(parentSessionId).turn ?? 0,
        'worker.task.status_changed',
        this.buildTaskTracePayload(updatedTask, {
          previousStatus: parentTask.status,
          previousReason: parentTask.lastStatusReason,
          artifactArrived,
          parentReadableManifestPath: updatedTask.artifact?.parentReadableManifestPath,
          parentReadableEvidenceRefs: updatedTask.artifact?.parentReadableEvidenceRefs,
          sharedStateAdded: sharedStateSync.addedDescriptions,
          sharedStateUpdated: sharedStateSync.updatedDescriptions,
        }),
        `worker task ${updatedTask.taskId} -> ${updatedTask.status}`,
      );
      await this.writeTrace(
        workerSession.id,
        workerSession.turn ?? 0,
        'worker.session.status_synced',
        this.buildTaskTracePayload(updatedTask, {
          previousStatus: parentTask.status,
          artifactArrived,
          parentReadableManifestPath: updatedTask.artifact?.parentReadableManifestPath,
          parentReadableEvidenceRefs: updatedTask.artifact?.parentReadableEvidenceRefs,
          sharedStateAdded: sharedStateSync.addedDescriptions,
          sharedStateUpdated: sharedStateSync.updatedDescriptions,
        }),
        `worker session synced as ${updatedTask.status}`,
      );
    }

    await this.maybeReopenLinkedPlanStep(parentSessionId, updatedTask, sharedStateSync);

    if (missingFindingSubmission) {
      await this.writeTrace(
        parentSessionId,
        this.requireSession(parentSessionId).turn ?? 0,
        'worker.finding_submission_missing',
        this.buildTaskTracePayload(updatedTask, {
          childSessionId: workerSession.id,
          findingIds: getReportedFindingIds(workerSession),
        }),
        `confirmed validator artifact missing report_finding for ${updatedTask.taskId}`,
        'warn',
      );
      await this.writeTrace(
        workerSession.id,
        workerSession.turn ?? 0,
        'worker.finding_submission_missing',
        this.buildTaskTracePayload(updatedTask, {
          childSessionId: workerSession.id,
          findingIds: getReportedFindingIds(workerSession),
        }),
        `confirmed validator artifact missing report_finding for ${updatedTask.taskId}`,
        'warn',
      );
    }

    await this.maybeScheduleParentContinuation(parentTask, updatedTask, sharedStateSync);
    return updatedTask;
  }

  private resolveSecurityOpsRunId(session: SessionState): string | null {
    const securityops = session.flags?.securityops;
    if (!securityops || typeof securityops !== 'object' || Array.isArray(securityops)) return null;
    const runId = (securityops as Record<string, unknown>).runId;
    return typeof runId === 'string' && runId.trim().length > 0 ? runId.trim() : null;
  }

  private async upsertParentTask(parentSessionId: string, task: WorkerTaskRecord): Promise<void> {
    const parentSession = this.requireSession(parentSessionId);
    parentSession.coordination =
      parentSession.coordination?.role === 'worker'
        ? parentSession.coordination
        : { ...(parentSession.coordination ?? {}), role: 'direct' };
    const existingTasks = Array.isArray(parentSession.workerTasks) ? [...parentSession.workerTasks] : [];
    const index = existingTasks.findIndex((candidate) => candidate.taskId === task.taskId);
    if (index === -1) {
      existingTasks.push(cloneTask(task));
    } else {
      existingTasks[index] = cloneTask(task);
    }
    parentSession.workerTasks = existingTasks;
    await this.sessionStore.setAsync(parentSessionId, parentSession, 'worker_task_upsert');
  }

  private async updateParentTask(
    parentSessionId: string,
    taskId: string,
    mutate: (task: WorkerTaskRecord) => WorkerTaskRecord,
  ): Promise<WorkerTaskRecord> {
    const parentSession = this.requireSession(parentSessionId);
    const nextTasks = Array.isArray(parentSession.workerTasks) ? [...parentSession.workerTasks] : [];
    const index = nextTasks.findIndex((candidate) => candidate.taskId === taskId);
    if (index === -1) {
      throw new Error(`Worker task ${taskId} not found on parent session ${parentSessionId}.`);
    }
    nextTasks[index] = mutate(cloneTask(nextTasks[index]));
    parentSession.coordination =
      parentSession.coordination?.role === 'worker'
        ? parentSession.coordination
        : { ...(parentSession.coordination ?? {}), role: 'direct' };
    parentSession.workerTasks = nextTasks;
    await this.sessionStore.setAsync(parentSessionId, parentSession, 'worker_task_update');
    return cloneTask(nextTasks[index]);
  }

  private requireParentTask(parentSessionId: string, taskId: string): WorkerTaskRecord {
    const parentSession = this.requireSession(parentSessionId);
    const task = parentSession.workerTasks?.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw new Error(`Worker task ${taskId} was not found on parent session ${parentSessionId}.`);
    }
    return cloneTask(task);
  }

  private async resolveWorkerSkillSlugs(
    parentSession: SessionState,
    task: WorkerTaskRecord,
    workerToolPolicy: ToolAccessPolicy,
  ): Promise<string[]> {
    if (task.workerType === 'enumeration_worker') {
      if (!task.mission?.enumeration) {
        throw new Error('enumeration_worker mission_invalid');
      }
      const securityops =
        parentSession.flags?.securityops &&
        typeof parentSession.flags.securityops === 'object' &&
        !Array.isArray(parentSession.flags.securityops)
          ? (parentSession.flags.securityops as Record<string, unknown>)
          : {};
      const resolved = await this.enumerationSkillResolver.resolve({
        mission: task.mission.enumeration,
        executableTools: task.toolPreflight?.executableTools ?? [],
        runtimeSourceMode:
          typeof securityops.enumerationSourceMode === 'string' ? securityops.enumerationSourceMode : undefined,
        runImpactTolerance:
          typeof securityops.enumerationImpactTolerance === 'string'
            ? securityops.enumerationImpactTolerance
            : undefined,
        catalogAdmission:
          typeof securityops.enumerationEvaluationCandidateCatalogDigest === 'string'
            ? {
                kind: 'evaluation_candidate',
                expectedCatalogDigest: securityops.enumerationEvaluationCandidateCatalogDigest,
              }
            : undefined,
      });
      if ([resolved.primary, ...resolved.supporting].some((skill) => skill.riskTier === 'sensitive')) {
        const competingTargetTask = (parentSession.workerTasks ?? []).find(
          (candidate) =>
            ['pending', 'running', 'blocked', 'awaiting_input', 'awaiting_approval'].includes(candidate.status) &&
            candidate.mission?.enumeration?.targetRef === task.mission?.enumeration?.targetRef,
        );
        if (competingTargetTask) {
          throw new Error(`enumeration_worker sensitive_skill_target_busy: ${competingTargetTask.taskId}`);
        }
      }
      return [resolved.primary.slug, ...resolved.supporting.map((skill) => skill.slug)];
    }

    const phaseSkillSlugs = getPhaseAssignedSkillSlugs(parentSession.flags);
    const missionSkillSlugs = task.mission?.assignedSkills ? uniqueSkillSlugs(task.mission.assignedSkills) : [];

    if (missionSkillSlugs.length === 0) {
      if (phaseSkillSlugs.length > 0) {
        return phaseSkillSlugs;
      }
      return parseAssignedSkillsFromExtraContext(parentSession.extraContext).slugs;
    }

    const activePhaseKey = getActivePhaseKey(parentSession.flags);
    if (!activePhaseKey) {
      return missionSkillSlugs;
    }

    const assignedPhaseSkills = new Set(phaseSkillSlugs);
    const missing: string[] = [];
    const incompatible: string[] = [];
    const unavailableTools: Array<{ slug: string; tools: string[] }> = [];

    for (const slug of missionSkillSlugs) {
      const skill = await workerSkillLoader.loadSkillBySlug(slug);
      if (!skill) {
        missing.push(slug);
        continue;
      }

      const compatibilityError = assignedPhaseSkills.has(slug)
        ? null
        : phaseProfileRegistry.validateSkillAssignment(activePhaseKey, skill);
      if (compatibilityError) {
        incompatible.push(`${slug} (${compatibilityError})`);
      }

      const blockedRequiredTools = (skill.requiredTools ?? []).filter(
        (tool) => !this.policyResolver.isWorkerSkillRequiredToolSatisfied(workerToolPolicy, tool),
      );
      if (blockedRequiredTools.length > 0) {
        skillToolCompatibilityRejectionTotal.inc({ slug });
        unavailableTools.push({ slug, tools: blockedRequiredTools });
      }
    }

    if (missing.length > 0) {
      throw new Error(`Worker mission requested unknown skills: ${missing.join(', ')}.`);
    }
    if (incompatible.length > 0) {
      throw new Error(
        `Worker mission requested skills outside the active phase skill catalog: ${incompatible.join('; ')}.`,
      );
    }
    if (unavailableTools.length > 0) {
      throw new Error(
        'Worker mission requested skills whose required tools are not available to this worker: ' +
          unavailableTools.map((entry) => `${entry.slug} needs ${entry.tools.join(', ')}`).join('; ') +
          '.',
      );
    }

    return missionSkillSlugs;
  }

  private cloneInheritedFlags(parentFlags: SessionFlags | undefined): SessionFlags {
    const flags = cloneFlags(parentFlags);
    delete flags.ephemeralNudge;
    delete flags.guard;
    delete flags.error_retry;
    delete flags.blocked_reason;
    delete flags.artifacts;
    delete flags.session;
    if (flags.approval_resume) {
      delete flags.approval_resume;
    }
    return flags;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found.`);
    }
    return session;
  }

  private requireRuntime(): RuntimeDeps {
    if (!this.runtime) {
      throw new Error('Worker delegation runtime is not initialized.');
    }
    return this.runtime;
  }

  private isBenignBackgroundStop(message: string): boolean {
    return (
      message === 'wait_aborted' ||
      message.includes('is awaiting approval') ||
      message.includes('is awaiting user input') ||
      message.includes('is blocked (')
    );
  }

  private async handleBackgroundWorkerFailure(parentSessionId: string, taskId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (this.isBenignBackgroundStop(message)) {
      this.log.debug({ err: error, parentSessionId, taskId }, 'Background worker loop stopped without failure');
      try {
        await this.syncWorkerState(parentSessionId, taskId);
      } catch (syncError) {
        this.log.warn({ err: syncError, parentSessionId, taskId }, 'Failed to sync benign background worker stop');
      }
      return;
    }

    this.log.warn({ err: error, parentSessionId, taskId }, 'Background worker execution failed');

    try {
      const previousTask = this.requireParentTask(parentSessionId, taskId);
      const retryAdmission =
        previousTask.workerType === 'enumeration_worker'
          ? resolveEnumerationInfrastructureRetryAdmission(previousTask, now())
          : undefined;
      if (previousTask.workerType === 'enumeration_worker' && retryAdmission?.allowed) {
        const retryTask = await this.updateParentTask(parentSessionId, taskId, (record) => {
          record.retryIndex = 1;
          record.status = 'running';
          record.lastUpdatedAt = now();
          record.lastStatusReason = 'Retrying once after zero-request infrastructure failure.';
          record.lastError = message;
          return record;
        });
        await this.writeTrace(
          parentSessionId,
          this.requireSession(parentSessionId).turn ?? 0,
          'enumeration_worker.zero_request_retry',
          this.buildTaskTracePayload(retryTask, {
            retryIndex: 1,
            priorError: message,
            remainingTargetRequests: retryAdmission.remainingTargetRequests,
            remainingWallMs: retryAdmission.remainingWallMs,
          }),
          `zero-request infrastructure retry for ${taskId}`,
          'warn',
        );
        void this.runWorkerTaskLoop(
          retryTask,
          buildWorkerKickoffPrompt(retryTask, getWorkerTemplate('enumeration_worker')),
        ).catch((retryError) => this.handleBackgroundWorkerFailure(parentSessionId, taskId, retryError));
        return;
      }
      const childSession = this.sessionStore.get(previousTask.workerSessionId);
      if (childSession) {
        childSession.blockedReason = 'worker_failed';
        if (childSession.stateMachine?.isProcessing()) {
          stopProcessing(childSession, {
            reason: 'worker_failed',
            turnNumber: childSession.turn,
            caller: 'WorkerDelegationService',
          });
        }
        await this.sessionStore.setAsync(childSession.id, childSession, 'worker_background_failed');
        await this.writeTrace(
          childSession.id,
          childSession.turn ?? 0,
          'worker.session.background_failed',
          {
            taskId,
            parentSessionId,
            reason: message,
          },
          `background worker failed for ${taskId}`,
          'warn',
        );
      }

      const updatedTask = await this.updateParentTask(parentSessionId, taskId, (record) => {
        record.status = 'failed';
        record.completedAt = record.completedAt ?? now();
        record.lastUpdatedAt = now();
        record.lastError = message;
        record.lastStatusReason = `Background worker execution failed: ${message}`;
        return record;
      });
      await this.writeTrace(
        parentSessionId,
        this.requireSession(parentSessionId).turn ?? 0,
        'worker.task.background_failed',
        this.buildTaskTracePayload(updatedTask, {
          error: message,
        }),
        `background worker failed for ${taskId}`,
        'warn',
      );

      await this.maybeScheduleParentContinuation(previousTask, updatedTask, EMPTY_SHARED_STATE_SYNC);
    } catch (followUpError) {
      this.log.warn(
        { err: followUpError, parentSessionId, taskId },
        'Failed to reconcile background worker failure back to the parent session',
      );
    }
  }

  private async maybeScheduleParentContinuation(
    previousTask: WorkerTaskRecord,
    nextTask: WorkerTaskRecord,
    sharedStateSync: SharedStateSyncResult = EMPTY_SHARED_STATE_SYNC,
  ): Promise<void> {
    if (nextTask.executionMode !== 'background') {
      return;
    }
    if (!PARENT_CONTINUATION_TASK_STATUSES.has(nextTask.status)) {
      return;
    }
    const artifactArrived = !previousTask.artifact && Boolean(nextTask.artifact);
    const statusChanged = previousTask.status !== nextTask.status;
    const statusReasonChanged =
      previousTask.lastStatusReason !== nextTask.lastStatusReason &&
      typeof nextTask.lastStatusReason === 'string' &&
      nextTask.lastStatusReason.trim().length > 0;
    if (!artifactArrived && !statusChanged && !statusReasonChanged) {
      return;
    }

    const runtime = this.runtime;
    if (!runtime) {
      return;
    }
    const parentSession = this.requireSession(nextTask.parentSessionId);
    const isCompleted =
      parentSession.completed === true ||
      (parentSession.flags?.session as Record<string, unknown> | undefined)?.completed === true;

    if (parentSession.mode !== 'automated' || parentSession.agentType !== 'executor') {
      return;
    }
    if (parentSession.coordination?.role === 'worker') {
      return;
    }
    if (isCompleted) {
      return;
    }
    if (parentSession.stateMachine?.isProcessing()) {
      return;
    }
    if (parentSession.pendingApproval || parentSession.blockedReason) {
      return;
    }

    try {
      const continuationPrompt = buildParentContinuationPrompt(nextTask, sharedStateSync);
      const promptHash = sha256Hex(continuationPrompt).slice(0, 24);
      const continuationMessage: Message = {
        id: `worker-continuation:${nextTask.taskId}:${promptHash}`,
        role: 'user',
        content: continuationPrompt,
        // Sequence is authoritative; use the durable worker transition time so
        // compatibility views that still sort timestamps preserve turn order.
        timestamp: nextTask.lastUpdatedAt
          ?? nextTask.completedAt
          ?? nextTask.startedAt
          ?? nextTask.createdAt,
        metadata: {
          visibility: 'internal',
          source: 'worker_state_continuation',
        },
      };
      await this.writeTrace(
        parentSession.id,
        parentSession.turn ?? 0,
        'worker.parent.continuation_requested',
        this.buildTaskTracePayload(nextTask),
        `continuation requested after ${nextTask.taskId} changed state`,
      );
      const scheduled = await this.sessionStore.recordInternalContinuationInputAsync?.(
        parentSession.id,
        continuationMessage,
      ) ?? false;
      // Focused unit tests and deliberately embedded runtimes can omit the
      // journal adapter. Production continuations always take the durable path.
      if (!scheduled) {
        await runtime.orchestrator.processMessage(
          parentSession.id,
          continuationPrompt,
          undefined,
        );
      }
      await this.writeTrace(
        parentSession.id,
        parentSession.turn ?? 0,
        scheduled
          ? 'worker.parent.continuation_scheduled'
          : 'worker.parent.continuation_started',
        this.buildTaskTracePayload(nextTask),
        scheduled
          ? `durable continuation scheduled after ${nextTask.taskId}`
          : `embedded continuation started after ${nextTask.taskId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'session_already_processing') {
        this.log.debug(
          { parentSessionId: parentSession.id, taskId: nextTask.taskId },
          'Skipped parent continuation because the parent executor is already processing',
        );
        await this.writeTrace(
          parentSession.id,
          parentSession.turn ?? 0,
          'worker.parent.continuation_skipped',
          this.buildTaskTracePayload(nextTask, {
            reason: 'session_already_processing',
          }),
          `continuation skipped for ${nextTask.taskId}`,
        );
        return;
      }
      this.log.warn(
        {
          err: error,
          parentSessionId: parentSession.id,
          taskId: nextTask.taskId,
        },
        'Failed to schedule parent continuation after worker state change',
      );
      await this.writeTrace(
        parentSession.id,
        parentSession.turn ?? 0,
        'worker.parent.continuation_failed',
        this.buildTaskTracePayload(nextTask, {
          error: message,
        }),
        `continuation failed for ${nextTask.taskId}`,
        'warn',
      );
    }
  }

  private buildTaskTracePayload(task: WorkerTaskRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      taskId: task.taskId,
      parentSessionId: task.parentSessionId,
      workerSessionId: task.workerSessionId,
      workerType: task.workerType,
      planStepId: task.planStepId,
      status: task.status,
      executionMode: task.executionMode,
      dependencyMode: task.dependencyMode,
      continuationMode: task.continuationMode,
      expectedArtifactType: task.expectedArtifactType,
      missionQuestion: task.mission?.question,
      missionStopCondition: task.mission?.stopCondition,
      missionAssignedSkills: task.mission?.assignedSkills,
      reason: compactText(task.reason, 160),
      summary: typeof task.summary === 'string' ? compactText(task.summary, 200) : undefined,
      lastStatusReason: typeof task.lastStatusReason === 'string' ? compactText(task.lastStatusReason, 200) : undefined,
      maxToolCalls: task.budget?.maxToolCalls,
      maxTargetRequests: task.budget?.maxTargetRequests,
      maxRequestConcurrency: task.budget?.maxRequestConcurrency,
      maxWallSeconds: task.budget?.maxWallSeconds,
      targetRequestsUsed: task.targetRequestsUsed,
      deadlineAt: task.deadlineAt,
      enumerationMissionFingerprint: task.mission?.enumeration?.missionFingerprint,
      enumerationTargetRef: task.mission?.enumeration?.targetRef,
      enumerationSurfaceKind: task.mission?.enumeration?.surface.kind,
      enumerationSurfaceRefs: task.mission?.enumeration?.surface.refs,
      enumerationTechniqueIds: task.mission?.enumeration?.techniqueIds,
      enumerationSkillVersions: task.mission?.enumeration
        ? [task.mission.enumeration.primarySkill, ...task.mission.enumeration.supportingSkills]
        : undefined,
      enumerationCapability: task.enumerationCapability,
      enumerationAttemptCount: task.enumerationAttempts?.length,
      enumerationResultStatus: task.artifact?.enumeration?.status,
      enumerationResultHash: task.artifact?.enumeration?.resultHash,
      enumerationDispositionAction: task.enumerationDisposition?.action,
      advertisedTools: task.toolPreflight?.advertisedTools,
      executableTools: task.toolPreflight?.executableTools,
      withheldTools: task.toolPreflight?.withheldTools,
      ...extra,
    };
  }

  private async writeTrace(
    sessionId: string,
    turnNumber: number,
    event: string,
    payload: Record<string, unknown>,
    note: string,
    severity: 'debug' | 'info' | 'warn' | 'error' = 'info',
  ): Promise<void> {
    if (!this.traceRecorder) {
      return;
    }

    try {
      await this.traceRecorder.write(sessionId, turnNumber, {
        event,
        severity,
        payload,
        note,
      });
    } catch (error) {
      this.log.warn({ err: error, sessionId, event }, 'Failed to record worker delegation trace event');
    }
  }

  private async prepareSharedWorkerWorkspace(
    childSession: SessionState,
    assignedSkills: string[],
  ): Promise<{
    syncedSkillSlugs: string[];
    syncedSkills: Array<{ slug: string; versionHash: string }>;
    credentialsInherited: boolean;
  }> {
    const syncedSkillSlugs = await syncAssignedSkillsIntoWorkspace(assignedSkills, childSession.workspaceDir);
    const syncedSkills = (await Promise.all(syncedSkillSlugs.map((slug) => workerSkillLoader.loadSkillBySlug(slug))))
      .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
      .map((skill) => ({ slug: skill.slug, versionHash: skill.versionHash }));

    return {
      syncedSkillSlugs,
      syncedSkills,
      credentialsInherited: true,
    };
  }

  private async syncWorkerArtifactSharedState(
    parentSessionId: string,
    task: WorkerTaskRecord,
    artifact: WorkerResultArtifact,
  ): Promise<SharedStateSyncResult> {
    const candidates = inferSharedStateCandidates(artifact);
    if (candidates.length === 0) {
      return EMPTY_SHARED_STATE_SYNC;
    }

    const parentSession = this.requireSession(parentSessionId);
    const memory = cloneMemory(parentSession.memory);
    const addedDescriptions: string[] = [];
    const updatedDescriptions: string[] = [];
    const source = `worker:${task.taskId}`;
    const confidence = clampConfidence(artifact.confidence, 0.8);

    for (const candidate of candidates) {
      const result = MemoryManager.addFact(memory, {
        category: candidate.category,
        key: candidate.key,
        value: candidate.value,
        confidence,
        source,
      });
      if (result.added) {
        addedDescriptions.push(candidate.description);
      } else if (result.updated) {
        updatedDescriptions.push(candidate.description);
      }
    }

    if (addedDescriptions.length === 0 && updatedDescriptions.length === 0) {
      return EMPTY_SHARED_STATE_SYNC;
    }

    await this.sessionStore.setMemoryAsync(parentSessionId, memory as unknown as Record<string, unknown>);
    const syncedParentSession = this.requireSession(parentSessionId);
    await this.writeTrace(
      parentSessionId,
      syncedParentSession.turn ?? 0,
      'worker.task.shared_state_updated',
      this.buildTaskTracePayload(task, {
        addedDescriptions,
        updatedDescriptions,
        discoveredFactsCount: syncedParentSession.memory?.discoveredFacts?.length ?? 0,
      }),
      `merged worker discoveries into shared state for ${task.taskId}`,
      'debug',
    );

    return {
      addedDescriptions,
      updatedDescriptions,
    };
  }

  private normalizeSharedWorkspaceArtifact(
    workerSession: SessionState,
    artifact: WorkerResultArtifact,
  ): WorkerResultArtifact {
    const sourceEvidenceRefs =
      Array.isArray(artifact.sourceEvidenceRefs) && artifact.sourceEvidenceRefs.length > 0
        ? [...artifact.sourceEvidenceRefs]
        : [...artifact.evidenceRefs];
    const externalEvidenceRefs: string[] = [];
    const parentReadableEvidenceRefs: string[] = [];

    for (const reference of sourceEvidenceRefs) {
      const workspaceRelative = asWorkspaceRelativePath(reference);
      if (!workspaceRelative) {
        externalEvidenceRefs.push(reference);
        continue;
      }

      parentReadableEvidenceRefs.push(`${WORKSPACE_PREFIX}${workspaceRelative}`);
    }

    return {
      ...artifact,
      sourceEvidenceRefs,
      parentReadableEvidenceRefs,
      sourceSessionId: workerSession.id,
      evidenceRefs: unique([...parentReadableEvidenceRefs, ...externalEvidenceRefs]),
    };
  }
}
