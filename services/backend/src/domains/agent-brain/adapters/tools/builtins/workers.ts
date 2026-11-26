import { createHash, randomUUID } from 'crypto';

import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { applyTerminal, checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import type {
  EnumerationDispositionRecordV1,
  EnumerationLeadDispositionV1,
  EnumerationWorkerResultV1,
  WorkerResultArtifact,
  WorkerTaskRecord,
  WorkerType,
} from '@/domains/agent-brain/domain/types';
import {
  normalizeMissionEnvelope,
  renderMissionEnvelope,
} from '@/domains/agent-brain/domain/workers/missionEnvelope';
import {
  computeEnumerationLeadFingerprint,
  computeEnumerationResultHash,
  isEnumerationArtifactPathForTask,
  isEnumerationLeadValidatorEligible,
  EnumerationWorkerResultInputV1Schema,
  normalizeEnumerationResultInputV1,
  parseEnumerationResultV1,
  sha256Canonical,
} from '@/domains/agent-brain/domain/workers/enumerationContracts';
import {
  ATTACK_OBJECTIVE_FAMILIES,
  ATTACK_RESULT_STATUSES,
  AttackResultV1Schema,
  type AttackResultV1,
} from '@/domains/agent-brain/domain/workers/attackContracts';
import {
  getWorkerSpawnReserveBlockReason,
  renderWorkerSelectionGuide,
} from '@/domains/agent-brain/domain/workers/workerContracts';
import { flushWorkspaceProjectionForTool } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';
import { phaseProfileRegistry } from '@/domains/security-ops/runs/PhaseProfileRegistry';
import { getEnumerationWorkerAdmissionState } from '@/domains/security-ops/runs/enumerationCapability';
import { getActivePhaseKey } from '@/domains/agent-brain/application/services/worker/WorkerDelegationShared';
import { resolveSecurityOpsToolContext } from './securityopsContext';
import { getSecurityOpsService } from './securityopsServiceRegistry';
import { requireUserId, resolveToolWorkspaceDir } from './securityops/shared';
import {
  enumerationWorkerDispositionTotal,
  enumerationWorkerResultTotal,
} from '@/shared/metrics/prometheusMetrics';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const SHARED_WORKSPACE_EVIDENCE_PREFIXES = [
  '/workspace/.artifacts/tool-results/',
  '/workspace/.artifacts/scans/',
] as const;

const isPromotableSharedWorkspaceEvidenceRef = (value: string): boolean => {
  const normalized = value.replace(/\\/gu, '/');
  if (normalized.split('/').includes('..')) {
    return false;
  }
  return SHARED_WORKSPACE_EVIDENCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const isSecurityOpsRunSession = (session: ReturnType<typeof getSessionFromContext>): boolean => {
  const securityops = session?.flags?.securityops;
  return isRecord(securityops) && typeof securityops.runId === 'string' && securityops.runId.trim().length > 0;
};

const isHostedResearchLabSession = (
  session: ReturnType<typeof getSessionFromContext>,
): boolean => {
  const securityops = session?.flags?.securityops;
  return isRecord(securityops) && securityops.runHost === 'research_lab';
};

const serializeTaskRecord = (task: WorkerTaskRecord): Record<string, unknown> => ({
  taskId: task.taskId,
  parentSessionId: task.parentSessionId,
  workerSessionId: task.workerSessionId,
  workerType: task.workerType,
  ...(typeof task.waveIndex === 'number' ? { waveIndex: task.waveIndex } : {}),
  ...(typeof task.planStepId === 'string' ? { planStepId: task.planStepId } : {}),
  ...(task.mission ? { mission: task.mission } : {}),
  status: task.status,
  reason: task.reason,
  task: task.task,
  expectedArtifactType: task.expectedArtifactType,
  executionMode: task.executionMode,
  ...(task.dependencyMode ? { dependencyMode: task.dependencyMode } : {}),
  continuationMode: task.continuationMode,
  ...(task.writeScope ? { writeScope: task.writeScope } : {}),
  ...(task.budget ? { budget: task.budget } : {}),
  ...(typeof task.continuationCount === 'number' ? { continuationCount: task.continuationCount } : {}),
  ...(typeof task.retryIndex === 'number' ? { retryIndex: task.retryIndex } : {}),
  ...(typeof task.targetRequestsUsed === 'number' ? { targetRequestsUsed: task.targetRequestsUsed } : {}),
  ...(task.enumerationAttempts ? { enumerationAttempts: task.enumerationAttempts } : {}),
  ...(typeof task.deadlineAt === 'number' ? { deadlineAt: task.deadlineAt } : {}),
  ...(task.enumerationCapability ? { enumerationCapability: task.enumerationCapability } : {}),
  createdAt: task.createdAt,
  ...(task.startedAt ? { startedAt: task.startedAt } : {}),
  ...(task.completedAt ? { completedAt: task.completedAt } : {}),
  ...(task.lastUpdatedAt ? { lastUpdatedAt: task.lastUpdatedAt } : {}),
  ...(task.lastStatusReason ? { lastStatusReason: task.lastStatusReason } : {}),
  ...(task.lastError ? { lastError: task.lastError } : {}),
  ...(task.summary ? { summary: task.summary } : {}),
  ...(task.artifact ? { artifact: task.artifact } : {}),
  ...(task.enumerationDisposition ? { enumerationDisposition: task.enumerationDisposition } : {}),
  ...(task.attackDisposition ? { attackDisposition: task.attackDisposition } : {}),
});

const WORKER_SELECTION_GUIDE = renderWorkerSelectionGuide();
const DEFAULT_SECURITYOPS_ACTIVE_WORKER_CAP = 4;
const WORKER_TYPE_ENUM = [
  'recon_worker',
  'enumeration_worker',
  'validator_worker',
  'attack_worker',
  'evidence_worker',
  'repo_research_worker',
  'compliance_control_worker',
] as const;
const MISSION_PHASE_ENUM = [
  'planning',
  'recon',
  'enumeration',
  'validation',
  'exploitation',
  'evidence',
  'control_assessment',
  'reporting',
] as const;

const renderActivePhaseWorkerGuidance = (session: ReturnType<typeof getSessionFromContext>): string | null => {
  const activePhaseKey = getActivePhaseKey(session?.flags);
  if (!activePhaseKey) {
    return null;
  }
  const profile = phaseProfileRegistry.get(activePhaseKey);
  const allowedWorkerTypes = profile.workerSpawning.allowedWorkerTypes.filter(
    (workerType) =>
      workerType !== 'enumeration_worker' ||
      getEnumerationWorkerAdmissionState(session?.flags).allowed,
  );
  if (!profile.workerSpawning.allowed || allowedWorkerTypes.length === 0) {
    return `Active phase "${activePhaseKey}" does not allow worker delegation.`;
  }
  return `Active phase "${activePhaseKey}" allows only: ${allowedWorkerTypes.join(', ')}. Use mission.phase="${activePhaseKey}".`;
};

const resolveSecurityOpsActiveWorkerCap = (session: ReturnType<typeof getSessionFromContext>): number => {
  const configured = isRecord(session?.flags?.securityops)
    ? session.flags.securityops.maxActiveWorkers
    : undefined;
  const raw =
    typeof configured === 'number'
      ? configured
      : typeof process.env.SECURITYOPS_MAX_ACTIVE_WORKERS === 'string'
        ? Number(process.env.SECURITYOPS_MAX_ACTIVE_WORKERS)
        : DEFAULT_SECURITYOPS_ACTIVE_WORKER_CAP;
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : DEFAULT_SECURITYOPS_ACTIVE_WORKER_CAP;
};

const isActiveWorkerStatus = (status: unknown): boolean => {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return normalized === 'pending' || normalized === 'running' || normalized === 'awaiting_approval';
};

const getActiveWorkerAdmission = (
  session: ReturnType<typeof getSessionFromContext>,
): { activeCount: number; cap: number; activeTaskIds: string[] } | null => {
  if (!isSecurityOpsRunSession(session)) {
    return null;
  }
  const cap = resolveSecurityOpsActiveWorkerCap(session);
  const tasks = Array.isArray(session?.workerTasks) ? session.workerTasks : [];
  const activeTaskIds = tasks
    .filter((task): task is WorkerTaskRecord => isRecord(task) && isActiveWorkerStatus(task.status))
    .map((task) => task.taskId)
    .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0);
  return {
    activeCount: activeTaskIds.length,
    cap,
    activeTaskIds,
  };
};

export const SpawnWorker: ToolImpl = {
  meta: {
    name: 'spawn_worker',
    description: [
      'Launch a bounded specialist worker from the current parent executor session.',
      'Use this for high-leverage research, implementation, or verification tasks that can run independently.',
      'Default behavior is background execution; set executionMode to "blocking" only when you need the worker result before continuing this turn.',
      'Use dependencyMode="dependency" when the parent should avoid overlapping work and treat the worker result as a gate for the next decision.',
      'Use dependencyMode="sidecar" when the worker is a parallel branch and the parent can keep progressing on non-overlapping work.',
      'Every worker task must be self-contained: include the exact target, purpose, expected artifact, and done condition.',
      'Worker roles are bounded execution templates, not micro-specialties. Choose the role for its tool and context shape, then specialize the mission in the task prompt.',
      'If the worker needs to save PoC scripts or local evidence, provide a narrow writeScope. Without writeScope, write-capable tools are withheld.',
      'SecurityOps runs use bounded worker waves. If active workers already meet the run cap, wait_for_worker and digest existing artifacts before spawning the next wave.',
      'SecurityOps worker spawns are phase-scoped. The active phase profile is authoritative: use only the worker types allowed for the current phase, and set mission.phase to the current phase.',
      'For compliance control assessment, use workerType="compliance_control_worker" with mission.phase="control_assessment". Do not use recon_worker or mission.phase="recon" inside compliance control assessment.',
      'You keep ownership of synthesis and final run reporting in the parent session. Validator workers may directly file report_finding only for issues they independently confirm.',
      'Available worker roles:',
      WORKER_SELECTION_GUIDE,
      'Do not use this for trivial file reads, one-off commands, or to ask one worker to monitor another worker.',
    ].join('\n'),
    category: 'delegation',
    schema: {
      type: 'object',
      properties: {
        workerType: {
          type: 'string',
          enum: [...WORKER_TYPE_ENUM],
          description:
            'Worker template to spawn. It must be allowed by the active phase profile. ' +
            'Compliance control_assessment phases use compliance_control_worker; pentest recon phases use recon_worker.\n' +
            WORKER_SELECTION_GUIDE,
        },
        task: { type: 'string', description: 'The bounded task the worker should complete.' },
        reason: { type: 'string', description: 'Why delegation is needed.' },
        expectedArtifactType: { type: 'string', description: 'Artifact type expected back from the worker.' },
        mission: {
          type: 'object',
          description:
            'Graph-lite mission envelope for this worker: the exact phase, question, why it is ready now, required evidence, expected artifact, stop condition, assigned skills, and optional parallel_safe_with.',
          properties: {
            phase: {
              type: 'string',
              enum: [...MISSION_PHASE_ENUM],
            },
            question: { type: 'string' },
            why_ready_now: { type: 'string' },
            required_evidence: { type: 'array', items: { type: 'string' } },
            expected_artifact: { type: 'string' },
            stop_condition: { type: 'string' },
            assigned_skills: { type: 'array', items: { type: 'string' } },
            parallel_safe_with: { type: 'array', items: { type: 'string' } },
            enumeration: {
              type: 'object',
              description: 'Required only for enumeration_worker. Versioned, bounded enumeration_hunt_v1 contract.',
              properties: {
                schemaVersion: { type: 'integer', enum: [1] },
                kind: { type: 'string', enum: ['enumeration_hunt_v1'] },
                phaseAttemptId: { type: 'string' },
                targetRef: { type: 'string' },
                surface: {
                  type: 'object',
                  properties: {
                    kind: {
                      type: 'string',
                      enum: [
                        'endpoint_set',
                        'api_operation_set',
                        'path_prefix_set',
                        'component',
                        'client_bundle_set',
                        'repository_path_set',
                      ],
                    },
                    refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25 },
                  },
                  required: ['kind', 'refs'],
                },
                techniqueIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
                primarySkill: {
                  type: 'object',
                  properties: { slug: { type: 'string' }, versionHash: { type: 'string' } },
                  required: ['slug', 'versionHash'],
                },
                supportingSkills: {
                  type: 'array',
                  maxItems: 2,
                  items: {
                    type: 'object',
                    properties: { slug: { type: 'string' }, versionHash: { type: 'string' } },
                    required: ['slug', 'versionHash'],
                  },
                },
                personaRefs: { type: 'array', items: { type: 'string' }, maxItems: 3 },
                sourceMode: { type: 'string', enum: ['blackbox', 'greybox', 'whitebox'] },
                impactCeiling: { type: 'string', enum: ['non_destructive', 'poc'] },
                budgets: {
                  type: 'object',
                  properties: {
                    maxToolCalls: { type: 'integer', minimum: 1, maximum: 32 },
                    maxTargetRequests: { type: 'integer', minimum: 1, maximum: 80 },
                    maxRequestConcurrency: { type: 'integer', minimum: 1, maximum: 4 },
                    maxWallSeconds: { type: 'integer', minimum: 1, maximum: 600 },
                    maxArtifactFiles: { type: 'integer', minimum: 1, maximum: 25 },
                    maxArtifactBytes: { type: 'integer', minimum: 1, maximum: 10485760 },
                    maxLeads: { type: 'integer', minimum: 1, maximum: 40 },
                    maxStateChanges: { type: 'integer', enum: [0] },
                  },
                  required: [
                    'maxToolCalls',
                    'maxTargetRequests',
                    'maxRequestConcurrency',
                    'maxWallSeconds',
                    'maxArtifactFiles',
                    'maxArtifactBytes',
                    'maxLeads',
                    'maxStateChanges',
                  ],
                },
                stop: {
                  type: 'object',
                  properties: {
                    whenTechniquesExhausted: { type: 'boolean', enum: [true] },
                    whenBlockedByPolicy: { type: 'boolean', enum: [true] },
                    maxHighConfidenceLeads: { type: 'integer', minimum: 1, maximum: 10 },
                  },
                  required: ['whenTechniquesExhausted', 'whenBlockedByPolicy', 'maxHighConfidenceLeads'],
                },
                missionFingerprint: { type: 'string' },
              },
              required: [
                'schemaVersion',
                'kind',
                'phaseAttemptId',
                'targetRef',
                'surface',
                'techniqueIds',
                'primarySkill',
                'supportingSkills',
                'personaRefs',
                'sourceMode',
                'impactCeiling',
                'budgets',
                'stop',
                'missionFingerprint',
              ],
            },
            attack: {
              type: 'object',
              description: 'Required only for attack_worker. Strict controlled_exploitation_v1 mission.',
              additionalProperties: false,
              properties: {
                schemaVersion: { type: 'integer', enum: [1] },
                kind: { type: 'string', enum: ['controlled_exploitation_v1'] },
                objectiveFamily: { type: 'string', enum: [...ATTACK_OBJECTIVE_FAMILIES] },
                objective: { type: 'string' },
                validatedFindingIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
                targetRef: { type: 'string' },
                boundedPaths: { type: 'array', items: { type: 'string' }, maxItems: 25 },
                allowedImpact: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
                requestBudget: { type: 'integer', minimum: 1, maximum: 100, default: 60 },
                toolBudget: { type: 'integer', minimum: 1, maximum: 45, default: 30 },
                timeBudgetSeconds: { type: 'integer', minimum: 1, maximum: 900, default: 600 },
                maxRequestConcurrency: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
                requiredProof: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
                stopConditions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
                cleanupPlan: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
              },
              required: [
                'schemaVersion',
                'kind',
                'objectiveFamily',
                'objective',
                'validatedFindingIds',
                'targetRef',
                'allowedImpact',
                'requestBudget',
                'toolBudget',
                'timeBudgetSeconds',
                'requiredProof',
                'stopConditions',
                'cleanupPlan',
              ],
            },
          },
          required: ['question', 'why_ready_now', 'required_evidence', 'expected_artifact', 'stop_condition'],
        },
        executionMode: {
          type: 'string',
          enum: ['blocking', 'background'],
          description: 'background is the default and preferred mode for independent work; use blocking only when the result is needed before the next action.',
        },
        dependencyMode: {
          type: 'string',
          enum: ['dependency', 'sidecar'],
          description: 'dependency means the parent should treat this worker as a gating dependency; sidecar means parallel branch work.',
        },
        continuationMode: {
          type: 'string',
          enum: ['spawn', 'continue'],
          description: 'Use continue when re-entering an existing line of work; use spawn for a fresh context.',
        },
        planStepId: {
          type: 'string',
          description: 'Optional linked parent plan step ID. Prefer passing this when the worker owns a specific plan task.',
        },
        writeScope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit write scope the worker may touch, if any.',
        },
        budget: {
          type: 'object',
          properties: {
            maxToolCalls: { type: 'integer', minimum: 1 },
          },
        },
      },
      required: ['workerType', 'task', 'reason'],
    },
    risks: ['compute'],
  },
  async run(args, ctx) {
    return runWithGuards(
      SpawnWorker.meta,
      ctx,
      async () => {
        if (!ctx.workers) {
          return { ok: false, data: { error: 'Worker delegation is not available in this runtime.' } };
        }

        const session = getSessionFromContext(ctx);
        const workerType = asString(args.workerType) as WorkerType | undefined;
        const task = asString(args.task);
        const reason = asString(args.reason);
        if (!workerType || !task || !reason) {
          return { ok: false, data: { error: 'workerType, task, and reason are required.' } };
        }
        const activePhaseGuidance = renderActivePhaseWorkerGuidance(session);
        const mission = normalizeMissionEnvelope(args.mission);
        // Only enumeration_worker and attack_worker consume a typed sub-mission
        // (mission.enumeration / mission.attack). recon/validator/evidence workers
        // ran for years on task+reason alone; requiring the full graph-lite envelope
        // for them was B2 ceremony that blocked the agent's own recon spawns
        // (observed in r5: 2 of 3 spawn attempts rejected as "mission is required").
        const missionRequiredForWorker =
          workerType === 'enumeration_worker' || workerType === 'attack_worker';
        if (isSecurityOpsRunSession(session) && missionRequiredForWorker && !mission) {
          return {
            ok: false,
            data: {
              error:
                `spawn_worker blocked: ${workerType} requires a typed mission envelope ` +
                '(phase, question, why_ready_now, required_evidence, expected_artifact, stop_condition, assigned_skills' +
                (workerType === 'enumeration_worker'
                  ? ', plus the enumeration_hunt_v1 sub-mission).'
                  : ', plus the attack sub-mission).'),
              ...(activePhaseGuidance ? { activePhaseGuidance } : {}),
            },
          };
        }

        const requestedBudget = mission?.enumeration
          ? { ...mission.enumeration.budgets }
          : mission?.attack
            ? {
                maxToolCalls: mission.attack.toolBudget,
                maxTargetRequests: mission.attack.requestBudget,
                maxRequestConcurrency: mission.attack.maxRequestConcurrency,
                maxWallSeconds: mission.attack.timeBudgetSeconds,
              }
          : isRecord(args.budget)
            ? {
                ...(typeof args.budget.maxToolCalls === 'number'
                  ? { maxToolCalls: Math.trunc(args.budget.maxToolCalls) }
                  : {}),
              }
            : undefined;
        const planStepId =
          asString((args as Record<string, unknown>).planStepId) ??
          asString((args as Record<string, unknown>).__planStepId) ??
          asString((args as Record<string, unknown>).stepId);

        const reserveBlockReason = getWorkerSpawnReserveBlockReason(
          session,
          ctx.budget,
          workerType,
        );
        if (reserveBlockReason) {
          return {
            ok: false,
            data: {
              error: reserveBlockReason,
              reserveActive: true,
              remainingToolCalls:
                typeof ctx.budget?.remainingToolCalls === 'number'
                  ? Math.max(0, ctx.budget.remainingToolCalls - 1)
                  : undefined,
              reservedToolCalls: ctx.budget?.reservedToolCalls,
            },
          };
        }

        const activeWorkerAdmission = getActiveWorkerAdmission(session);
        if (
          activeWorkerAdmission &&
          activeWorkerAdmission.activeCount >= activeWorkerAdmission.cap &&
          asString(args.continuationMode) !== 'continue'
        ) {
          return {
            ok: false,
            data: {
              error:
                `spawn_worker blocked: ${activeWorkerAdmission.activeCount} active worker(s) already meet the SecurityOps cap of ${activeWorkerAdmission.cap}. ` +
                'Call wait_for_worker, ingest/digest completed artifacts, then spawn the next worker wave.',
              workerAdmissionActive: true,
              activeWorkerCount: activeWorkerAdmission.activeCount,
              maxActiveWorkers: activeWorkerAdmission.cap,
              activeTaskIds: activeWorkerAdmission.activeTaskIds.slice(0, 10),
              nextAction: 'wait_for_worker',
            },
          };
        }

        const projectionFlush = isHostedResearchLabSession(session)
          ? { warning: undefined }
          : await flushWorkspaceProjectionForTool({
              ctx,
              reason: 'before_worker_spawn',
              forceModel: true,
            });
        if (projectionFlush.warning) {
          return {
            ok: false,
            data: {
              error: `spawn_worker blocked: ${projectionFlush.warning}`,
              projectionWarning: projectionFlush.warning,
            },
          };
        }

        const result = await ctx.workers.spawnWorker({
          parentSessionId: ctx.sessionId,
          workerType,
          task,
          reason,
          expectedArtifactType: asString(args.expectedArtifactType),
          ...(mission ? { mission } : {}),
          executionMode: asString(args.executionMode) as 'blocking' | 'background' | undefined,
          dependencyMode: asString(args.dependencyMode) as 'dependency' | 'sidecar' | undefined,
          continuationMode: asString(args.continuationMode) as 'spawn' | 'continue' | undefined,
          planStepId,
          writeScope: asStringArray(args.writeScope),
          budget: requestedBudget,
        });

        return {
          ok: true,
          data: {
            success: true,
            task: serializeTaskRecord(result.task),
            ...(result.artifact ? { artifact: result.artifact } : {}),
            sessionId: result.sessionId,
          },
        };
      },
      {},
      {
        workerType: String(args.workerType ?? ''),
        task: String(args.task ?? ''),
        mission: args.mission ? renderMissionEnvelope(normalizeMissionEnvelope(args.mission) ?? {
          question: '',
          whyReadyNow: '',
          requiredEvidence: [],
          expectedArtifact: '',
          stopCondition: '',
        }).join(' | ') : '',
      },
    );
  },
};

