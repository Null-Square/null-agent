import { type StreamBroker } from '../../core/StreamBroker';
import { type SessionStore } from '../../core/SessionStore';
import { type PlanItem, type StepStatus, type TodoItem } from '../../../domain/types';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import { isResumablePlanBlockReason } from '../../../domain/helpers/PlanState';

// summarizeForNote imported from @/shared/utils/text

const FINAL_PLAN_STATUSES: ReadonlySet<StepStatus> = new Set(['completed', 'blocked', 'error']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const buildExitPlanReasons = (
  reason: 'credits_exhausted' | 'max_tool_calls' | 'awaiting_user' | 'awaiting_approval' | 'deadlock' | 'aborted',
): { active: string; pending?: string } => {
  switch (reason) {
    case 'credits_exhausted':
      return {
        active: 'Paused for resume: credits exhausted before step completion',
        pending: 'Deferred for resume: prior step paused due to credits exhaustion',
      };
    case 'max_tool_calls':
      return {
        active: 'Paused for resume: tool budget exhausted before step completion',
        pending: 'Deferred for resume: prior step paused due to tool budget exhaustion',
      };
    case 'awaiting_user':
      return {
        active: 'Blocked: waiting for user input before this step can continue',
      };
    case 'awaiting_approval':
      return {
        active: 'Blocked: waiting for approval before this step can continue',
      };
    case 'deadlock':
      return {
        active: 'Blocked: repeated tool loop requires user intervention',
      };
    case 'aborted':
      return {
        active: 'Deferred for resume: run aborted before this step completed',
      };
  }
};

export interface PlanRuntimeDeps {
  sessionStore: SessionStore;
  streamBroker: Pick<StreamBroker, 'emit'>;
  snippetLimit?: number;
  traceRecorder?: SessionTraceRecorder;
}

export interface PlanExitReconciliationOptions {
  reason:
    | 'credits_exhausted'
    | 'max_tool_calls'
    | 'awaiting_user'
    | 'awaiting_approval'
    | 'deadlock'
    | 'aborted';
  checkpointId?: string;
  blockPending?: boolean;
}

export type PlanTransitionOptions = {
  suppressTelemetry?: boolean;
  turnNumber?: number;
};

export class PlanRuntime {
  private readonly sessionStore: SessionStore;
  private readonly streamBroker: Pick<StreamBroker, 'emit'>;
  private readonly snippetLimit: number;
  private readonly planProvenanceBuffers: Map<string, { snippet: string }> = new Map();
  private readonly traceRecorder?: SessionTraceRecorder;
  private readonly log = logger.child({ scope: 'PlanRuntime' });

  constructor(deps: PlanRuntimeDeps) {
    this.sessionStore = deps.sessionStore;
    this.streamBroker = deps.streamBroker;
    this.snippetLimit = Number.isFinite(deps.snippetLimit)
      ? Number(deps.snippetLimit)
      : 512;
    this.traceRecorder = deps.traceRecorder;
  }

  normalizeStepStatus(value: unknown): StepStatus {
    if (!value || typeof value !== 'string') {
      return 'pending';
    }
    const normalized = value.toLowerCase().replace(/\s+/g, '_');
    switch (normalized) {
      case 'running':
      case 'in_progress':
      case 'in-progress':
        return 'running';
      case 'completed':
      case 'done':
        return 'completed';
      case 'blocked':
        return 'blocked';
      case 'error':
      case 'failed':
        return 'error';
      default:
        return 'pending';
    }
  }

  async replacePlan(sessionId: string, items: PlanItem[]): Promise<PlanItem[]> {
    const existingPlan = this.sessionStore.get(sessionId)?.plan ?? [];
    const existingById = new Map(existingPlan.map((step) => [step.id, step]));

    const normalizedPlan = items.map((item, index) => {
      const status = this.normalizeStepStatus(item.status);
      const title = item.title?.trim?.() ?? '';
      const id =
        item.id && item.id.trim().length > 0
          ? item.id
          : `${index}-${title.replace(/\s+/g, '-').toLowerCase() || 'step'}`;
      const existing = existingById.get(id);
      const normalizedNotes =
        item.notes && item.notes.trim().length > 0 ? item.notes : existing?.notes;
      const normalizedArtifactLinks = Array.isArray(item.artifactLinks)
        ? item.artifactLinks.filter(Boolean)
        : existing?.artifactLinks;

      return {
        id,
        title,
        status,
        mission: item.mission ?? existing?.mission,
        notes: normalizedNotes,
        startedAt: item.startedAt ?? existing?.startedAt,
        completedAt: item.completedAt ?? existing?.completedAt,
        blockedReason: item.blockedReason ?? existing?.blockedReason,
        lastTool: item.lastTool ?? existing?.lastTool,
        outputSnippet: item.outputSnippet ?? existing?.outputSnippet,
        artifactLinks: normalizedArtifactLinks,
        checkpointId: item.checkpointId ?? existing?.checkpointId,
      };
    });

    await this.sessionStore.updatePlanAsync(sessionId, normalizedPlan);
    const session = this.sessionStore.get(sessionId);
    if (session) {
      if (
        session.currentPlanStepId &&
        !normalizedPlan.some(
          (step) => step.id === session.currentPlanStepId && step.status === 'running'
        )
      ) {
        session.currentPlanStepId = undefined;
        this.clearProvenanceBuffer(sessionId);
        await this.sessionStore.setAsync(sessionId, session, 'planRuntime.transition');
      }
    }

    this.streamBroker.emit(sessionId, {
      type: 'plan_update',
      data: normalizedPlan,
    });

    return normalizedPlan;
  }

  async replaceScratchTodos(sessionId: string, items: TodoItem[]): Promise<TodoItem[]> {
    const normalizedTodos = items.map((item, index) => {
      const content = item.content?.trim?.() ?? '';
      const id =
        item.id && item.id.trim().length > 0
          ? item.id.trim()
          : `${index}-${content.replace(/\s+/g, '-').toLowerCase() || 'todo'}`;
      return {
        id,
        content,
        status: this.normalizeStepStatus(item.status),
        ...(item.notes && item.notes.trim().length > 0 ? { notes: item.notes.trim() } : {}),
      };
    });

    const session = this.sessionStore.get(sessionId);
    if (session) {
      await this.sessionStore.setAsync(
        sessionId,
        {
          ...session,
          scratchTodos: normalizedTodos,
        },
        'planRuntime.replaceScratchTodos',
      );
    }

    return normalizedTodos;
  }

  async transitionPlanStep(
    sessionId: string,
    stepId: string,
    nextStatus?: StepStatus,
    fields: Partial<PlanItem> = {},
    options: PlanTransitionOptions = {}
  ): Promise<PlanItem | undefined> {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      return undefined;
    }

    const step = session.plan.find((item) => item.id === stepId);
    if (!step) {
      return undefined;
    }

    const previousStatus = step.status;
    const statusToApply = nextStatus ? this.normalizeStepStatus(nextStatus) : step.status;

    if (
      nextStatus &&
      previousStatus === statusToApply &&
      (!step.blockedReason || step.blockedReason === fields.blockedReason)
    ) {
      // No change; avoid churn.
      return step;
    }

    const updated: PlanItem = {
      ...step,
      ...fields,
      status: statusToApply,
    };

    await this.sessionStore.updatePlanStepAsync(sessionId, stepId, updated);
    const sessionAfter = this.sessionStore.get(sessionId);

    if (!sessionAfter) {
      return updated;
    }

    // Update currentPlanStepId using targeted method instead of setAsync
    // This prevents race conditions with concurrent message mutations
    if (statusToApply === 'running') {
      await this.sessionStore.updateCurrentPlanStepIdAsync(sessionId, stepId);
      this.resetProvenanceBuffer(sessionId);
    } else if (FINAL_PLAN_STATUSES.has(statusToApply)) {
      if (sessionAfter.currentPlanStepId === stepId) {
        await this.sessionStore.updateCurrentPlanStepIdAsync(sessionId, undefined);
      }
      this.clearProvenanceBuffer(sessionId);
    }

    if (!options.suppressTelemetry) {
      if (statusToApply === 'running') {
        this.streamBroker.emit(sessionId, {
          type: 'plan_step_started',
          data: { stepId },
        });
      } else {
        this.streamBroker.emit(sessionId, {
          type: 'plan_step_updated',
          data: {
            stepId,
            status: statusToApply,
            blockedReason: updated.blockedReason,
            notes: updated.notes,
            outputSnippet: updated.outputSnippet,
            lastTool: updated.lastTool,
            artifactLinks: updated.artifactLinks,
            checkpointId: updated.checkpointId,
            startedAt: updated.startedAt,
            completedAt: updated.completedAt,
          },
        });
      }
    }

    const recorder = this.traceRecorder;
    if (recorder && !options.suppressTelemetry) {
      const turn = options.turnNumber ?? (sessionAfter.turn ?? 0) + 1;
      recorder
        .write(sessionId, turn, {
          event: 'plan.step.transition',
          severity: 'info',
          payload: {
            stepId,
            from: previousStatus,
            to: statusToApply,
            blockedReason: updated.blockedReason,
          },
          note: summarizeForNote(`${stepId}: ${previousStatus} -> ${statusToApply}`),
        })
        .catch((error) => {
          this.log.warn({ err: error, sessionId, stepId }, 'Failed to record plan.step.transition');
        });
    }

    return updated;
  }

  async ensureActivePlanStep(sessionId: string): Promise<PlanItem | undefined> {
    const session = this.sessionStore.get(sessionId);
    if (!session || session.plan.length === 0) {
      return undefined;
    }
    const running = session.plan.find((step) => step.status === 'running');
    if (running) {
      await this.sessionStore.updateCurrentPlanStepIdAsync(sessionId, running.id);
      return running;
    }
    const resumableBlocked = session.plan.find(
      (step) => step.status === 'blocked' && isResumablePlanBlockReason(step.blockedReason)
    );
    if (resumableBlocked) {
      return this.transitionPlanStep(sessionId, resumableBlocked.id, 'running', {
        blockedReason: undefined,
      });
    }
    const nextPending = session.plan.find((step) => step.status === 'pending');
    if (nextPending) {
      return this.transitionPlanStep(sessionId, nextPending.id, 'running');
    }
    return undefined;
  }

  async reconcilePlanForExit(
    sessionId: string,
    options: PlanExitReconciliationOptions
  ): Promise<{
    changed: boolean;
    activeStepId?: string;
    deferredStepIds: string[];
  }> {
    const session = this.sessionStore.get(sessionId);
    if (!session || session.plan.length === 0) {
      return { changed: false, deferredStepIds: [] };
    }

    const reasons = buildExitPlanReasons(options.reason);
    const deferredStepIds: string[] = [];
    let changed = false;
    let activeStepId: string | undefined;

    for (const step of session.plan) {
      if (step.status === 'running') {
        activeStepId = step.id;
        const updated = await this.transitionPlanStep(
          sessionId,
          step.id,
          'blocked',
          {
            blockedReason: reasons.active,
            checkpointId: options.checkpointId ?? step.checkpointId,
          }
        );
        changed = changed || Boolean(updated);
        continue;
      }

      if (options.blockPending && step.status === 'pending' && reasons.pending) {
        deferredStepIds.push(step.id);
        const updated = await this.transitionPlanStep(
          sessionId,
          step.id,
          'blocked',
          {
            blockedReason: reasons.pending,
          }
        );
        changed = changed || Boolean(updated);
      }
    }

    if (!changed) {
      return { changed: false, activeStepId, deferredStepIds };
    }

    const sessionAfter = this.sessionStore.get(sessionId);
    const counts = {
      pending: sessionAfter?.plan.filter((step) => step.status === 'pending').length ?? 0,
      running: sessionAfter?.plan.filter((step) => step.status === 'running').length ?? 0,
      blocked: sessionAfter?.plan.filter((step) => step.status === 'blocked').length ?? 0,
      completed: sessionAfter?.plan.filter((step) => step.status === 'completed').length ?? 0,
      error: sessionAfter?.plan.filter((step) => step.status === 'error').length ?? 0,
    };

    const recorder = this.traceRecorder;
    if (recorder) {
      recorder
        .write(sessionId, (session.turn ?? 0) + 1, {
          event: 'plan.reconciled',
          severity: 'info',
          payload: {
            reason: options.reason,
            activeStepId,
            deferredStepIds,
            checkpointId: options.checkpointId,
            counts,
          },
          note: summarizeForNote(
            `plan reconciled for ${options.reason}${activeStepId ? ` (${activeStepId})` : ''}`
          ),
        })
        .catch((error) => {
          this.log.warn({ err: error, sessionId }, 'Failed to record plan.reconciled');
        });
    }

    return { changed: true, activeStepId, deferredStepIds };
  }

  prepareProvenanceBuffer(sessionId: string): void {
    if (!this.planProvenanceBuffers.has(sessionId)) {
      this.planProvenanceBuffers.set(sessionId, { snippet: '' });
    }
  }

  resetProvenanceBuffer(sessionId: string): void {
    this.planProvenanceBuffers.set(sessionId, { snippet: '' });
  }

  appendProvenanceSnippet(sessionId: string, chunk: string): void {
    if (!chunk) {
      return;
    }
    const buffer = this.planProvenanceBuffers.get(sessionId);
    if (!buffer) {
      return;
    }
    const nextSnippet = `${buffer.snippet}${chunk}`;
    if (nextSnippet.length > this.snippetLimit) {
      buffer.snippet = `${nextSnippet.slice(0, this.snippetLimit - 3)}...`;
    } else {
      buffer.snippet = nextSnippet;
    }
  }

  clearProvenanceBuffer(sessionId: string): void {
    this.planProvenanceBuffers.delete(sessionId);
  }

  finalizePlanProvenance(sessionId: string, tool: string, result: unknown): void {
    const session = this.sessionStore.get(sessionId);
    if (!session || !session.currentPlanStepId) {
      this.clearProvenanceBuffer(sessionId);
      return;
    }
    const buffer = this.planProvenanceBuffers.get(sessionId);
    const snippet = buffer?.snippet?.trim();
    const artifactLinks = this.extractArtifactLinks(result);

    let blockedReason: string | undefined;
    if (isRecord(result)) {
      if (result.denied === true) {
        blockedReason =
          typeof result.error === 'string' && result.error.length > 0
            ? result.error.slice(0, 240)
            : 'Action denied by operator';
      } else if (result.aborted === true) {
        // Abort is captured elsewhere; keep current status.
      } else if (result.timedOut === true) {
        blockedReason = 'Command timed out';
      } else if (result.success === false) {
        blockedReason =
          typeof result.error === 'string' && result.error.length > 0
            ? result.error.slice(0, 240)
            : undefined;
      } else if (typeof result.error === 'string' && result.error.length > 0) {
        blockedReason = result.error.slice(0, 240);
      }
    }

    this.transitionPlanStep(
      sessionId,
      session.currentPlanStepId,
      undefined,
      {
        lastTool: tool,
        outputSnippet: snippet,
        artifactLinks: artifactLinks.length ? artifactLinks : undefined,
        blockedReason,
      },
      { suppressTelemetry: true }
    );

    const recorder = this.traceRecorder;
    if (recorder) {
      recorder
        .write(sessionId, (session.turn ?? 0) + 1, {
          event: 'plan.step.provenance',
          severity: 'info',
          payload: {
            stepId: session.currentPlanStepId,
            tool,
            snippet,
            artifactLinks,
          },
          note: summarizeForNote(`${session.currentPlanStepId} via ${tool}`),
        })
        .catch((error) => {
          this.log.warn({ err: error, sessionId, stepId: session.currentPlanStepId }, 'Failed to record plan.step.provenance');
        });
    }

    this.clearProvenanceBuffer(sessionId);
  }

  handleToolFailure(sessionId: string, error: unknown): void {
    const session = this.sessionStore.get(sessionId);
    if (!session || !session.currentPlanStepId) {
      return;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return;
    }
    const message =
      error instanceof Error && error.message
        ? error.message.slice(0, 240)
        : 'Tool execution failed';
    this.transitionPlanStep(
      sessionId,
      session.currentPlanStepId,
      undefined,
      {
        blockedReason: message,
      }
    );
    this.clearProvenanceBuffer(sessionId);
  }

  getCurrentPlan(sessionId: string): PlanItem[] {
    const session = this.sessionStore.get(sessionId);
    return session?.plan ?? [];
  }

  getScratchTodos(sessionId: string): TodoItem[] {
    const session = this.sessionStore.get(sessionId);
    return session?.scratchTodos ?? [];
  }

  private extractArtifactLinks(result: unknown): string[] {
    if (!isRecord(result)) {
      return [];
    }
    const links: string[] = [];
    if (typeof result.artifactPath === 'string') {
      links.push(result.artifactPath);
    }
    if (Array.isArray(result.artifactPaths)) {
      for (const entry of result.artifactPaths as unknown[]) {
        if (typeof entry === 'string' && entry.length > 0) {
          links.push(entry);
        }
      }
    }
    if (Array.isArray(result.artifactLinks)) {
      for (const entry of result.artifactLinks as unknown[]) {
        if (typeof entry === 'string' && entry.length > 0) {
          links.push(entry);
        }
      }
    }
    return Array.from(new Set(links));
  }
}
