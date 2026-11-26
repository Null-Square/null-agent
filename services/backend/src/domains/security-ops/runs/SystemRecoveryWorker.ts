import { randomUUID } from 'node:crypto';

import { and, eq, or, sql } from 'drizzle-orm';

import type { AgentApiServices } from '@/app/services/agent/types';
import type { DatabaseClient } from '@/db/client';
import {
  runPhases,
  runs,
  type RunPhaseReplanRow,
  type RunPhaseRow,
  type RunRow,
} from '@/db/schema';
import {
  SessionRepository,
  type ClaimedSessionRecovery,
} from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import type { SessionJournalRecoveryService } from '@/domains/agent-brain/application/services/SessionJournalRecoveryService';
import { workCancellationRegistry } from '@/domains/agent-brain/application/orchestration/services/WorkContinuationGuard';
import { logger } from '@/shared/logger';

import type { RunService } from './RunService';
import { RunPhaseReplanRepository } from './RunPhaseReplanRepository';
import type { StartRunService } from './StartRunService';
import type { CapacityLeaseService } from './scheduling/CapacityLeaseService';
import type { CloudRunSchedulingConfig } from './scheduling/CloudRunSchedulingConfig';

const CLAIM_TTL_MS = 60_000;
const CLAIM_HEARTBEAT_MS = 15_000;
const SESSION_BATCH_SIZE = 10;
const REPLAN_BATCH_SIZE = 5;
const SESSION_CONCURRENCY = 3;
const REPLAN_CONCURRENCY = 2;
const SESSION_RECOVERY_ERROR_RETRY_MS = 30_000;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MANUAL_PREREQUISITE_RUN_STATUSES = new Set([
  'user_paused',
  'awaiting_user',
  'awaiting_approval',
]);
const REPLAN_PREREQUISITE_RUN_STATUSES = new Set([
  ...MANUAL_PREREQUISITE_RUN_STATUSES,
  'credits_exhausted',
  'runner_unavailable',
]);
const REPLAN_MAX_ATTEMPTS = 3;

type RecoveryWorkerDeps = {
  db: DatabaseClient;
  sessions: SessionRepository;
  replans: RunPhaseReplanRepository;
  runService: Pick<
    RunService,
    'onSessionStatusChange' | 'transitionStatusIfCurrent' | 'authorizeRecoveryExecution' | 'recordRunEvent'
  >;
  startRunService: Pick<StartRunService, 'dispatchClaimedPhaseReplan'>;
  leases: Pick<CapacityLeaseService, 'ensurePlatformCloudRunner' | 'verifyLocalRecoveryOwnership'>;
  config: CloudRunSchedulingConfig;
  agentServices: Pick<AgentApiServices, 'sessionStore' | 'orchestrator'>;
  journalRecovery: Pick<SessionJournalRecoveryService, 'reconcile'>;
  workerId?: string;
  now?: () => Date;
  random?: () => number;
};

type RecoverySummary = {
  sessionsClaimed: number;
  sessionsRecovered: number;
  sessionsDeferred: number;
  sessionsFailed: number;
  replansClaimed: number;
  replansDispatched: number;
  replansDeferred: number;
  replansFailed: number;
};

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 2_000);

const metadataRunId = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const flags = (metadata as Record<string, unknown>).flags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return null;
  const securityops = (flags as Record<string, unknown>).securityops;
  if (!securityops || typeof securityops !== 'object' || Array.isArray(securityops)) return null;
  const value = (securityops as Record<string, unknown>).runId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const approvedToolArguments = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw?.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('approved_tool_arguments_invalid');
  }
  return parsed as Record<string, unknown>;
};

const pendingInputExecutionOptions = (fold: {
  pendingInputMessageIds?: readonly string[];
  messages?: ReadonlyArray<{
    id: string;
    metadata?: Record<string, unknown>;
  }>;
}): {
  profileKey?: string;
  extraContext?: string;
  metadata?: Record<string, unknown>;
} => {
  const pendingIds = new Set(fold.pendingInputMessageIds ?? []);
  const message = fold.messages?.find((candidate) => pendingIds.has(candidate.id));
  const turnExecution = message?.metadata?.turnExecution;
  if (!turnExecution || typeof turnExecution !== 'object' || Array.isArray(turnExecution)) {
    return {};
  }
  const execution = turnExecution as Record<string, unknown>;
  const profileKey = typeof execution.profileKey === 'string' && execution.profileKey.trim()
    ? execution.profileKey.trim()
    : undefined;
  const extraContext = typeof execution.extraContext === 'string' && execution.extraContext.trim()
    ? execution.extraContext
    : undefined;
  return {
    ...(profileKey ? { profileKey } : {}),
    ...(extraContext ? { extraContext } : {}),
    ...(message?.metadata ? { metadata: message.metadata } : {}),
  };
};