export const ContinueWorker: ToolImpl = {
  meta: {
    name: 'continue_worker',
    description: [
      'Resume or re-enter an existing worker task from the current parent executor session.',
      'Use this when the worker already has useful context: corrections, follow-up validation, or a narrower next step on the same path.',
      'Provide a synthesized, specific instruction. Do not say "based on your findings".',
    ].join('\n'),
    category: 'delegation',
    schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The worker task identifier to continue.' },
        instruction: { type: 'string', description: 'Optional follow-up instruction for the worker.' },
      },
      required: ['taskId'],
    },
    risks: ['compute'],
  },
  async run(args, ctx) {
    return runWithGuards(
      ContinueWorker.meta,
      ctx,
      async () => {
        if (!ctx.workers) {
          return { ok: false, data: { error: 'Worker delegation is not available in this runtime.' } };
        }

        const taskId = asString(args.taskId);
        if (!taskId) {
          return { ok: false, data: { error: 'taskId is required.' } };
        }

        const result = await ctx.workers.continueWorker({
          parentSessionId: ctx.sessionId,
          taskId,
          instruction: asString(args.instruction),
          budget: ctx.budget,
        });

        return {
          ok: true,
          data: {
            success: true,
            task: serializeTaskRecord(result.task),
            ...(result.artifact ? { artifact: result.artifact } : {}),
            sessionId: result.sessionId,
          },
        };
      },
      {},
      { taskId: String(args.taskId ?? '') },
    );
  },
};

