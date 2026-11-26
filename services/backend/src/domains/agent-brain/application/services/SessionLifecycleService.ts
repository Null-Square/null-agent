import type { SessionLifecycleConfigLayer } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { buildUserNotificationTarget, extractRunIdFromSession } from '@/shared/notifications/userNotificationTarget';
import type { SessionState, StreamEvent } from '../../domain/types';
import type { NotificationPort, SessionRetentionPort } from '../../ports';
import { NotificationKinds } from '../../ports';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import { stopProcessing } from '../orchestration/utils/sessionProcessing';
import { deriveSessionStatusForEvent, emitSessionStatusEvent } from '../orchestration/utils/sessionStatusEvents';
import type { CheckpointSessionPort } from './CheckpointStoreService';
import { CheckpointStoreService } from './CheckpointStoreService';
import type { CleanupSessionPort } from './SessionCleanupService';
import { SessionCleanupService } from './SessionCleanupService';
import { SessionRetentionReaper } from './SessionRetentionReaper';

type LocalLifecycleOptions = {
  cleanupPort: CleanupSessionPort;
  checkpointPort: CheckpointSessionPort;
  sessionTTL: number;
};

type WorkerLifecycleOptions = {
  sessionLifecycleConfig: SessionLifecycleConfigLayer;
  retentionPort: SessionRetentionPort;
};

type OrchestrationLifecycleOptions = {
  sessionStore: {
    get: (sessionId: string) => SessionState | undefined;
    setAsync: (sessionId: string, session: SessionState, note?: string) => Promise<void>;
  };
  sessionRepository?: {
    setBlockedReason: (id: string, reason: string, meta?: Record<string, unknown>, executionClaimToken?: string) => Promise<boolean>;
  };
  notificationPort?: NotificationPort;
  events?: {
    emit: (sessionId: string, event: StreamEvent) => void;
  };
};

export type BlockedSessionClassification = {
  blockedReason: string;
  recoverable: boolean;
  code?: string;
  errorCode: string;
  message: string;
  userMessage: string;
  retryable: boolean;
  retryAfterMs?: number;
  turnNumber: number;
};

export class SessionLifecycleService {
  private readonly log = logger.child({ scope: 'SessionLifecycleService' });
  readonly cleanupService?: SessionCleanupService;
  readonly checkpointService?: CheckpointStoreService;
  readonly retentionReaper?: SessionRetentionReaper;
  private readonly orchestrationLifecycle?: OrchestrationLifecycleOptions;

  constructor(options: {
    local?: LocalLifecycleOptions;
    worker?: WorkerLifecycleOptions;
    orchestration?: OrchestrationLifecycleOptions;
  }) {
    if (options.local) {
      this.cleanupService = new SessionCleanupService(
        options.local.cleanupPort,
        { sessionTTL: options.local.sessionTTL },
      );
      this.checkpointService = new CheckpointStoreService(options.local.checkpointPort);
    }

    if (options.worker) {
      this.retentionReaper = new SessionRetentionReaper(
        options.worker.sessionLifecycleConfig,
        options.worker.retentionPort,
      );
    }

    if (options.orchestration) {
      this.orchestrationLifecycle = options.orchestration;
    }
  }

  static forStore(options: LocalLifecycleOptions): SessionLifecycleService {
    return new SessionLifecycleService({ local: options });
  }

  static forWorkers(options: WorkerLifecycleOptions): SessionLifecycleService {
    return new SessionLifecycleService({ worker: options });
  }

  static forOrchestration(options: OrchestrationLifecycleOptions): SessionLifecycleService {
    return new SessionLifecycleService({ orchestration: options });
  }

  startLocal(): void {
    this.cleanupService?.start();
  }

  stopLocal(): void {
    this.cleanupService?.shutdown();
  }

  startWorkers(intervalMs?: number): void {
    if (intervalMs) {
      this.retentionReaper?.start(intervalMs);
    } else {
      this.retentionReaper?.start();
    }
  }

