import type { RunRow } from '@/db/schema';
import { sessionResolverService } from '@/domains/platform/sessions/SessionResolverService';

import type { RunPhaseRepository } from './RunPhaseRepository';
import { shouldAutoApproveInitialPlan } from './runPlanApprovalPolicy';
import {
  RUN_ACTIVE_STATUSES,
  chooseRelatedRunStatus,
  collectTerminalPhaseSessionIds,
  mapSessionSnapshotToRunStatus,
  resolveRunUsageSessionRefs,
  toChildRuntimeStatus,
  type SessionRuntimeSnapshot,
  type SessionRuntimeStatusPort,
} from './RunLifecycleHelpers';

export type RunRuntimeStatusServiceDeps = {
  runPhaseRepository: Pick<
    RunPhaseRepository,
    'listSessionIdsByRunId' | 'listByRunId' | 'hasSessionHistory' | 'hasOpenPhases'
  >;
  sessionStatusPort?: SessionRuntimeStatusPort;
  runInactivityFailMs: number;
};

export class RunRuntimeStatusService {
  constructor(private readonly deps: RunRuntimeStatusServiceDeps) {}

  async listAdditionalRunSessionIds(
    runId: string,
    exclude: readonly string[] = [],
  ): Promise<string[]> {
    if (!runId) {
      return [];
    }

    const excluded = new Set(exclude.filter((value) => value.trim().length > 0));
    const listIdsByRunId = this.deps.sessionStatusPort?.listIdsByRunId;
    const [runtimeSessionIds, phaseSessionIds] = await Promise.all([
      typeof listIdsByRunId === 'function'
        ? listIdsByRunId.call(this.deps.sessionStatusPort, runId)
        : Promise.resolve([]),
      this.deps.runPhaseRepository.listSessionIdsByRunId(runId),
    ]);
    const sessionIds = [...runtimeSessionIds, ...phaseSessionIds];
    return Array.from(
      new Set(
        sessionIds
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && !excluded.has(value)),
      ),
    );
  }

  async getRelatedRunStatuses(
    run: Pick<RunRow, 'id' | 'startedAt' | 'sessionId' | 'plannerSessionId' | 'executorSessionId'>,
    nowMs: number,
  ): Promise<Array<RunRow['status'] | null>> {
    if (!this.deps.sessionStatusPort) {
      return [];
    }

    const primaryRefs = resolveRunUsageSessionRefs(run).sessionIds;
    const additionalSessionIds = await this.listAdditionalRunSessionIds(run.id, primaryRefs);
    if (additionalSessionIds.length === 0) {
      return [];
    }

    const terminalPhaseSessionIds = await this.getTerminalPhaseSessionIds(run.id);
    const activeRelatedSessionIds = additionalSessionIds.filter(
      (sessionId) => !terminalPhaseSessionIds.has(sessionId),
    );
    if (activeRelatedSessionIds.length === 0) {
      return [];
    }

    const snapshots = await Promise.all(
      activeRelatedSessionIds.map(async (sessionId) => [sessionId, await this.getSessionRuntimeSnapshot(sessionId)] as const),
    );

    return snapshots.map(([, snapshot]) =>
      snapshot ? toChildRuntimeStatus(snapshot, run.startedAt, nowMs, this.deps.runInactivityFailMs) : null,
    );
  }

  async getSessionRuntimeSnapshot(sessionId: string): Promise<SessionRuntimeSnapshot | null> {
    if (!this.deps.sessionStatusPort) return null;

    try {
      const runtime = await this.deps.sessionStatusPort.getRuntimeSnapshot(sessionId);
      if (!runtime) return null;

      const lastActiveAt = runtime.lastActiveAt;
      const derivedState = sessionResolverService.deriveRuntimeState({
        session: {
          completed: runtime.completed,
          blockedReason: runtime.blockedReason,
          lastActiveAt,
        },
        blockedReason: runtime.blockedReason,
        completed: runtime.completed,
        pendingApproval: runtime.hasPendingApproval ? { toolCallId: 'pending' } : null,
        isProcessing: runtime.isProcessing,
        nowMs: Date.now(),
      });

      return {
        completed: derivedState.completed,
        blockedReason: derivedState.blockedReason,
        hasPendingApproval: Boolean(derivedState.pendingApproval),
        isProcessing: derivedState.isProcessing,
        lastActivityAt: lastActiveAt,
      };
    } catch {
      return null;
    }
  }

  async hydrateRuntimeStatuses(runList: RunRow[]): Promise<RunRow[]> {
    if (!this.deps.sessionStatusPort || runList.length === 0) {
      return runList;
    }

    const candidates = runList.filter((run) => run.status === 'failed' || RUN_ACTIVE_STATUSES.includes(run.status));
    if (candidates.length === 0) {
      return runList;
    }

    const nowMs = Date.now();
    const effectiveStatusByRunId = new Map<string, RunRow['status']>();

    await Promise.all(
      candidates.map(async (run) => {
        if (!run.sessionId) return;
        try {
          const snapshot = await this.getSessionRuntimeSnapshot(run.sessionId);
          if (!snapshot) return;

          const primaryStatus = mapSessionSnapshotToRunStatus(
            snapshot,
            run.status,
            run.startedAt,
            nowMs,
            this.deps.runInactivityFailMs,
          );
          const relatedStatuses = await this.getRelatedRunStatuses(run, nowMs);
          const nextStatus = chooseRelatedRunStatus(primaryStatus, relatedStatuses);
          const normalizedNextStatus = await this.normalizeGoalPlannerCompletionStatusForRuntime(run, nextStatus);
          if (normalizedNextStatus && normalizedNextStatus !== run.status) {
            effectiveStatusByRunId.set(run.id, normalizedNextStatus as RunRow['status']);
          }
        } catch {
          // Best-effort status enrichment for list UX.
        }
      }),
    );

    if (effectiveStatusByRunId.size === 0) {
      return runList;
    }

    return runList.map((run) => {
      const effectiveStatus = effectiveStatusByRunId.get(run.id);
      return effectiveStatus ? { ...run, status: effectiveStatus } : run;
    });
  }

  async normalizeGoalPlannerCompletionStatusForRuntime(
    run: RunRow,
    status: string | null,
  ): Promise<string | null> {
    if (run.goal && status === 'completed') {
      const [hasPhaseHistory, hasOpenPhases] = await Promise.all([
        this.deps.runPhaseRepository.hasSessionHistory(run.id).catch(() => false),
        this.deps.runPhaseRepository.hasOpenPhases(run.id).catch(() => false),
      ]);
      if (hasPhaseHistory && hasOpenPhases) {
        return 'running';
      }
    }
    return this.normalizeGoalPlannerCompletionStatus(run, status);
  }

  private async getTerminalPhaseSessionIds(runId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!runId) {
      return ids;
    }
    try {
      const phases = await this.deps.runPhaseRepository.listByRunId(runId);
      return collectTerminalPhaseSessionIds(phases);
    } catch {
      return ids;
    }
  }

  private normalizeGoalPlannerCompletionStatus(run: RunRow, status: string | null): string | null {
    if (!status) {
      return status;
    }
    if (
      run.goal &&
      !run.executorSessionId &&
      status === 'completed' &&
      run.trigger !== 'exposure_verification'
    ) {
      if (!run.plan?.trim()) {
        return 'failed';
      }
      return shouldAutoApproveInitialPlan(run) ? 'running' : 'awaiting_approval';
    }
    return status;
  }
}