export const StopWorker: ToolImpl = {
  meta: {
    name: 'stop_worker',
    description: [
      'Cancel a worker task from the current parent executor session.',
      'Use this when the worker is on the wrong path, requirements changed, or you already have enough evidence.',
      'Do not stop workers just to poll status; running background workers report through WORKER TASKS.',
    ].join('\n'),
    category: 'delegation',
    schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The worker task identifier to stop.' },
        reason: { type: 'string', description: 'Why the worker is being stopped.' },
      },
      required: ['taskId'],
    },
    risks: ['compute'],
  },
  async run(args, ctx) {
    return runWithGuards(
      StopWorker.meta,
      ctx,
      async () => {
        if (!ctx.workers) {
          return { ok: false, data: { error: 'Worker delegation is not available in this runtime.' } };
        }

        const taskId = asString(args.taskId);
        if (!taskId) {
          return { ok: false, data: { error: 'taskId is required.' } };
        }

        const result = await ctx.workers.stopWorker({
          parentSessionId: ctx.sessionId,
          taskId,
          reason: asString(args.reason),
        });

        return {
          ok: true,
          data: {
            success: true,
            task: serializeTaskRecord(result.task),
            sessionId: result.sessionId,
          },
        };
      },
      {},
      { taskId: String(args.taskId ?? '') },
    );
  },
};