export class SystemRecoveryWorker {
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly log = logger.child({ scope: 'SystemRecoveryWorker' });
  private inFlight = false;

  constructor(private readonly deps: RecoveryWorkerDeps) {
    this.workerId = deps.workerId ?? `system-recovery:${process.pid}`;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
  }

  async tick(): Promise<RecoverySummary> {
    const summary: RecoverySummary = {
      sessionsClaimed: 0,
      sessionsRecovered: 0,
      sessionsDeferred: 0,
      sessionsFailed: 0,
      replansClaimed: 0,
      replansDispatched: 0,
      replansDeferred: 0,
      replansFailed: 0,
    };
    if (this.inFlight) return summary;
    this.inFlight = true;
    try {
      if (this.deps.config.queueCloudRuns) {
        await this.deps.leases.ensurePlatformCloudRunner().catch((error) => {
          this.log.warn({ err: error }, 'Local cloud runner identity is not ready for recovery');
        });
      }
      let sessionSlots = SESSION_BATCH_SIZE;
      const sessionDrains = Array.from({ length: SESSION_CONCURRENCY }, async () => {
        while (sessionSlots > 0) {
          sessionSlots -= 1;
          const outcome = await this.processNextSession();
          if (outcome === 'idle') return;
          summary.sessionsClaimed += 1;
          if (outcome === 'recovered') summary.sessionsRecovered += 1;
          if (outcome === 'deferred') summary.sessionsDeferred += 1;
          if (outcome === 'failed') summary.sessionsFailed += 1;
        }
      });
      await this.settleDrains(sessionDrains);

      let replanSlots = REPLAN_BATCH_SIZE;
      const replanDrains = Array.from({ length: REPLAN_CONCURRENCY }, async () => {
        while (replanSlots > 0) {
          replanSlots -= 1;
          const outcome = await this.processNextReplan();
          if (outcome === 'idle') return;
          summary.replansClaimed += 1;
          if (outcome === 'dispatched') summary.replansDispatched += 1;
          if (outcome === 'deferred') summary.replansDeferred += 1;
          if (outcome === 'failed') summary.replansFailed += 1;
        }
      });
      await this.settleDrains(replanDrains);
      if (summary.sessionsClaimed > 0 || summary.replansClaimed > 0) {
        const batchSaturated =
          summary.sessionsClaimed === SESSION_BATCH_SIZE ||
          summary.replansClaimed === REPLAN_BATCH_SIZE;
        this.log[batchSaturated ? 'warn' : 'info'](
          { ...summary, batchSaturated },
          batchSaturated
            ? 'Recovery sweep reached its batch limit; due work may remain'
            : 'Recovery sweep completed',
        );
      }
      return summary;
    } finally {
      this.inFlight = false;
    }
  }

