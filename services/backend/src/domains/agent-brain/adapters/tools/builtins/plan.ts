import { type SessionState, type StepStatus, type TodoItem } from '../../../domain/types';
import { type ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import {
  buildStepTransitionBriefing,
  type StepTransitionBriefing,
} from '@/domains/agent-brain/domain/workers/missionEnvelope';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getSkillMethodologyReads = (value: unknown) =>
  isRecord(value) ? value as Record<string, { readAt?: string; byPlanStepId?: string; path?: string }> : {};

const arraysEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const normalizeSkillSlug = (value: string): string => value.trim().toLowerCase();

const getPlanStepMissionSkills = (mission: unknown): string[] => {
  const payload = isRecord(mission) ? mission : undefined;
  const assignedSkills = Array.isArray(payload?.assignedSkills)
    ? payload.assignedSkills
    : Array.isArray(payload?.assigned_skills)
      ? payload.assigned_skills
      : [];
  return assignedSkills
    .filter((skill): skill is string => typeof skill === 'string')
    .map(normalizeSkillSlug)
    .filter((skill) => skill.length > 0);
};

const getSecurityOpsInventoryProgress = (session: SessionState | undefined): Record<string, unknown> | undefined => {
  const securityops = isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;
  return isRecord(securityops?.inventoryProgress) ? securityops.inventoryProgress : undefined;
};

const getProgressCount = (progress: Record<string, unknown> | undefined, key: string): number =>
  typeof progress?.[key] === 'number' ? (progress[key] as number) : 0;

const getProgressNoteTypeCount = (progress: Record<string, unknown> | undefined, key: string): number => {
  const noteTypes = isRecord(progress?.noteTypes) ? progress.noteTypes : undefined;
  return typeof noteTypes?.[key] === 'number' ? (noteTypes[key] as number) : 0;
};

const validateBroadSurfaceCompletion = (
  session: SessionState | undefined,
  step: { id: string; mission?: unknown } | undefined,
): string | null => {
  if (!step || !getPlanStepMissionSkills(step.mission).includes('broad-surface-scan')) {
    return null;
  }

  const progress = getSecurityOpsInventoryProgress(session);
  const ingestedParsers = Array.isArray(progress?.ingestedParsers)
    ? progress.ingestedParsers.filter((value): value is string => typeof value === 'string')
    : [];
  const failedIngestParsers = Array.isArray(progress?.failedIngestParsers)
    ? progress.failedIngestParsers.filter((value): value is string => typeof value === 'string')
    : [];
  const coverageStatus =
    typeof progress?.lastCoverageStatus === 'string'
      ? progress.lastCoverageStatus.trim().toLowerCase()
      : '';
  const coverageNoteSignal =
    getProgressCount(progress, 'coverageNotes') > 0 ||
    getProgressNoteTypeCount(progress, 'scan.coverage') > 0;
  const serviceSignal =
    getProgressCount(progress, 'servicesCreated') + getProgressCount(progress, 'servicesTouched') > 0 ||
    ingestedParsers.some((parser) => parser === 'httpx' || parser === 'naabu');
  const coverageSignal = coverageStatus === 'completed' || (coverageStatus.length === 0 && coverageNoteSignal);
  const unresolvedIngestFailures = failedIngestParsers.length > 0;

  if (serviceSignal && coverageSignal && !unresolvedIngestFailures) {
    return null;
  }

  const missing: string[] = [];
  if (!serviceSignal) {
    missing.push('canonical service inventory via ingest_scan_artifact(httpx/naabu) or report_service');
  }
  if (!coverageSignal) {
    missing.push('a successful scan.coverage note with data.status="completed"');
  }
  if (unresolvedIngestFailures) {
    missing.push(`a successful ingest_scan_artifact retry for failed parser(s): ${failedIngestParsers.join(', ')}`);
  }

  const lastIngestError =
    typeof progress?.lastIngestError === 'string' && progress.lastIngestError.trim().length > 0
      ? progress.lastIngestError.trim()
      : null;

  return [
    `Plan step ${step.id} cannot be marked completed yet.`,
    `Missing: ${missing.join('; ')}.`,
    lastIngestError ? `Last ingest error: ${lastIngestError}` : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
};

const syncActiveMethodologyRequirement = (
  session: SessionState | undefined,
  step: { id: string; status: StepStatus },
  unreadSkills: readonly string[],
): boolean => {
  if (!session) {
    return false;
  }

  const existing =
    isRecord(session.flags.activeMethodologyRequirement)
      ? session.flags.activeMethodologyRequirement as {
          stepId?: string;
          skills?: string[];
          paths?: string[];
        }
      : undefined;

  if (step.status === 'running' && unreadSkills.length > 0) {
    const nextPaths = unreadSkills.map((skill) => `/workspace/.skills/${skill}/methodology.md`);
    const unchanged =
      existing?.stepId === step.id &&
      Array.isArray(existing.skills) &&
      Array.isArray(existing.paths) &&
      arraysEqual(existing.skills, unreadSkills) &&
      arraysEqual(existing.paths, nextPaths);
    if (unchanged) {
      return false;
    }
    session.flags.activeMethodologyRequirement = {
      stepId: step.id,
      skills: [...unreadSkills],
      paths: nextPaths,
    };
    return true;
  }

  if (step.status === 'running') {
    if (existing) {
      delete session.flags.activeMethodologyRequirement;
      return true;
    }
    return false;
  }

  if (existing?.stepId === step.id) {
    delete session.flags.activeMethodologyRequirement;
    return true;
  }

  return false;
};

const summarizeMethodologyRequirement = (
  briefing: StepTransitionBriefing | null,
): {
  stepId: string;
  unreadSkills: string[];
  paths: string[];
} | undefined => {
  if (!briefing || briefing.unreadSkills.length === 0) {
    return undefined;
  }
  return {
    stepId: briefing.stepId,
    unreadSkills: [...briefing.unreadSkills],
    paths: briefing.unreadSkills.map((skill) => `/workspace/.skills/${skill}/methodology.md`),
  };
};

const normalizeTodoInput = (
  todos: Array<{ id?: string; content: string; status?: string; notes?: string }>,
  normalizeStatus: (value: unknown) => StepStatus
): TodoItem[] => {
  const seenIds = new Set<string>();
  return todos
    .map((todo, index) => {
      const title = typeof todo.content === 'string' ? todo.content.trim() : '';
      if (!title) {
        return null;
      }
      const status = normalizeStatus(todo.status);
      // Preserve blueprint IDs when the model passes them through.
      // Fall back to title-based ID generation for new steps.
      let id = typeof todo.id === 'string' && todo.id.trim().length > 0
        ? todo.id.trim()
        : undefined;
      if (!id) {
        const idBase = title.replace(/[^\w]+/g, '_').toLowerCase() || `step_${index}`;
        id = `${idBase}_${index}`;
      }
      // Deduplicate IDs within the same todo_write call
      if (seenIds.has(id)) {
        id = `${id}_${index}`;
      }
      seenIds.add(id);
      return {
        id,
        content: title,
        status,
        notes: typeof todo.notes === 'string' && todo.notes.trim().length > 0 ? todo.notes : undefined,
      } as TodoItem;
    })
    .filter((item): item is TodoItem => Boolean(item));
};

export const TodoWrite: ToolImpl = {
  meta: {
    name: 'todo_write',
    description: 'Replace the executor working todo list. This does not change the approved plan; use plan_set_step_status for approved plan progress.',
    category: 'planning',
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Step identifier. Preserve original plan step IDs when updating existing plans.' },
              content: { type: 'string', description: 'Working todo content' },
              status: {
                type: 'string',
                enum: ['pending', 'running', 'in_progress', 'completed', 'blocked', 'error'],
              },
              notes: { type: 'string', description: 'Optional notes for the step' },
            },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    },
    risks: ['write'],
  },
  async run({ todos }, ctx) {
    const planRuntime = ctx.planRuntime;
    return runWithGuards(
      TodoWrite.meta,
      ctx,
      async () => {
        const items = Array.isArray(todos)
          ? normalizeTodoInput(todos, (value) => planRuntime.normalizeStepStatus(value))
          : [];
        const scratchTodos = await planRuntime.replaceScratchTodos(ctx.sessionId, items);
        return { ok: true, data: { success: true, todos: scratchTodos } };
      },
      {},
      { todos }
    );
  },
};