export const WaitForWorker: ToolImpl = {
  meta: {
    name: 'wait_for_worker',
    description: [
      'Wait for a worker task to change state, return an artifact, or time out.',
      'Pass taskId to wait for a specific worker when that result matters to your next move.',
      'If you omit taskId, wait_for_worker yields until any currently active worker changes state or the timeout expires.',
      'Do not use this for trivial polling.',
    ].join('\n'),
    category: 'delegation',
    schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional worker task identifier to wait on. Omit to yield until any active worker changes state.' },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: 'Optional wait timeout in milliseconds. Defaults to 30000.',
        },
      },
    },
    risks: ['compute'],
  },
  async run(args, ctx) {
    return runWithGuards(
      WaitForWorker.meta,
      ctx,
      async () => {
        if (!ctx.workers) {
          return { ok: false, data: { error: 'Worker delegation is not available in this runtime.' } };
        }

        const taskId = asString(args.taskId);
        const timeoutMs = typeof args.timeoutMs === 'number' ? Math.trunc(args.timeoutMs) : undefined;
        const result = await ctx.workers.waitForWorker({
          parentSessionId: ctx.sessionId,
          ...(taskId ? { taskId } : {}),
          timeoutMs,
          signal: ctx.abortSignal,
        });

        return {
          ok: true,
          data: {
            success: true,
            task: serializeTaskRecord(result.task),
            ...(result.artifact ? { artifact: result.artifact } : {}),
            sessionId: result.sessionId,
          },
        };
      },
      {},
      { taskId: String(args.taskId ?? '') },
    );
  },
};