  private async settleDrains(drains: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(drains);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  private async processNextSession(): Promise<'idle' | 'recovered' | 'deferred' | 'failed'> {
    const claimToken = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.deps.sessions.claimDueRecovery({
      claimToken,
      expiresAt: new Date(this.now().getTime() + CLAIM_TTL_MS),
    });
    if (!claimed) return 'idle';

    const heartbeat = setInterval(() => {
      void this.deps.sessions.renewExecutionClaim({
        sessionId: claimed.session.id,
        claimToken,
        expiresAt: new Date(this.now().getTime() + CLAIM_TTL_MS),
      }).catch((error) => {
        this.log.warn({ err: error, sessionId: claimed.session.id }, 'Session recovery claim heartbeat failed');
      });
    }, CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      return await this.processJournalClaimedSession(claimed, claimToken);
    } catch (error) {
      const message = errorMessage(error);
      // Recovery infrastructure failures have no persisted attempt counter.
      // A fixed bounded delay avoids a permanent one-second hot loop while
      // preserving the invariant that only explicit user Stop ends recovery.
      const retryAt = new Date(this.now().getTime() + SESSION_RECOVERY_ERROR_RETRY_MS);
      try {
        await this.deps.agentServices.sessionStore.recordExecutionDeferredAsync(
          claimed.session.id,
          `continuation_error:${message}`,
          retryAt,
          `continuation:${claimToken}:retry`,
          claimToken,
        );
      } catch (scheduleError) {
        await this.deps.sessions.deferClaimedContinuation({
          sessionId: claimed.session.id,
          claimToken,
          nextAttemptAt: retryAt,
        }).catch(() => false);
        this.log.warn(
          { err: scheduleError, sessionId: claimed.session.id },
          'Journal retry event could not be recorded; due projection was deferred directly',
        );
      }
      this.log.warn({ err: error, sessionId: claimed.session.id }, 'Session continuation will retry');
      return 'deferred';
    } finally {
      clearInterval(heartbeat);
      await this.deps.sessions.releaseExecutionClaim(claimed.session.id, claimToken).catch(() => false);
    }
  }

  /**
   * Journal-native continuation path. It derives work from durable facts and
   * uses `agent_sessions` only for a lease and due-time projection.
   */
  private async processJournalClaimedSession(
    claimed: ClaimedSessionRecovery,
    claimToken: string,
  ): Promise<'recovered' | 'deferred'> {
    const { session } = claimed;
    if (!session.nextAttemptAt) throw new Error('continuation_due_time_missing');

    await this.deps.agentServices.sessionStore.ensureJournalForRecoveryAsync(session.id);
    const recovery = await this.deps.journalRecovery!.reconcile(session.id, {
      executionInterrupted: claimed.interruptedTurn,
      interruptedAt: this.now(),
    });
    if (recovery.fold.issues.length > 0) {
      throw new Error(`session_journal_degraded:${recovery.fold.issues[0]?.detail ?? 'unknown'}`);
    }
    await this.deps.agentServices.sessionStore.applyJournalProjectionAsync(session.id, recovery.fold);
    if (recovery.fold.desiredExecution === 'running') {
      // The durable journal is newer authority than any in-process cancellation
      // marker replayed for the associated business run.
      workCancellationRegistry.markSessionStarted(session.id);
    }

    if (
      recovery.fold.desiredExecution === 'stopped'
      || (!recovery.fold.pendingCloseout && (
        recovery.continuation.kind === 'none'
        || recovery.continuation.kind === 'wait_for_approval'
      ))
    ) {
      const acknowledged = await this.deps.sessions.acknowledgeClaimedContinuation({
        sessionId: session.id,
        claimToken,
        claimedDueAt: session.nextAttemptAt,
      });
      return acknowledged ? 'recovered' : 'deferred';
    }

    const resolvedRun = await this.resolveRun(session.id, session.metadata);
    // A pending Start fact is the only authority that can release a business
    // prerequisite for this session. No mutable metadata hand-off is needed.
    const releasedPrerequisite = recovery.fold.pendingStartSequence !== undefined
      && resolvedRun
      && MANUAL_PREREQUISITE_RUN_STATUSES.has(resolvedRun.status)
      ? resolvedRun.status
      : null;
    // A terminal assessment remains terminal as a business aggregate, but it
    // cannot make the underlying session history unstartable. Run an unfinished
    // journal continuation detached from terminal run transitions and capacity.
    const run = resolvedRun && TERMINAL_RUN_STATUSES.has(resolvedRun.status)
      ? null
      : resolvedRun;
    if (run?.status === 'queued') {
      await this.deferJournalContinuation(session.id, claimToken, 'run_queued', 30_000);
      return 'deferred';
    }
    if (
      run
      && MANUAL_PREREQUISITE_RUN_STATUSES.has(run.status)
      && releasedPrerequisite !== run.status
    ) {
      await this.deferJournalContinuation(session.id, claimToken, `run_prerequisite:${run.status}`, 30_000);
      return 'deferred';
    }

    if (recovery.fold.pendingCloseout) {
      const outcome = await this.deps.agentServices.orchestrator.recoverClaimedCloseout(session.id, claimToken);
      if (outcome !== 'completed') return 'deferred';
      // closeout.completed clears the due projection in the same append, so a
      // second acknowledgement would race against the successful write.
      await this.deps.runService.onSessionStatusChange(session.id, 'completed');
      return 'recovered';
    }

    const capacity = await this.verifyCapacity(run);
    if (capacity === 'wrong_host' || capacity === 'runner_unavailable') {
      await this.deferJournalContinuation(session.id, claimToken, `capacity:${capacity}`, 15_000);
      return 'deferred';
    }
    if (capacity === 'missing') {
      await this.deferJournalContinuation(session.id, claimToken, 'capacity:missing', 30_000);
      return 'deferred';
    }

    const began = await this.deps.sessions.beginClaimedContinuation({
      sessionId: session.id,
      claimToken,
    });
    if (!began) return 'deferred';
    await this.clearLiveSessionBlock(session.id);

    if (run) {
      const authorized = await this.deps.runService.authorizeRecoveryExecution({
        orgId: run.organizationId,
        runId: run.id,
        allowedStatuses: [run.status],
      });
      if (!authorized) throw new Error('continuation_run_state_changed');
    }

    if (recovery.continuation.kind === 'execute_approved_tool') {
      const approved = recovery.continuation;
      const request = recovery.fold.pendingToolRequests.find(
        (candidate) => candidate.toolCallId === approved.toolCallId,
      );
      if (!request) throw new Error('approved_tool_request_missing');
      const args = approvedToolArguments(request.arguments);
      await this.deps.agentServices.orchestrator.handleClaimedApprovalResume(
        session.id,
        claimToken,
        {
          actionId: approved.actionId,
          toolCallId: approved.toolCallId,
          ...(request.modelRequestId ? { modelRequestId: request.modelRequestId } : {}),
          toolName: request.toolName,
          ...(args ? { args } : {}),
        },
      );
    } else {
      const execution = pendingInputExecutionOptions(recovery.fold);
      if (execution.profileKey || execution.extraContext) {
        await this.deps.agentServices.orchestrator.processClaimedMessage(
          session.id,
          claimToken,
          '',
          execution.profileKey,
          execution.extraContext,
          execution.metadata,
        );
      } else {
        await this.deps.agentServices.orchestrator.processClaimedMessage(session.id, claimToken);
      }
    }

    const acknowledged = await this.deps.sessions.acknowledgeClaimedContinuation({
      sessionId: session.id,
      claimToken,
      claimedDueAt: session.nextAttemptAt,
    });
    return acknowledged ? 'recovered' : 'deferred';
  }

  private async deferJournalContinuation(
    sessionId: string,
    claimToken: string,
    reason: string,
    delayMs: number,
  ): Promise<void> {
    const retryAt = new Date(this.now().getTime() + delayMs);
    await this.deps.agentServices.sessionStore.recordExecutionDeferredAsync(
      sessionId,
      reason,
      retryAt,
      `continuation:${claimToken}:deferred:${reason}`,
      claimToken,
    );
  }

  private async processNextReplan(): Promise<'idle' | 'dispatched' | 'deferred' | 'failed'> {
    const claimToken = `${this.workerId}:${randomUUID()}`;
    const replan = await this.deps.replans.claimDue({
      claimToken,
      expiresAt: new Date(this.now().getTime() + CLAIM_TTL_MS),
    });
    if (!replan) return 'idle';

    const heartbeat = setInterval(() => {
      void this.deps.replans.renewClaim({
        replanId: replan.id,
        claimToken,
        expiresAt: new Date(this.now().getTime() + CLAIM_TTL_MS),
      }).catch((error) => {
        this.log.warn({ err: error, replanId: replan.id }, 'Phase replan claim heartbeat failed');
      });
    }, CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const context = await this.loadReplanContext(replan);
      if (!context) {
        const failed = await this.deps.replans.failClaimed({
          replanId: replan.id,
          claimToken,
          error: 'Run or phase for this replan no longer exists.',
        });
        return failed ? 'failed' : 'deferred';
      }
      const { run, phase } = context;
      if (run.status === 'queued') {
        return await this.failReplan(run, replan, claimToken, 'A queued Run cannot dispatch phase recovery.')
          ? 'failed'
          : 'deferred';
      }
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        const failed = await this.deps.replans.failClaimed({
          replanId: replan.id,
          claimToken,
          error: `Run is already ${run.status}.`,
        });
        return failed ? 'failed' : 'deferred';
      }
      if (REPLAN_PREREQUISITE_RUN_STATUSES.has(run.status)) {
        await this.deps.replans.deferClaimWithoutAttempt({
          replanId: replan.id,
          claimToken,
          nextAttemptAt: new Date(this.now().getTime() + 30_000),
        });
        return 'deferred';
      }
      const capacity = await this.verifyCapacity(run);
      if (capacity === 'wrong_host' || capacity === 'runner_unavailable') {
        await this.deps.replans.deferClaimWithoutAttempt({
          replanId: replan.id,
          claimToken,
          nextAttemptAt: new Date(this.now().getTime() + 15_000),
        });
        return 'deferred';
      }
      if (capacity === 'missing') {
        return await this.failReplan(run, replan, claimToken, 'The active Run capacity lease is missing.')
          ? 'failed'
          : 'deferred';
      }
      if (replan.dispatchAttempts > REPLAN_MAX_ATTEMPTS) {
        return await this.failReplan(run, replan, claimToken, 'Phase replan exhausted its dispatch attempts.')
          ? 'failed'
          : 'deferred';
      }
      const stillOwned = await this.deps.replans.renewClaim({
        replanId: replan.id,
        claimToken,
        expiresAt: new Date(this.now().getTime() + CLAIM_TTL_MS),
      });
      if (!stillOwned) return 'deferred';
      const authorized = await this.deps.runService.authorizeRecoveryExecution({
        orgId: run.organizationId,
        runId: run.id,
        allowedStatuses: [run.status],
      });
      if (!authorized) {
        const failed = await this.deps.replans.failClaimed({
          replanId: replan.id,
          claimToken,
          error: 'Run state changed before phase recovery execution.',
        });
        return failed ? 'failed' : 'deferred';
      }

      const ownedBeforeDispatch = await this.deps.replans.renewClaim({
        replanId: replan.id,
        claimToken,
        expiresAt: new Date(this.now().getTime() + CLAIM_TTL_MS),
      });
      if (!ownedBeforeDispatch) return 'deferred';

      await this.deps.startRunService.dispatchClaimedPhaseReplan({ run, phase, replan });
      const stillOpen = await this.deps.replans.findOpen({ runId: run.id, phaseId: phase.id });
      if (stillOpen) {
        // The session journal now owns execution. Keep the replan row as the
        // durable prerequisite marker and inspect it again without consuming a
        // dispatch attempt; the session continuation worker performs retries.
        await this.deps.replans.deferClaimWithoutAttempt({
          replanId: replan.id,
          claimToken,
          nextAttemptAt: new Date(this.now().getTime() + 30_000),
        });
      }
      return 'dispatched';
    } catch (error) {
      const message = errorMessage(error);
      const [run] = await this.deps.db.select().from(runs).where(eq(runs.id, replan.runId)).limit(1);
      if (replan.dispatchAttempts >= REPLAN_MAX_ATTEMPTS) {
        const failed = run
          ? await this.failReplan(run, replan, claimToken, message)
          : await this.deps.replans.failClaimed({ replanId: replan.id, claimToken, error: message });
        return failed ? 'failed' : 'deferred';
      }
      const scheduled = await this.deps.replans.scheduleClaimedRetry({
        replanId: replan.id,
        claimToken,
        nextAttemptAt: this.retryAt(replan.dispatchAttempts),
        error: message,
      });
      if (scheduled && run?.status === 'running') {
        await this.deps.runService.transitionStatusIfCurrent({
          orgId: run.organizationId,
          runId: run.id,
          expectedStatuses: ['running'],
          nextStatus: 'system_paused',
        });
      }
      return 'deferred';
    } finally {
      clearInterval(heartbeat);
      await this.deps.replans.releaseClaim(replan.id, claimToken).catch(() => false);
    }
  }

