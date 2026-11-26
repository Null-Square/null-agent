import type { SessionStore } from '../core/SessionStore';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { SessionState, WorkerTaskStatus } from '../../domain/types';
import type { SessionEventPublisher } from '../../ports';
import type { AppLogger } from '@/shared/logger';
import {
  deriveSessionStatusForEvent,
  emitSessionStatusEvent,
} from '../orchestration/utils/sessionStatusEvents';

export type PropagatedParentBlockedReason =
  | 'user_paused'
  | 'credits_exhausted'
  | 'runner_unavailable';

export type WorkerStartStopPolicyRepository = {
  listChildSessionIds(parentSessionId: string): Promise<string[]>;
  setBlockedReasonIfClear(sessionId: string, reason: string, meta?: Record<string, unknown>): Promise<boolean>;
  getBlockedReason(sessionId: string): Promise<string | null>;
};

export class WorkerStartStopPolicy {
  constructor(
    private readonly deps: {
      sessionStore: SessionStore;
      sessionRepository: WorkerStartStopPolicyRepository;
      events: SessionEventPublisher;
      traceRecorder?: SessionTraceRecorder;
      log: AppLogger;
    },
  ) {}

  async blockChildWorkers(
    parentSessionId: string,
    blockedReason: PropagatedParentBlockedReason,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const childSessionIds = await this.listChildWorkerSessionIds(parentSessionId);
    for (const childSessionId of childSessionIds) {
      const childSession = await this.deps.sessionStore.getOrHydrate(childSessionId).catch(() => undefined);
      if (!childSession || this.isFinishedWorkerSession(childSession)) {
        continue;
      }

      const blockedMeta = {
        ...meta,
        source: 'parent_session',
        parentSessionId,
        controller: 'parent_session',
        controllerId: parentSessionId,
      };
      const persisted = await this.deps.sessionRepository.setBlockedReasonIfClear(
        childSessionId,
        blockedReason,
        blockedMeta,
      ).catch((err) => {
        this.deps.log.warn(
          { err, parentSessionId, childSessionId, blockedReason },
          'Failed to persist child blocked_reason',
        );
        return false;
      });
      if (!persisted) continue;

      const previousStatus = deriveSessionStatusForEvent(childSession);
      const wasProcessing = childSession.stateMachine?.isProcessing() ?? false;
      if (wasProcessing) {
        childSession.stateMachine?.stopProcessing(blockedReason, childSession.turn ?? 0, 'WorkerStartStopPolicy.parent');
      }
      childSession.blockedReason = blockedReason;
      childSession.blockedMeta = blockedMeta;
      await this.deps.sessionStore.setAsync(childSessionId, childSession, `parent.${blockedReason}`);
      await this.updateParentWorkerTaskState(
        parentSessionId,
        childSessionId,
        'blocked',
        `Worker blocked because the parent session is ${this.formatBlockedReasonLabel(blockedReason)}.`,
        `parent.${blockedReason}.task_blocked`,
      );
      if (wasProcessing) {
        await this.deps.sessionStore.abortCurrentTurnAsync(childSessionId, blockedReason).catch((err) => {
          this.deps.log.warn({ err, parentSessionId, childSessionId, blockedReason }, 'Failed to abort child worker turn');
        });
      }

      const updatedChild = this.deps.sessionStore.get(childSessionId);
      emitSessionStatusEvent(
        this.deps.events,
        updatedChild ?? childSession,
        previousStatus,
        `parent.${blockedReason}`,
        this.deps.traceRecorder,
      );
    }
  }

  async startChildWorkers(
    parentSessionId: string,
    blockedReason: PropagatedParentBlockedReason,
  ): Promise<string[]> {
    const startedChildSessionIds: string[] = [];
    const childSessionIds = await this.listChildWorkerSessionIds(parentSessionId);
    for (const childSessionId of childSessionIds) {
      const childBlockedReason = await this.deps.sessionRepository.getBlockedReason(childSessionId).catch(() => null);
      const childSession = await this.deps.sessionStore.getOrHydrate(childSessionId).catch(() => undefined);
      const effectiveBlockedReason = childBlockedReason ?? childSession?.blockedReason ?? null;
      if (effectiveBlockedReason !== blockedReason || this.isFinishedWorkerSession(childSession)) {
        continue;
      }
      const started = await this.deps.sessionStore.recordStartRequestedAsync(
        childSessionId,
        `parent ${parentSessionId} started after ${blockedReason}`,
        `parent:${parentSessionId}`,
      ).catch((err) => {
        this.deps.log.warn({ err, parentSessionId, childSessionId, blockedReason }, 'Failed to start child session');
        return false;
      });
      if (!started) continue;
      startedChildSessionIds.push(childSessionId);
      await this.writeStartTrace(
        childSessionId,
        'worker.start_scheduled',
        {
          parentSessionId,
          blockedReason,
          durable: true,
        },
        `worker continuation scheduled after parent Start from ${this.formatBlockedReasonLabel(blockedReason)}`,
      );
    }
    return startedChildSessionIds;
  }

  async writeStartTrace(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
    note: string,
    severity: 'debug' | 'info' | 'warn' | 'error' = 'info',
  ): Promise<void> {
    if (!this.deps.traceRecorder) {
      return;
    }
    const traceSession = this.deps.sessionStore.get(sessionId);
    try {
      await this.deps.traceRecorder.write(sessionId, (traceSession?.turn ?? 0) + 1, {
        event,
        severity,
        payload,
        note,
      });
    } catch (err) {
      this.deps.log.warn({ err, sessionId, event }, '[Start] Failed to write Start trace event');
    }
  }

  private async listChildWorkerSessionIds(parentSessionId: string): Promise<string[]> {
    return Array.from(new Set(await this.deps.sessionRepository.listChildSessionIds(parentSessionId)));
  }

  private isCompletedSession(session: SessionState | undefined): boolean {
    return Boolean(
      session?.workerResult ||
        session?.completed === true ||
        ((session?.flags?.session as Record<string, unknown> | undefined)?.completed === true),
    );
  }

  private isFinishedWorkerSession(session: SessionState | undefined): boolean {
    return Boolean(
      this.isCompletedSession(session) ||
        session?.blockedReason === 'worker_failed' ||
        session?.blockedReason === 'worker_cancelled',
    );
  }

  private formatBlockedReasonLabel(blockedReason: PropagatedParentBlockedReason): string {
    return blockedReason.replace(/_/gu, ' ');
  }

  private async updateParentWorkerTaskState(
    parentSessionId: string,
    childSessionId: string,
    status: Extract<WorkerTaskStatus, 'blocked' | 'running'>,
    lastStatusReason: string,
    source: string,
  ): Promise<void> {
    const parentSession = this.deps.sessionStore.get(parentSessionId);
    if (!parentSession || !Array.isArray(parentSession.workerTasks)) {
      return;
    }

    let mutated = false;
    parentSession.workerTasks = parentSession.workerTasks.map((task) => {
      if (
        task.workerSessionId !== childSessionId ||
        task.status === 'completed' ||
        task.status === 'failed' ||
        task.status === 'cancelled'
      ) {
        return task;
      }

      mutated = true;
      const nextTask = {
        ...task,
        status,
        lastStatusReason,
        lastUpdatedAt: Date.now(),
      };
      delete nextTask.completedAt;
      delete nextTask.lastError;
      return nextTask;
    });

    if (!mutated) {
      return;
    }

    parentSession.coordination = parentSession.coordination ?? { role: 'direct' };
    await this.deps.sessionStore.setAsync(parentSessionId, parentSession, source);
  }
}