export const SubmitWorkerResult: ToolImpl = {
  meta: {
    name: 'submit_worker_result',
    description: [
      'Submit the structured result artifact for the current worker session and mark it complete.',
      'Use this exactly once when the delegated task is done or decisively blocked.',
      'Include concrete findings, evidence refs, touched targets, and the best next action for the parent executor.',
      'All agents in this run share /workspace. Write useful files under /workspace/... (scanner output under /workspace/.artifacts/scans/<task-or-tool>/) and list their /workspace/... paths in evidenceRefs. The parent reads them directly at the same paths — no copy is made.',
    ].join('\n'),
    category: 'delegation',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-paragraph summary of the worker outcome.' },
        findings: { type: 'array', items: { type: 'string' } },
        evidenceRefs: { type: 'array', items: { type: 'string' } },
        touchedTargets: { type: 'array', items: { type: 'string' } },
        recommendedNextAction: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        enumeration: {
          type: 'object',
          description:
            'Required for enumeration_worker. Strict enumeration_result/v1 payload. resultHash is advisory on input and is replaced by the server-computed canonical hash.',
          properties: {
            schemaVersion: { type: 'integer', enum: [1] },
            missionFingerprint: { type: 'string' },
            resultHash: { type: 'string' },
            status: { type: 'string', enum: ['completed', 'partial', 'blocked', 'failed'] },
            targetRef: { type: 'string' },
            surfaceRefs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25 },
            skills: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: true } },
            leads: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: true } },
            negativeResults: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: true } },
            attempts: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: true } },
            coverage: { type: 'object', additionalProperties: true },
            blockers: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: true } },
            artifacts: { type: 'array', maxItems: 25, items: { type: 'object', additionalProperties: true } },
            recommendedValidationMissions: {
              type: 'array',
              maxItems: 5,
              items: { type: 'object', additionalProperties: true },
            },
          },
          required: [
            'schemaVersion',
            'status',
            'leads',
            'negativeResults',
            'blockers',
            'artifacts',
            'recommendedValidationMissions',
          ],
        },
        attack: {
          type: 'object',
          description: 'Required for attack_worker. Strict attack_result/v1 payload.',
          additionalProperties: false,
          properties: {
            schemaVersion: { type: 'integer', enum: [1] },
            missionId: { type: 'string' },
            validatedFindingIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
            targetRef: { type: 'string' },
            objectiveFamily: { type: 'string', enum: [...ATTACK_OBJECTIVE_FAMILIES] },
            status: { type: 'string', enum: [...ATTACK_RESULT_STATUSES] },
            attempts: { type: 'array', maxItems: 45, items: { type: 'object', additionalProperties: true } },
            proofClaim: { type: 'string' },
            evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
            changedStateSummary: { type: ['string', 'null'] },
            cleanup: { type: 'object', additionalProperties: true },
            limitations: { type: 'array', items: { type: 'string' }, maxItems: 25 },
            policySnapshot: { type: 'object', additionalProperties: true },
          },
          required: [
            'schemaVersion',
            'missionId',
            'validatedFindingIds',
            'targetRef',
            'objectiveFamily',
            'status',
            'attempts',
            'proofClaim',
            'evidenceIds',
            'changedStateSummary',
            'cleanup',
            'limitations',
            'policySnapshot',
          ],
        },
      },
      required: ['summary', 'findings', 'evidenceRefs', 'touchedTargets'],
    },
    risks: ['write'],
  },
  async run(args, ctx) {
    return runWithGuards(
      SubmitWorkerResult.meta,
      ctx,
      async () => {
        const session = getSessionFromContext(ctx);
        if (!session) {
          return { ok: false, data: { error: `Session ${ctx.sessionId} not found.` } };
        }
        if (session.coordination?.role !== 'worker' || !session.coordination.parentTaskId || !session.coordination.workerType) {
          return { ok: false, data: { error: 'submit_worker_result is only available to worker sessions.' } };
        }
        const terminal = checkSessionTerminal(session);
        if (terminal.kind === 'worker_result_submitted') {
          return {
            ok: true,
            data: {
              success: false,
              alreadySubmitted: true,
              terminal: true,
              error: 'submit_worker_result was already submitted for this worker. The recorded artifact is final; stop this worker session.',
              artifact: terminal.existingResult,
              nextAction: 'stop',
            },
          };
        }

        const summary = asString(args.summary);
        if (!summary) {
          return { ok: false, data: { error: 'summary is required.' } };
        }

        let enumeration: EnumerationWorkerResultV1 | undefined;
        let attack: AttackResultV1 | undefined;
        let promotedEnumerationEvidenceRefs: string[] = [];
        if (session.coordination.workerType === 'enumeration_worker') {
          const parentSession = session.coordination.parentSessionId
            ? ctx.sessionStore.get(session.coordination.parentSessionId)
            : undefined;
          const task = parentSession?.workerTasks?.find(
            (candidate) => candidate.taskId === session.coordination?.parentTaskId,
          );
          if (!task) {
            return {
              ok: false,
              data: { error: 'enumeration result rejected: owning parent task was not found.' },
            };
          }
          if (asStringArray(args.findings).length > 0) {
            return {
              ok: false,
              data: { error: 'enumeration_worker must leave generic findings empty; return unconfirmed leads in enumeration.leads.' },
            };
          }
          const parsedInput = EnumerationWorkerResultInputV1Schema.safeParse(args.enumeration);
          if (!parsedInput.success) {
            return {
              ok: false,
              data: {
                error: `enumeration result schema rejected: ${parsedInput.error.issues
                  .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                  .join('; ')}`,
              },
            };
          }
          const outsideArtifactRefs = parsedInput.data.artifacts.filter(
            (artifactRef) => !isEnumerationArtifactPathForTask(task.taskId, artifactRef.path),
          );
          const invalidOutsideArtifactRefs = outsideArtifactRefs.filter(
            (artifactRef) => !isPromotableSharedWorkspaceEvidenceRef(artifactRef.path),
          );
          if (invalidOutsideArtifactRefs.length > 0) {
            return {
              ok: false,
              data: {
                error:
                  'enumeration artifact rejected: files listed in enumeration.artifacts must be under '
                  + `/workspace/.artifacts/workers/enumeration/${task.taskId}/; `
                  + 'put shared tool output paths in evidenceRefs instead.',
                invalidArtifactPaths: invalidOutsideArtifactRefs.map((artifactRef) => artifactRef.path),
              },
            };
          }
          promotedEnumerationEvidenceRefs = outsideArtifactRefs.map((artifactRef) => artifactRef.path);
          const normalizedInput = normalizeEnumerationResultInputV1(parsedInput.data, task);
          for (const artifactRef of normalizedInput.artifacts) {
            if (!isEnumerationArtifactPathForTask(task.taskId, artifactRef.path)) {
              return {
                ok: false,
                data: {
                  error:
                    `enumeration artifact rejected: ${artifactRef.path} is outside the task artifact root`,
                },
              };
            }
            try {
              const stat = await ctx.sandbox.statFile(session, artifactRef.path);
              if (
                !stat.exists ||
                !stat.isFile ||
                stat.isSymbolicLink !== false ||
                stat.sizeBytes !== artifactRef.bytes
              ) {
                return {
                  ok: false,
                  data: {
                    error:
                      `enumeration artifact rejected: ${artifactRef.path} size/type does not match the manifest`,
                  },
                };
              }
              const content = await ctx.sandbox.readFile(
                session,
                artifactRef.path,
                artifactRef.bytes + 1,
              );
              if (content.byteLength !== artifactRef.bytes) {
                return {
                  ok: false,
                  data: { error: `enumeration artifact rejected: ${artifactRef.path} changed during validation` },
                };
              }
              const digest = createHash('sha256').update(content).digest('hex');
              if (digest !== artifactRef.sha256) {
                return {
                  ok: false,
                  data: { error: `enumeration artifact rejected: ${artifactRef.path} sha256 mismatch` },
                };
              }
              if (ENUMERATION_ARTIFACT_SECRET_PATTERN.test(content.toString('utf8'))) {
                return {
                  ok: false,
                  data: { error: `enumeration artifact rejected: ${artifactRef.path} contains secret-bearing material` },
                };
              }
            } catch (error) {
              return {
                ok: false,
                data: {
                  error:
                    `enumeration artifact rejected: ${artifactRef.path} could not be verified (${error instanceof Error ? error.message : String(error)})`,
                },
              };
            }
          }
          const securityops = isRecord(session.flags?.securityops)
            ? session.flags.securityops
            : {};
          const organizationId = asString(securityops.organizationId);
          const scopeId = asString(securityops.scopeId);
          const runId = asString(securityops.runId);
          if (!organizationId || !scopeId || !runId) {
            return {
              ok: false,
              data: { error: 'enumeration result rejected: organization, scope, and run ownership context are required.' },
            };
          }
          const enriched = {
            ...normalizedInput,
            leads: normalizedInput.leads.map((lead) => ({
              ...lead,
              serverFingerprint: computeEnumerationLeadFingerprint(
                organizationId,
                scopeId,
                runId,
                lead,
              ),
            })),
          };
          const serverResult = {
            ...enriched,
            resultHash: computeEnumerationResultHash(enriched),
          };
          try {
            enumeration = parseEnumerationResultV1(serverResult, task);
          } catch (error) {
            enumerationWorkerResultTotal.inc({ decision: 'rejected', status: 'invalid' });
            return {
              ok: false,
              data: {
                error: `enumeration result rejected: ${error instanceof Error ? error.message : String(error)}`,
              },
            };
          }
          enumerationWorkerResultTotal.inc({
            decision: 'accepted',
            status: enumeration.status,
          });
        } else if (args.enumeration !== undefined) {
          return {
            ok: false,
            data: { error: 'enumeration payload is only accepted from enumeration_worker sessions.' },
          };
        }

        if (session.coordination.workerType === 'attack_worker') {
          const parentSession = session.coordination.parentSessionId
            ? ctx.sessionStore.get(session.coordination.parentSessionId)
            : undefined;
          const task = parentSession?.workerTasks?.find(
            (candidate) => candidate.taskId === session.coordination?.parentTaskId,
          );
          if (!task?.mission?.attack) {
            return { ok: false, data: { error: 'attack result rejected: owning admitted attack mission was not found.' } };
          }
          if (asStringArray(args.findings).length > 0) {
            return {
              ok: false,
              data: { error: 'attack_worker cannot create findings; generic findings must be empty.' },
            };
          }
          const parsed = AttackResultV1Schema.safeParse(args.attack);
          if (!parsed.success) {
            return {
              ok: false,
              data: {
                error: `attack result schema rejected: ${parsed.error.issues
                  .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                  .join('; ')}`,
              },
            };
          }
          const mission = task.mission.attack;
          if (
            parsed.data.missionId !== task.taskId ||
            parsed.data.targetRef !== mission.targetRef ||
            parsed.data.objectiveFamily !== mission.objectiveFamily ||
            parsed.data.validatedFindingIds.length !== mission.validatedFindingIds.length ||
            parsed.data.validatedFindingIds.some((id) => !mission.validatedFindingIds.includes(id))
          ) {
            return {
              ok: false,
              data: { error: 'attack result rejected: task, target, objective, or validated finding binding does not match the admitted mission.' },
            };
          }
          const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : {};
          attack = {
            ...parsed.data,
            policySnapshot: {
              featureEnabled: true,
              organizationAllowlisted: true,
              runTrigger: 'manual',
              workflowDiscipline: 'pentest',
              impactTolerance: 'full',
              phaseKey: 'exploitation',
              verifiedTarget: true,
              requestBudget: task.mission.attack.requestBudget,
              toolBudget: task.mission.attack.toolBudget,
              timeBudgetSeconds: task.mission.attack.timeBudgetSeconds,
              capturedAt: new Date().toISOString(),
            },
          };
          if (
            securityops.activePhaseKey !== 'exploitation' ||
            securityops.exploitationImpactTolerance !== 'full'
          ) {
            return {
              ok: false,
              data: { error: 'attack result rejected: exploitation phase or full-RoE snapshot is missing.' },
            };
          }
          const attackResultPath =
            `.artifacts/workers/attack/${task.taskId}/attack-result.json`;
          await ctx.sandbox.writeFile(
            session,
            attackResultPath,
            JSON.stringify(attack, null, 2),
          );
        } else if (args.attack !== undefined) {
          return {
            ok: false,
            data: { error: 'attack payload is only accepted from attack_worker sessions.' },
          };
        }

        const evidenceRefs = Array.from(new Set([
          ...asStringArray(args.evidenceRefs),
          ...promotedEnumerationEvidenceRefs,
          ...(attack
            ? [`/workspace/.artifacts/workers/attack/${session.coordination.parentTaskId}/attack-result.json`]
            : []),
        ]));
        const artifact: WorkerResultArtifact = {
          taskId: session.coordination.parentTaskId,
          workerType: session.coordination.workerType,
          summary,
          findings: asStringArray(args.findings),
          evidenceRefs,
          sourceEvidenceRefs: evidenceRefs,
          touchedTargets: asStringArray(args.touchedTargets),
          ...(asString(args.recommendedNextAction) ? { recommendedNextAction: asString(args.recommendedNextAction) } : {}),
          ...(typeof args.confidence === 'number' ? { confidence: args.confidence } : {}),
          ...(enumeration ? { enumeration } : {}),
          ...(attack ? { attack } : {}),
        };

        session.workerResult = artifact;
        session.summary = summary;
        await applyTerminal(session, ctx, 'worker_result_submitted', artifact);

        return {
          ok: true,
          data: {
            success: true,
            terminal: true,
            nextAction: 'stop',
            artifact,
          },
        };
      },
      {},
      { summary: String(args.summary ?? '') },
    );
  },
};