  stopWorkers(): void {
    this.retentionReaper?.stop();
  }

  async transitionToBlocked(params: {
    sessionId: string;
    session: SessionState;
    classification: BlockedSessionClassification;
    recorder?: SessionTraceRecorder;
    executionClaimToken?: string;
  }): Promise<void> {
    if (!this.orchestrationLifecycle) {
      throw new Error('SessionLifecycleService.transitionToBlocked requires orchestration lifecycle wiring');
    }

    const { sessionId, session, classification, recorder, executionClaimToken } = params;
    const previousStatus = deriveSessionStatusForEvent(session);
    const blockedMeta = {
      code: classification.code ?? classification.errorCode,
      errorCode: classification.errorCode,
      message: classification.message,
      retryable: classification.retryable,
      retryAfterMs: classification.retryAfterMs,
      reason: classification.blockedReason,
      recoverable: classification.recoverable,
      turn: classification.turnNumber,
      mode: session.mode,
    };

    session.blockedReason = classification.blockedReason;
    session.blockedMeta = blockedMeta;
    if (session.stateMachine?.getState?.() !== 'idle') {
      stopProcessing(session, {
        reason: classification.blockedReason,
        turnNumber: session.turn,
        caller: 'SessionLifecycleService',
      });
    }

    // Explicit ordering: sync live state first, then durable DB, trace, and user notification.
    await this.orchestrationLifecycle.sessionStore.setAsync(
      sessionId,
      session,
      classification.recoverable ? 'process.error.recoverable_paused' : 'process.error.blocked',
    );

    const updatedSession = this.orchestrationLifecycle.sessionStore.get(sessionId);
    if (updatedSession && this.orchestrationLifecycle.events) {
      const nextStatus = deriveSessionStatusForEvent(updatedSession);
      if (nextStatus !== previousStatus) {
        emitSessionStatusEvent(
          this.orchestrationLifecycle.events,
          updatedSession,
          previousStatus,
          classification.recoverable ? 'recoverable_error_blocked' : 'error_blocked',
          recorder,
        );
      }
    }

    if (this.orchestrationLifecycle.sessionRepository?.setBlockedReason) {
      try {
        if (executionClaimToken) {
          await this.orchestrationLifecycle.sessionRepository.setBlockedReason(
            sessionId,
            classification.blockedReason,
            blockedMeta,
            executionClaimToken,
          );
        } else {
          await this.orchestrationLifecycle.sessionRepository.setBlockedReason(
            sessionId,
            classification.blockedReason,
            blockedMeta,
          );
        }
      } catch (err) {
        this.log.warn({ err, sessionId }, 'Failed to persist blocked_reason');
      }
    }

    if (recorder) {
      await recorder.write(sessionId, classification.turnNumber, {
        event: classification.recoverable ? 'turn.error.recoverable_paused' : 'turn.error.blocked',
        severity: classification.recoverable ? 'warn' : 'error',
        payload: {
          code: classification.code ?? classification.errorCode,
          errorCode: classification.errorCode,
          message: classification.message,
          retryable: classification.retryable,
          reason: classification.blockedReason,
          recoverable: classification.recoverable,
        },
        note: classification.recoverable ? 'recoverable error paused session' : 'processing error persisted',
      });
    }

    if (session.userId && session.mode === 'automated' && this.orchestrationLifecycle.notificationPort) {
      const target = buildUserNotificationTarget({
        destination: 'run_workbench',
        runId: extractRunIdFromSession(session),
        sessionId,
      });
      this.orchestrationLifecycle.notificationPort
        .notify({
          userId: session.userId,
          type: NotificationKinds.SESSION_ERROR,
          title: 'Session Needs Attention',
          message: classification.userMessage,
          ...(target.link ? { link: target.link } : {}),
          data: target.data,
        })
        .catch((err) => this.log.warn({ err, userId: session.userId }, 'Failed to send error notification'));
    }
  }
}
