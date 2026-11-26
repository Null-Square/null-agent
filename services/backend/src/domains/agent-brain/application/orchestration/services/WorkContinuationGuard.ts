import type { SessionStore } from '../../core/SessionStore';
import type { SessionState } from '../../../domain/types';

export type WorkBoundary = 'pre_turn' | 'model_call' | 'tool_call';

export type WorkContinuationDecision =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      boundary: WorkBoundary;
      source: 'abort_signal' | 'session_blocked' | 'cancellation_marker' | 'durable_blocked_reason';
    };

export type WorkContinuationGuardDeps = {
  sessionStore: SessionStore;
  sessionRepository?: {
    getBlockedReason?: (id: string) => Promise<string | null>;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readRunId = (session: SessionState | undefined): string | null => {
  const securityops = isRecord(session?.flags?.securityops) ? session?.flags.securityops : undefined;
  const securityOpsRunId = securityops?.runId;
  if (typeof securityOpsRunId === 'string' && securityOpsRunId.trim().length > 0) {
    return securityOpsRunId.trim();
  }

  const coordination = isRecord(session?.flags?.coordination) ? session?.flags?.coordination : undefined;
  const coordinatedRunId = coordination?.runId;
  return typeof coordinatedRunId === 'string' && coordinatedRunId.trim().length > 0
    ? coordinatedRunId.trim()
    : null;
};

class WorkCancellationRegistry {
  private readonly cancelledRuns = new Set<string>();
  private readonly cancelledSessions = new Set<string>();
  private readonly explicitlyStartedSessions = new Set<string>();

  markRunCancelled(runId: string): void {
    const normalized = runId.trim();
    if (normalized) {
      this.cancelledRuns.add(normalized);
    }
  }

  markSessionCancelled(sessionId: string): void {
    const normalized = sessionId.trim();
    if (normalized) {
      this.cancelledSessions.add(normalized);
      this.explicitlyStartedSessions.delete(normalized);
    }
  }

  /** A durable Start is newer than the run/session cancellation marker. */
  markSessionStarted(sessionId: string): void {
    const normalized = sessionId.trim();
    if (normalized) {
      this.cancelledSessions.delete(normalized);
      this.explicitlyStartedSessions.add(normalized);
    }
  }

  isCancelled(sessionId: string, runId?: string | null): boolean {
    if (this.cancelledSessions.has(sessionId)) return true;
    if (this.explicitlyStartedSessions.has(sessionId)) return false;
    return Boolean(runId && this.cancelledRuns.has(runId));
  }
}

export const workCancellationRegistry = new WorkCancellationRegistry();

export class WorkContinuationGuard {
  constructor(private readonly deps: WorkContinuationGuardDeps) {}

  async canContinue(params: {
    sessionId: string;
    boundary: WorkBoundary;
    abortSignal?: AbortSignal | null;
    hydrateDurable?: boolean;
  }): Promise<WorkContinuationDecision> {
    const session = this.deps.sessionStore.get(params.sessionId);
    const runId = readRunId(session);

    if (params.abortSignal?.aborted) {
      return {
        ok: false,
        reason: 'aborted_by_user',
        boundary: params.boundary,
        source: 'abort_signal',
      };
    }

    if (typeof session?.blockedReason === 'string' && session.blockedReason.trim().length > 0) {
      return {
        ok: false,
        reason: session.blockedReason.trim(),
        boundary: params.boundary,
        source: 'session_blocked',
      };
    }

    if (workCancellationRegistry.isCancelled(params.sessionId, runId)) {
      return {
        ok: false,
        reason: 'aborted_by_user',
        boundary: params.boundary,
        source: 'cancellation_marker',
      };
    }

    // Every paid/model/tool boundary rechecks the durable marker. PostgreSQL
    // NOTIFY provides low latency, but this query is the authoritative fallback
    // after a missed signal, listener reconnect, or worker restart.
    if (this.deps.sessionRepository?.getBlockedReason) {
      const durableReason = await this.deps.sessionRepository.getBlockedReason(params.sessionId);
      if (typeof durableReason === 'string' && durableReason.trim().length > 0) {
        const reason = durableReason.trim();
        const liveSession = this.deps.sessionStore.get(params.sessionId);
        if (liveSession) {
          liveSession.blockedReason = reason;
        }
        return {
          ok: false,
          reason,
          boundary: params.boundary,
          source: 'durable_blocked_reason',
        };
      }
    }

    return { ok: true };
  }
}