const ENUMERATION_ARTIFACT_SECRET_PATTERN =
  /(?:authorization\s*:\s*(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}|cookie\s*:\s*[^\r\n]{8,}|(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*[^\s"'`]{6,})/iu;

const normalizeLeadDispositions = (value: unknown): EnumerationLeadDispositionV1[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: EnumerationLeadDispositionV1[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const leadLocalId = asString(entry.leadLocalId);
    const action = asString(entry.action);
    if (
      !leadLocalId ||
      (action !== 'accept' && action !== 'merge_duplicate' && action !== 'defer' && action !== 'reject')
    ) {
      return null;
    }
    normalized.push({
      leadLocalId,
      action,
      ...(asString(entry.existingLeadId) ? { existingLeadId: asString(entry.existingLeadId) } : {}),
      ...(asString(entry.reason) ? { reason: asString(entry.reason) } : {}),
      ...(asString(entry.nextPrerequisite) ? { nextPrerequisite: asString(entry.nextPrerequisite) } : {}),
    });
  }
  return normalized;
};

export const SubmitEnumerationDisposition: ToolImpl = {
  meta: {
    name: 'submit_enumeration_disposition',
    description: [
      'Parent-only enumeration phase tool that reconciles one terminal enumeration_worker task.',
      'For a typed result, dispose every lead exactly once as accept, merge_duplicate, defer, or reject and explicitly acknowledge coverage and negative results.',
      'For a terminal worker without a valid typed result, use acknowledge_terminal with a reason. Replays are idempotent; conflicting second dispositions are rejected.',
    ].join('\n'),
    category: 'delegation',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['disposition', 'acknowledge_terminal'] },
        taskId: { type: 'string' },
        resultHash: { type: 'string' },
        leadDispositions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              leadLocalId: { type: 'string' },
              action: { type: 'string', enum: ['accept', 'merge_duplicate', 'defer', 'reject'] },
              existingLeadId: { type: 'string' },
              reason: { type: 'string' },
              nextPrerequisite: { type: 'string' },
            },
            required: ['leadLocalId', 'action'],
          },
        },
        coverageAcknowledged: { type: 'boolean' },
        negativeResultsAcknowledged: { type: 'boolean' },
        terminalReason: { type: 'string' },
      },
      required: ['action', 'taskId'],
    },
    risks: ['write'],
    returns: 'json',
  },
  async run(args, ctx) {
    return runWithGuards(
      SubmitEnumerationDisposition.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to disposition enumeration results.' } };
        }
        await ctx.workers?.syncWorkerTasks(ctx.sessionId);
        const session = getSessionFromContext(ctx);
        if (!session || session.coordination?.role === 'worker') {
          return { ok: false, data: { error: 'submit_enumeration_disposition is parent-only.' } };
        }
        if (getActivePhaseKey(session.flags) !== 'enumeration') {
          return {
            ok: false,
            data: { error: 'submit_enumeration_disposition is restricted to the active enumeration phase.' },
          };
        }

        const taskId = asString(args.taskId);
        const action = asString(args.action);
        const task = session.workerTasks?.find((candidate) => candidate.taskId === taskId);
        if (!taskId || !task || task.workerType !== 'enumeration_worker') {
          return {
            ok: false,
            data: { error: 'A parent-owned enumeration_worker taskId is required.' },
          };
        }
        if (task.status === 'pending' || task.status === 'running' || task.status === 'awaiting_approval') {
          return {
            ok: false,
            data: { error: `Enumeration task ${task.taskId} is still ${task.status}; settle it before disposition.` },
          };
        }

        const leadDispositions = normalizeLeadDispositions(args.leadDispositions);
        if (leadDispositions === null) {
          return { ok: false, data: { error: 'leadDispositions must be an array of valid disposition objects.' } };
        }
        const coverageAcknowledged = args.coverageAcknowledged === true;
        const negativeResultsAcknowledged = args.negativeResultsAcknowledged === true;
        const terminalReason = asString(args.terminalReason);
        const payload = {
          action,
          taskId,
          ...(asString(args.resultHash) ? { resultHash: asString(args.resultHash) } : {}),
          leadDispositions,
          coverageAcknowledged,
          negativeResultsAcknowledged,
          ...(terminalReason ? { terminalReason } : {}),
        };
        const payloadHash = sha256Canonical(payload);
        if (task.enumerationDisposition) {
          if (task.enumerationDisposition.payloadHash !== payloadHash) {
            enumerationWorkerDispositionTotal.inc({
              action: action ?? 'unknown',
              outcome: 'conflict',
            });
            return {
              ok: false,
              data: {
                error: 'Enumeration task already has a different final disposition.',
                disposition: task.enumerationDisposition,
              },
            };
          }
          enumerationWorkerDispositionTotal.inc({
            action: task.enumerationDisposition.action,
            outcome: 'idempotent',
          });
          return {
            ok: true,
            data: { success: true, idempotent: true, disposition: task.enumerationDisposition },
          };
        }

        if (action === 'acknowledge_terminal') {
          if (task.artifact?.enumeration) {
            return {
              ok: false,
              data: { error: 'A valid typed enumeration result must receive a complete lead disposition.' },
            };
          }
          if (!terminalReason || leadDispositions.length > 0) {
            return {
              ok: false,
              data: { error: 'acknowledge_terminal requires terminalReason and no lead dispositions.' },
            };
          }
          const record: EnumerationDispositionRecordV1 = {
            action,
            terminalStateVersion: sha256Canonical({
              status: task.status,
              completedAt: task.completedAt,
              lastError: task.lastError,
              lastStatusReason: task.lastStatusReason,
            }),
            payloadHash,
            completedAt: Date.now(),
            leadDispositions: [],
            canonicalLeadIds: [],
            validatorEligibleLeadIds: [],
            coverageAcknowledged: false,
            negativeResultsAcknowledged: false,
            terminalReason,
          };
          const terminalWrite = await ctx.sessionStore.updateSessionAsync(ctx.sessionId, (current): {
            state: 'written' | 'idempotent' | 'conflict';
            existing?: EnumerationDispositionRecordV1;
          } => {
            const currentTask = current.workerTasks?.find((candidate) => candidate.taskId === task.taskId);
            if (!currentTask) {
              return { state: 'conflict' };
            }
            if (currentTask.enumerationDisposition) {
              return {
                state: currentTask.enumerationDisposition.payloadHash === payloadHash
                  ? 'idempotent'
                  : 'conflict',
                existing: currentTask.enumerationDisposition,
              };
            }
            currentTask.enumerationDisposition = record;
            currentTask.lastUpdatedAt = record.completedAt;
            return { state: 'written' };
          });
          if (!terminalWrite || terminalWrite.state === 'conflict') {
            enumerationWorkerDispositionTotal.inc({
              action: 'acknowledge_terminal',
              outcome: 'conflict',
            });
            return {
              ok: false,
              data: { error: 'Enumeration task received a conflicting concurrent acknowledgement.' },
            };
          }
          if (terminalWrite.state === 'idempotent') {
            return {
              ok: true,
              data: { success: true, idempotent: true, disposition: terminalWrite.existing },
            };
          }
          await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? 0, {
            event: 'enumeration_worker.disposition.completed',
            severity: 'info',
            payload: {
              taskId: task.taskId,
              action: record.action,
              terminalStateVersion: record.terminalStateVersion,
            },
            note: `acknowledged terminal enumeration task ${task.taskId}`,
          });
          enumerationWorkerDispositionTotal.inc({
            action: 'acknowledge_terminal',
            outcome: 'completed',
          });
          return { ok: true, data: { success: true, disposition: record } };
        }
        if (action !== 'disposition') {
          return { ok: false, data: { error: 'action must be disposition or acknowledge_terminal.' } };
        }

        const result = task.artifact?.enumeration;
        if (!result) {
          return {
            ok: false,
            data: { error: 'No valid enumeration_result/v1 is attached; acknowledge the terminal state instead.' },
          };
        }
        if (asString(args.resultHash) !== result.resultHash) {
          return { ok: false, data: { error: 'resultHash does not match the terminal worker result.' } };
        }
        if (!coverageAcknowledged || !negativeResultsAcknowledged) {
          return {
            ok: false,
            data: { error: 'coverageAcknowledged and negativeResultsAcknowledged must both be true.' },
          };
        }

        const localIds = result.leads.map((lead) => lead.localId);
        const dispositionIds = leadDispositions.map((entry) => entry.leadLocalId);
        if (
          new Set(localIds).size !== localIds.length ||
          new Set(dispositionIds).size !== dispositionIds.length ||
          dispositionIds.length !== localIds.length ||
          dispositionIds.some((localId) => !localIds.includes(localId))
        ) {
          return {
            ok: false,
            data: { error: 'leadDispositions must cover every returned lead localId exactly once.' },
          };
        }

        for (const disposition of leadDispositions) {
          if (disposition.action === 'merge_duplicate' && !disposition.existingLeadId) {
            return {
              ok: false,
              data: { error: `merge_duplicate for ${disposition.leadLocalId} requires existingLeadId.` },
            };
          }
          if (disposition.action === 'defer' && !disposition.nextPrerequisite) {
            return {
              ok: false,
              data: { error: `defer for ${disposition.leadLocalId} requires nextPrerequisite.` },
            };
          }
          if (disposition.action === 'reject' && !disposition.reason) {
            return {
              ok: false,
              data: { error: `reject for ${disposition.leadLocalId} requires reason.` },
            };
          }
        }

        const dispositionOwnerId = ctx.toolCallId ?? randomUUID();
        const reservation = await ctx.sessionStore.updateSessionAsync(ctx.sessionId, (current): {
          state: 'acquired' | 'resumed' | 'in_progress' | 'idempotent' | 'conflict';
          existing?: EnumerationDispositionRecordV1;
        } => {
          const currentTask = current.workerTasks?.find((candidate) => candidate.taskId === task.taskId);
          if (!currentTask) {
            return { state: 'conflict' };
          }
          if (currentTask.enumerationDisposition) {
            return {
              state: currentTask.enumerationDisposition.payloadHash === payloadHash
                ? 'idempotent'
                : 'conflict',
              existing: currentTask.enumerationDisposition,
            };
          }
          if (currentTask.enumerationDispositionReservation) {
            if (currentTask.enumerationDispositionReservation.payloadHash !== payloadHash) {
              return { state: 'conflict' };
            }
            if (
              currentTask.enumerationDispositionReservation.ownerId &&
              currentTask.enumerationDispositionReservation.ownerId !== dispositionOwnerId
            ) {
              return { state: 'in_progress' };
            }
            currentTask.enumerationDispositionReservation.ownerId = dispositionOwnerId;
            return { state: 'resumed' };
          }
          currentTask.enumerationDispositionReservation = {
            payloadHash,
            acquiredAt: Date.now(),
            ownerId: dispositionOwnerId,
          };
          return { state: 'acquired' };
        });
        if (!reservation || reservation.state === 'conflict') {
          enumerationWorkerDispositionTotal.inc({ action: 'disposition', outcome: 'conflict' });
          return {
            ok: false,
              data: { error: 'Enumeration task has a different disposition in progress or completed.' },
          };
        }
        if (reservation.state === 'idempotent') {
          return {
            ok: true,
            data: { success: true, idempotent: true, disposition: reservation.existing },
          };
        }
        if (reservation.state === 'in_progress') {
          enumerationWorkerDispositionTotal.inc({ action: 'disposition', outcome: 'in_progress' });
          return {
            ok: false,
            data: {
              error: 'An identical enumeration disposition is already in progress.',
              retryable: true,
            },
          };
        }

        try {
        const context = resolveSecurityOpsToolContext(ctx);
        const service = getSecurityOpsService(ctx);
        const mergeIds = new Set(
          leadDispositions
            .map((entry) => entry.action === 'merge_duplicate' ? entry.existingLeadId : undefined)
            .filter((entry): entry is string => Boolean(entry)),
        );
        if (mergeIds.size > 0) {
          const existing = await service.queryNotes({
            userId,
            context,
            input: { ntype: 'validation.lead', limit: 500 },
          });
          const ownedIds = new Set(existing.notes.map((note) => note.id));
          const missingIds = [...mergeIds].filter((id) => !ownedIds.has(id));
          if (missingIds.length > 0) {
            await ctx.sessionStore.updateSessionAsync(ctx.sessionId, (current) => {
              const currentTask = current.workerTasks?.find((candidate) => candidate.taskId === task.taskId);
              if (
                currentTask?.enumerationDispositionReservation?.payloadHash === payloadHash &&
                currentTask.enumerationDispositionReservation.ownerId === dispositionOwnerId
              ) {
                delete currentTask.enumerationDispositionReservation;
              }
            });
            return {
              ok: false,
              data: { error: `merge_duplicate references non-owned validation lead(s): ${missingIds.join(', ')}` },
            };
          }
        }

        const leadByLocalId = new Map(result.leads.map((lead) => [lead.localId, lead]));
        const canonicalLeadIds: string[] = [];
        const validatorEligibleLeadIds: string[] = [];
        for (const disposition of leadDispositions) {
          const lead = leadByLocalId.get(disposition.leadLocalId);
          if (!lead) {
            continue;
          }
          if (disposition.action === 'merge_duplicate' && disposition.existingLeadId) {
            canonicalLeadIds.push(disposition.existingLeadId);
            if (isEnumerationLeadValidatorEligible(lead)) {
              validatorEligibleLeadIds.push(disposition.existingLeadId);
            }
            continue;
          }
          if (disposition.action !== 'accept') {
            continue;
          }
          const note = await service.reportNote({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir: resolveToolWorkspaceDir(ctx, session),
            context,
            input: {
              ntype: 'validation.lead',
              title: `${lead.riskFamily} enumeration lead for ${lead.surfaceRef}`,
              confidence: lead.confidence,
              data: {
                source: `enumeration_worker:${task.taskId}`,
                priority: lead.priority,
                riskFamily: lead.riskFamily,
                target: lead.targetRef,
                path: lead.surfaceRef,
                hypothesis: lead.hypothesis,
                requiredControls: lead.requiredControls,
                requiredPrerequisites: lead.prerequisites,
                evidenceRefs: lead.evidenceRefs,
                attempts: lead.attemptFingerprints.length,
                enumerationTaskId: task.taskId,
                enumerationResultHash: result.resultHash,
                enumerationLeadFingerprint: lead.serverFingerprint,
                enumerationLeadLocalId: lead.localId,
                techniqueId: lead.techniqueId,
                surfaceRef: lead.surfaceRef,
                skillRefs: result.skills,
                validationGoal: lead.validationGoal,
                observation: lead.observation,
                authContextClass: lead.authContextClass,
                status: 'open',
              },
            },
          });
          canonicalLeadIds.push(note.noteId);
          if (isEnumerationLeadValidatorEligible(lead)) {
            validatorEligibleLeadIds.push(note.noteId);
          }
        }

        await service.reportNote({
          userId,
          sessionId: ctx.sessionId,
          workspaceDir: resolveToolWorkspaceDir(ctx, session),
          context,
          input: {
            ntype: 'enumeration.disposition',
            title: `Enumeration disposition for ${task.taskId}`,
            data: {
              taskId: task.taskId,
              missionFingerprint: result.missionFingerprint,
              resultHash: result.resultHash,
              payloadHash,
              coverageAcknowledged: true,
              negativeResultsAcknowledged: true,
              leadDispositions,
              canonicalLeadIds,
              validatorEligibleLeadIds,
              coverage: result.coverage,
              negativeResults: result.negativeResults,
              attempts: result.attempts,
              blockers: result.blockers,
            },
          },
        });

        const record: EnumerationDispositionRecordV1 = {
          action: 'disposition',
          resultHash: result.resultHash,
          payloadHash,
          completedAt: Date.now(),
          leadDispositions,
          canonicalLeadIds,
          validatorEligibleLeadIds,
          coverageAcknowledged: true,
          negativeResultsAcknowledged: true,
        };
        await ctx.sessionStore.updateSessionAsync(ctx.sessionId, (current) => {
          const currentTask = current.workerTasks?.find((candidate) => candidate.taskId === task.taskId);
          if (!currentTask) {
            throw new Error(`Enumeration task ${task.taskId} disappeared during disposition.`);
          }
          if (
            currentTask.enumerationDisposition &&
            currentTask.enumerationDisposition.payloadHash !== payloadHash
          ) {
            throw new Error('Enumeration task received a conflicting concurrent disposition.');
          }
          currentTask.enumerationDisposition = record;
          delete currentTask.enumerationDispositionReservation;
          currentTask.lastUpdatedAt = record.completedAt;
        });
        await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? 0, {
          event: 'enumeration_worker.disposition.completed',
          severity: 'info',
          payload: {
            taskId: task.taskId,
            action: record.action,
            resultHash: record.resultHash,
            leadOutcomes: record.leadDispositions.map((entry) => entry.action),
            canonicalLeadCount: record.canonicalLeadIds.length,
            validatorEligibleLeadCount: record.validatorEligibleLeadIds.length,
          },
          note: `dispositioned enumeration result for ${task.taskId}`,
        });
        enumerationWorkerDispositionTotal.inc({
          action: 'disposition',
          outcome: 'completed',
        });
        const projection = isHostedResearchLabSession(session)
          ? { warning: undefined }
          : await flushWorkspaceProjectionForTool({
              ctx,
              reason: 'enumeration_result_dispositioned',
              scopes: ['leads', 'model'],
            });
        return {
          ok: true,
          data: {
            success: true,
            disposition: record,
            ...(projection.warning ? { projectionWarning: projection.warning } : {}),
          },
        };
        } catch (error) {
          await ctx.sessionStore.updateSessionAsync(ctx.sessionId, (current) => {
            const currentTask = current.workerTasks?.find(
              (candidate) => candidate.taskId === task.taskId,
            );
            if (
              currentTask?.enumerationDispositionReservation?.payloadHash === payloadHash &&
              currentTask.enumerationDispositionReservation.ownerId === dispositionOwnerId
            ) {
              delete currentTask.enumerationDispositionReservation;
            }
          });
          enumerationWorkerDispositionTotal.inc({ action: 'disposition', outcome: 'failed' });
          return {
            ok: false,
            data: {
              error:
                `Enumeration disposition failed without committing terminal state: ${error instanceof Error ? error.message : String(error)}`,
              retryable: true,
            },
          };
        }
      },
      {},
      { taskId: String(args.taskId ?? ''), action: String(args.action ?? '') },
    );
  },
};

