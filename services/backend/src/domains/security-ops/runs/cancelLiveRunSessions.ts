import type { AgentApiServices } from '@/app/services/agent/types';
import type { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import { workCancellationRegistry } from '@/domains/agent-brain/application/orchestration/services/WorkContinuationGuard';
import { logger } from '@/shared/logger';
import { publishRunCancellationSignal } from './RunControlSignal';

export type LiveRunSessionCancellationRepository =
  Pick<SessionRepository, 'listIdsByRunId'> &
  Partial<Pick<SessionRepository, 'setBlockedReason'>>;

export type AbortLiveRunSessionsParams = {
  runId: string;
  services?: AgentApiServices;
  sessionRepository: LiveRunSessionCancellationRepository;
  caller: string;
  publishSignal?: boolean;
};

const log = logger.child({ scope: 'RunSessionCancellation' });
const RUN_CANCELLED_REASON = 'run_cancelled_by_operator';

export const abortLiveRunSessions = async (params: AbortLiveRunSessionsParams): Promise<void> => {
  const runId = params.runId.trim();
  if (!runId) {
    return;
  }

  workCancellationRegistry.markRunCancelled(runId);

  const sessionIds = Array.from(new Set(await params.sessionRepository.listIdsByRunId(runId)));
  for (const sessionId of sessionIds) {
    workCancellationRegistry.markSessionCancelled(sessionId);

    if (params.services) {
      try {
        const session = await params.services.sessionStore.getOrHydrate(sessionId);
        if (session) {
          const projection = await params.services.sessionStore.getJournalProjection?.(sessionId);
          if (projection?.desiredExecution !== 'stopped') {
            await params.services.sessionStore.recordStopRequestedAsync?.(
              sessionId,
              RUN_CANCELLED_REASON,
              params.caller,
            );
          }
        }
      } catch (error) {
        // The legacy blocked marker below remains a compatibility safety net,
        // but journal-backed workers honor this explicit Stop intent.
        log.warn(
          { err: error, runId, sessionId, caller: params.caller },
          '[runs] Failed to record cancelled session Stop intent',
        );
      }
    }

    if (params.sessionRepository.setBlockedReason) {
      try {
        await params.sessionRepository.setBlockedReason(sessionId, 'aborted_by_user', {
          reason: RUN_CANCELLED_REASON,
          cancelledAt: new Date().toISOString(),
          runId,
        });
      } catch (error) {
        log.warn({ err: error, runId, sessionId, caller: params.caller }, '[runs] Failed to persist cancelled session marker');
      }
    }
  }

  // Publish as soon as durable blocks exist. Remote workers should not wait
  // for this process to hydrate sessions, stop sandboxes, or clean workspaces.
  if (params.publishSignal !== false) {
    await publishRunCancellationSignal(runId).catch((error) => {
      log.warn({ err: error, runId, caller: params.caller }, '[runs] Failed to publish cancellation control signal');
    });
  }

  if (params.services) {
    for (const sessionId of sessionIds) {
      try {
        await params.services.sessionStore.abortCurrentTurnAsync(sessionId, RUN_CANCELLED_REASON);
      } catch (error) {
        log.warn({ err: error, runId, sessionId, caller: params.caller }, '[runs] Failed to abort active run session');
      }

      try {
        const session = await params.services.sessionStore.getOrHydrate(sessionId);
        if (!session) {
          continue;
        }
        // Cancellation signals are at-least-once and are replayed on startup for already-cancelled
        // runs. An idle session is already stopped; asking the state machine for idle -> idle is an
        // invalid transition and turns normal idempotent recovery into a warning storm.
        if (session.stateMachine && session.stateMachine.getState() !== 'idle') {
          session.stateMachine.stopProcessing('aborted_by_user', session.turn ?? 0, params.caller);
        }
        session.blockedReason = 'aborted_by_user';
        session.blockedMeta = {
          reason: RUN_CANCELLED_REASON,
          runId,
          cancelledAt: new Date().toISOString(),
        };
        const updateReason = params.caller === 'admin.organizations.cancel'
          ? 'admin.run.cancelled'
          : 'run.cancelled';
        await params.services.sessionStore.setAsync(sessionId, session, updateReason);
        await params.services.agentEngine.stopSandbox(session, RUN_CANCELLED_REASON);
      } catch (error) {
        log.warn({ err: error, runId, sessionId, caller: params.caller }, '[runs] Failed to stop live run session');
      }

    }

    const settlementResults = await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        const settled = await params.services!.sessionStore.waitForCurrentTurnToSettleAsync(sessionId);
        return { sessionId, settled };
      } catch (error) {
        log.warn({ err: error, runId, sessionId, caller: params.caller }, '[runs] Failed to await active run session');
        return { sessionId, settled: false };
      }
    }));
    const unsettledSessionIds = settlementResults
      .filter((result) => !result.settled)
      .map((result) => result.sessionId);
    if (unsettledSessionIds.length > 0) {
      throw new Error(
        `run_sessions_did_not_settle:${runId}:${unsettledSessionIds.join(',')}`,
      );
    }

    await params.services.sessionStore.cleanupRunWorkspaceAsync(runId, {
      reason: RUN_CANCELLED_REASON,
      force: true,
    }).catch((error) => {
      log.warn({ err: error, runId, caller: params.caller }, '[runs] Failed to clean up cancelled run workspace');
    });
  }
};