  private async resolveRun(sessionId: string, metadata: unknown): Promise<RunRow | null> {
    const flaggedRunId = metadataRunId(metadata);
    const [run] = await this.deps.db
      .select()
      .from(runs)
      .where(flaggedRunId
        ? eq(runs.id, flaggedRunId)
        : or(
            eq(runs.sessionId, sessionId),
            eq(runs.plannerSessionId, sessionId),
            eq(runs.executorSessionId, sessionId),
            sql`EXISTS (SELECT 1 FROM run_phases phase WHERE phase.run_id = ${runs.id} AND phase.session_id = ${sessionId})`,
          ))
      .limit(1);
    return run ?? null;
  }

  private async verifyCapacity(
    run: RunRow | null,
  ): Promise<'owned' | 'not_required' | 'missing' | 'wrong_host' | 'runner_unavailable'> {
    if (
      !run ||
      run.executionTarget !== 'cloud' ||
      !this.deps.config.queueCloudRuns
    ) {
      return 'not_required';
    }
    if (run.admissionEpoch <= 0) return 'missing';
    return this.deps.leases.verifyLocalRecoveryOwnership(run.id, run.admissionEpoch);
  }

  private async loadReplanContext(
    replan: RunPhaseReplanRow,
  ): Promise<{ run: RunRow; phase: RunPhaseRow } | null> {
    const [[run], [phase]] = await Promise.all([
      this.deps.db.select().from(runs).where(eq(runs.id, replan.runId)).limit(1),
      this.deps.db.select().from(runPhases).where(and(eq(runPhases.id, replan.phaseId), eq(runPhases.runId, replan.runId))).limit(1),
    ]);
    return run && phase ? { run, phase } : null;
  }