export const SubmitAttackDisposition: ToolImpl = {
  meta: {
    name: 'submit_attack_disposition',
    description: [
      'Parent-only exploitation phase tool that persists one terminal attack_worker result on its same-run confirmed Risks.',
      'Use action=disposition for a typed attack_result/v1. Use acknowledge_denied only when the worker terminated before producing a typed result.',
      'Impact status and cleanup status remain separate; this tool never changes canonical Risk state.',
    ].join('\n'),
    category: 'delegation',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['disposition', 'acknowledge_denied'] },
        taskId: { type: 'string' },
        terminalReason: { type: 'string' },
      },
      required: ['action', 'taskId'],
    },
    risks: ['write'],
    returns: 'json',
  },
  async run(args, ctx) {
    return runWithGuards(
      SubmitAttackDisposition.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to disposition attack results.' } };
        }
        await ctx.workers?.syncWorkerTasks(ctx.sessionId);
        const session = getSessionFromContext(ctx);
        if (!session || session.coordination?.role === 'worker') {
          return { ok: false, data: { error: 'submit_attack_disposition is parent-only.' } };
        }
        if (getActivePhaseKey(session.flags) !== 'exploitation') {
          return {
            ok: false,
            data: { error: 'submit_attack_disposition is restricted to the active exploitation phase.' },
          };
        }
        const taskId = asString(args.taskId);
        const action = asString(args.action);
        const terminalReason = asString(args.terminalReason);
        const task = session.workerTasks?.find((candidate) => candidate.taskId === taskId);
        if (!taskId || !task || task.workerType !== 'attack_worker') {
          return { ok: false, data: { error: 'A controlled exploitation attack_worker task is required.' } };
        }
        if (task.attackDisposition) {
          return {
            ok: true,
            data: { success: true, idempotent: true, disposition: task.attackDisposition },
          };
        }
        if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
          return { ok: false, data: { error: 'Attack worker must be terminal before disposition.' } };
        }

        if (action === 'acknowledge_denied') {
          if (!terminalReason) {
            return { ok: false, data: { error: 'terminalReason is required for acknowledge_denied.' } };
          }
          const record = {
            action: 'acknowledge_denied' as const,
            evidenceIds: [] as string[],
            terminalReason,
            completedAt: Date.now(),
          };
          await ctx.sessionStore.updateSessionAsync(ctx.sessionId, (current) => {
            const currentTask = current.workerTasks?.find((candidate) => candidate.taskId === taskId);
            if (currentTask) currentTask.attackDisposition = record;
          });
          await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? 0, {
            event: 'attack_worker.disposition.denied',
            severity: 'warn',
            payload: { taskId, terminalReason },
            note: `acknowledged denied attack worker ${taskId}`,
          });
          return { ok: true, data: { success: true, disposition: record } };
        }

        const result = task.artifact?.attack;
        if (action !== 'disposition' || !result) {
          return {
            ok: false,
            data: { error: 'A typed attack_result/v1 is required for action=disposition.' },
          };
        }
        const persisted = await getSecurityOpsService(ctx).persistControlledExploitationResult({
          userId,
          sessionId: ctx.sessionId,
          context: resolveSecurityOpsToolContext(ctx),
          result,
        });
        const record = {
          action: 'disposition' as const,
          resultStatus: result.status,
          evidenceIds: persisted.evidenceIds,
          completedAt: Date.now(),
        };
        await ctx.sessionStore.updateSessionAsync(ctx.sessionId, (current) => {
          const currentTask = current.workerTasks?.find((candidate) => candidate.taskId === taskId);
          if (currentTask) currentTask.attackDisposition = record;
        });
        await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? 0, {
          event: 'attack_worker.disposition.completed',
          severity:
            result.status === 'cleanup_failed' ||
            result.cleanup.status === 'failed' ||
            result.cleanup.status === 'unknown'
              ? 'warn'
              : 'info',
          payload: {
            taskId,
            findingIds: persisted.findingIds,
            status: result.status,
            cleanupStatus: result.cleanup.status,
            evidenceIds: persisted.evidenceIds,
          },
          note: `persisted controlled exploitation result for ${taskId}`,
        });
        return { ok: true, data: { success: true, disposition: record, persisted } };
      },
      {},
      { taskId: String(args.taskId ?? ''), action: String(args.action ?? '') },
    );
  },
};

export const WorkerBuiltins = [
  SpawnWorker,
  ContinueWorker,
  StopWorker,
  WaitForWorker,
  SubmitWorkerResult,
  SubmitEnumerationDisposition,
  SubmitAttackDisposition,
];

export const tools: ToolModuleDefinition[] = WorkerBuiltins.map(fromToolImpl);