export const PlanSetStepStatus: ToolImpl = {
  meta: {
    name: 'plan_set_step_status',
    description: 'Update the status of a plan step and optionally attach notes.',
    category: 'planning',
    schema: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: 'Identifier of the plan step to update' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'blocked', 'error'],
        },
        notes: { type: 'string', description: 'Optional notes or rationale' },
        blockedReason: { type: 'string', description: 'Reason when blocking or erroring a step' },
        checkpointId: { type: 'string', description: 'Checkpoint associated with this step' },
      },
      required: ['stepId', 'status'],
    },
    risks: ['write'],
  },
  async run({ stepId, status, notes, blockedReason, checkpointId }, ctx) {
    const planRuntime = ctx.planRuntime;
    return runWithGuards(
      PlanSetStepStatus.meta,
      ctx,
      async () => {
        const trimmedStepId = typeof stepId === 'string' ? stepId.trim() : '';
        if (!trimmedStepId) {
          return { ok: false, data: { error: 'stepId is required' } };
        }
        const normalizedNotes = typeof notes === 'string' ? notes : undefined;
        const normalizedBlockedReason = typeof blockedReason === 'string' ? blockedReason : undefined;
        const normalizedCheckpointId = typeof checkpointId === 'string' ? checkpointId : undefined;
        const sessionBefore = ctx.sessionStore.get(ctx.sessionId);
        const requestedStatus = planRuntime.normalizeStepStatus(status);
        const existingStep = sessionBefore?.plan?.find((item) => item.id === trimmedStepId);
        if (requestedStatus === 'completed') {
          const completionError = validateBroadSurfaceCompletion(sessionBefore, existingStep);
          if (completionError) {
            return { ok: false, data: { error: completionError } };
          }
        }
        const step = await planRuntime.transitionPlanStep(
          ctx.sessionId,
          trimmedStepId,
          requestedStatus,
          {
            notes: normalizedNotes,
            blockedReason: normalizedBlockedReason,
            checkpointId: normalizedCheckpointId,
          },
          { turnNumber: ctx.turnNumber },
        );
        if (!step) {
          return { ok: false, data: { error: `Plan step ${trimmedStepId} not found` } };
        }
        if (step.status === 'running') {
          planRuntime.resetProvenanceBuffer(ctx.sessionId);
        }
        if (['completed', 'blocked', 'error'].includes(step.status)) {
          planRuntime.clearProvenanceBuffer(ctx.sessionId);
        }
        const session = ctx.sessionStore.get(ctx.sessionId);
        const methodologyBriefing =
          step.status === 'running' && step.mission
            ? buildStepTransitionBriefing({
                stepId: step.id,
                mission: step.mission,
                methodologyReads: getSkillMethodologyReads(session?.flags?.skillMethodologyReads),
              })
            : null;
        const requirementChanged = syncActiveMethodologyRequirement(
          session,
          step,
          methodologyBriefing?.unreadSkills ?? [],
        );
        if (requirementChanged && session) {
          await ctx.sessionStore.setAsync(
            session.id,
            session,
            'plan_set_step_status.active_methodology_requirement',
          );
        }

        if (methodologyBriefing) {
          await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? ((session?.turn ?? 0) + 1), {
            event: 'plan.step.briefing',
            severity: methodologyBriefing.unreadSkills.length > 0 ? 'warn' : 'info',
            payload: {
              stepId: methodologyBriefing.stepId,
              assignedSkills: methodologyBriefing.assignedSkills,
              unreadSkills: methodologyBriefing.unreadSkills,
              reusedSkills: methodologyBriefing.reusedSkills,
              currentStepReadSkills: methodologyBriefing.currentStepReadSkills,
            },
            note: `${methodologyBriefing.stepId} briefed: ${methodologyBriefing.unreadSkills.length} unread skill methodology file(s)`,
          }).catch(() => undefined);
        }
        const methodologyRequired = summarizeMethodologyRequirement(methodologyBriefing);

        return {
          ok: true,
          data: {
            success: true,
            stepId: step.id,
            title: step.title,
            status: step.status,
            ...(methodologyRequired ? { methodologyRequired } : {}),
          },
        };
      },
      {},
      { stepId, status }
    );
  },
};

export const TodoRead: ToolImpl = {
  meta: {
    name: 'todo_read',
    description: 'Read the executor working todo list. This is separate from the approved plan.',
    category: 'planning',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    risks: ['read'],
  },
  async run(_args, ctx) {
    return runWithGuards(
      TodoRead.meta,
      ctx,
      async () => {
        const todos = ctx.planRuntime.getScratchTodos(ctx.sessionId);
        return { ok: true, data: { todos } };
      }
    );
  },
};

export const PlanBuiltins = [TodoWrite, PlanSetStepStatus, TodoRead];

/** Registry-compatible export - ToolModuleDefinition format */
export const tools: ToolModuleDefinition[] = PlanBuiltins.map(fromToolImpl);