  private async failReplan(
    run: RunRow,
    replan: RunPhaseReplanRow,
    claimToken: string,
    message: string,
  ): Promise<boolean> {
    const failed = await this.deps.replans.failClaimed({ replanId: replan.id, claimToken, error: message });
    if (!failed) return false;
    await this.deps.runService.transitionStatusIfCurrent({
      orgId: run.organizationId,
      runId: run.id,
      expectedStatuses: ['running', 'system_paused'],
      nextStatus: 'failed',
    });
    await this.deps.runService.recordRunEvent({
      runId: run.id,
      type: 'phase_replan_failed',
      note: message,
    });
    return true;
  }

  private async clearLiveSessionBlock(sessionId: string): Promise<void> {
    const live =
      (await this.deps.agentServices.sessionStore.getOrHydrate?.(sessionId)) ??
      this.deps.agentServices.sessionStore.get(sessionId);
    if (!live) return;
    const {
      credits_exhausted: _creditsExhausted,
      user_paused: _userPaused,
      runner_unavailable: _runnerUnavailable,
      system_paused: _systemPaused,
      ...restFlags
    } = live.flags ?? {};
    const previousCacheControl =
      typeof live.flags?.cache_control === 'object' && live.flags.cache_control !== null
        ? live.flags.cache_control as { prefixHash?: unknown; createdAt?: unknown }
        : undefined;
    const cacheContinuationReason = live.blockedReason === 'user_paused'
      ? 'user_resumed'
      : live.blockedReason === 'runner_unavailable'
        ? 'runner_reconnected'
        : live.blockedReason === 'credits_exhausted'
          ? 'credits_restored'
          : 'system_recovered';
    live.blockedReason = undefined;
    live.blockedMeta = undefined;
    live.flags = {
      ...restFlags,
      cache_resume_pending: {
        reason: cacheContinuationReason,
        resumedAt: this.now().toISOString(),
        ...(typeof previousCacheControl?.prefixHash === 'string'
          ? { previousPrefixHash: previousCacheControl.prefixHash }
          : {}),
        ...(typeof previousCacheControl?.createdAt === 'number'
          ? { previousCreatedAt: previousCacheControl.createdAt }
          : {}),
      },
    };
    await this.deps.agentServices.sessionStore.setAsync(sessionId, live, 'system_recovery.continuation');
  }

  private retryAt(attempt: number): Date {
    const baseMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
    const jitter = 0.8 + Math.max(0, Math.min(1, this.random())) * 0.4;
    return new Date(this.now().getTime() + Math.round(baseMs * jitter));
  }
}

export const createSystemRecoveryRepositories = (db: DatabaseClient) => ({
  sessions: new SessionRepository(db),
  replans: new RunPhaseReplanRepository(db),
});
