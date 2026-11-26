import { logger } from '@/shared/logger';
import type { SessionState } from '../../../domain/types';
import type { SessionStore } from '../../core/SessionStore';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { AppError } from '../../../domain/errors';
import { classifyTurnError } from '../../../domain/errors';
import type { RetrySchedulerPort } from '../../../ports';
import { ERROR_CODES } from '@null-ai/contracts';
import type { BlockedSessionClassification, SessionLifecycleService } from '../../services/SessionLifecycleService';

const BASE_ERROR_RETRY_DELAY_MS = 1000;
const MAX_ERROR_RETRY_DELAY_MS = 30_000;
const CREDIT_RECHECK_DELAY_MS = 30_000;
const PROVIDER_QUOTA_BASE_RECHECK_DELAY_MS = 5 * 60_000;
const PROVIDER_QUOTA_MAX_RECHECK_DELAY_MS = 60 * 60_000;

type PersistedErrorBlock = {
  blockedReason: string;
  recoverable: boolean;
  code?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export interface TurnFailureStream {
  raw(type: string, data: unknown): void;
}

export interface TurnFailurePolicyDeps {
  sessionStore: SessionStore;
  sessionLifecycle: Pick<SessionLifecycleService, 'transitionToBlocked'>;
  retryScheduler: RetrySchedulerPort;
}

export interface TurnFailurePolicyParams {
  sessionId: string;
  error: unknown;
  sessionState?: SessionState;
  turnNumber: number;
  turnStream: TurnFailureStream;
  recorder?: SessionTraceRecorder;
  modelName?: string;
  provider?: string;
  processMessage: (sessionId: string, input: string, profile?: string) => Promise<void>;
  executionClaimToken?: string;
}

export class TurnFailurePolicy {
  private readonly log = logger.child({ scope: 'TurnFailurePolicy' });

  constructor(private readonly deps: TurnFailurePolicyDeps) {}

  async handleError(params: TurnFailurePolicyParams): Promise<AppError> {
    const {
      sessionId,
      error,
      sessionState,
      turnNumber,
      turnStream,
      recorder,
      modelName,
      provider,
      processMessage,
      executionClaimToken,
    } = params;
    const session = this.deps.sessionStore.get(sessionId) ?? sessionState;
    const appError = classifyTurnError(error, { sessionId, model: modelName, provider });

    if (!session || session.blockedReason) {
      return appError;
    }

    if (appError.is(ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED)) {
      this.clearRetryState(session);
      await this.persistBlockedError(
        sessionId,
        session,
        appError,
        turnNumber,
        recorder,
        { blockedReason: 'credits_exhausted', recoverable: true, code: 'credits_exhausted' },
        executionClaimToken,
      );
      await this.deps.retryScheduler.scheduleRetry({
        sessionId,
        message: 'continue',
        profile: session.profileKey,
        delayMs: CREDIT_RECHECK_DELAY_MS,
        processMessage,
        reason: 'credits_exhausted',
        ...(executionClaimToken ? { executionClaimToken } : {}),
      });
      return appError;
    }

    if (appError.is(ERROR_CODES.RESOURCE_LIMIT_REACHED)) {
      const nextRetryCount = this.getRetryCount(session, appError.code) + 1;
      const delayMs = this.getProviderQuotaRetryDelayMs(nextRetryCount, appError.retryAfterMs);
      // Reuse the existing durable retry snapshot. Besides avoiding another state/table, this lets
      // an unknown subscription reset back off from 5m to 1h instead of polling the provider every
      // five minutes forever. A successful turn clears the same snapshot during normal cleanup.
      this.setRetryState(session, nextRetryCount, appError, delayMs);
      await this.persistBlockedError(
        sessionId,
        session,
        appError,
        turnNumber,
        recorder,
        {
          blockedReason: 'provider_quota_exhausted',
          recoverable: true,
          code: 'provider_quota_exhausted',
        },
        executionClaimToken,
      );
      turnStream.raw('warning', {
        code: 'provider_quota_exhausted',
        message: 'The selected provider subscription limit was reached. Execution will retry when the limit may be available.',
        retryable: true,
        retryAfterMs: delayMs,
      });
      await this.deps.retryScheduler.scheduleRetry({
        sessionId,
        message: 'continue',
        profile: session.profileKey,
        delayMs,
        processMessage,
        reason: 'provider_quota_exhausted',
        ...(executionClaimToken ? { executionClaimToken } : {}),
      });
      return appError;
    }

    // A provider-declared deterministic failure (policy refusal, invalid model/input, bad auth,
    // context overflow after the one compaction recovery) cannot improve by replaying the same
    // request. Automated recovery remains unbounded for genuinely retryable infrastructure faults.
    const shouldRetry = session.mode === 'automated' && appError.retryable;

    if (shouldRetry) {
      const retryCount = this.getRetryCount(session);
      const nextRetryCount = retryCount + 1;
      const delayMs = this.getRetryDelayMs(nextRetryCount, appError.retryAfterMs);
      this.setRetryState(session, nextRetryCount, appError, delayMs);
      await this.deps.sessionStore.setAsync(sessionId, session, 'process.error.retry');

      const delaySeconds = Math.max(1, Math.round(delayMs / 1000));
      this.log.info(
        {
          sessionId,
          modelName,
          provider,
          code: appError.code,
          retryCount: nextRetryCount,
          retryStrategy: 'durable_session_reconcile',
          providerFailover: 'deferred',
          providerFailoverReason: 'no compatible cross-provider failover policy is configured for in-flight turns',
        },
        'Automated session interruption scheduled for durable reconciliation',
      );
      turnStream.raw('warning', {
        code: 'llm_retry',
        message: `Session execution was interrupted. Retrying in ${delaySeconds}s (attempt ${nextRetryCount}).`,
        retryable: true,
        retryAfterMs: delayMs,
      });

      if (recorder) {
        await recorder.write(sessionId, turnNumber, {
          event: 'turn.error.retry_scheduled',
          severity: 'warn',
          payload: {
            retryCount: nextRetryCount,
            delayMs,
            code: appError.code,
            message: appError.message,
            modelName,
            provider,
            retryStrategy: 'durable_session_reconcile',
            providerFailover: {
              status: 'deferred',
              reason: 'no compatible cross-provider failover policy is configured for in-flight turns',
            },
          },
          note: `retry scheduled in ${delaySeconds}s`,
        });
      }

      await this.deps.retryScheduler.scheduleRetry({
        sessionId,
        message: 'continue',
        profile: session.profileKey,
        delayMs,
        processMessage,
        reason: `error_retry:${appError.code}`,
        ...(executionClaimToken ? { executionClaimToken } : {}),
      });

      return appError;
    }

    const persistedBlock = this.resolvePersistedErrorBlock(appError);
    this.clearRetryState(session);
    await this.persistBlockedError(sessionId, session, appError, turnNumber, recorder, persistedBlock, executionClaimToken);
    return appError;
  }

  clearRetryState(session: SessionState): void {
    if (!isRecord(session.flags?.error_retry)) {
      return;
    }
    const { error_retry: _ignored, ...rest } = session.flags;
    session.flags = rest;
  }

  private getRetryCount(session: SessionState, expectedCode?: string): number {
    const snapshot = isRecord(session.flags?.error_retry) ? session.flags.error_retry : undefined;
    if (expectedCode !== undefined && snapshot?.lastCode !== expectedCode) return 0;
    return typeof snapshot?.retryCount === 'number' ? snapshot.retryCount : 0;
  }

  private setRetryState(
    session: SessionState,
    retryCount: number,
    error: AppError,
    retryAfterMs: number,
  ): void {
    session.flags = {
      ...(session.flags ?? {}),
      error_retry: {
        retryCount,
        lastErrorAt: Date.now(),
        lastCode: error.code,
        lastMessage: error.message,
        retryAfterMs,
      },
    };
  }

  private getRetryDelayMs(retryCount: number, retryAfterMs?: number): number {
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
      return retryAfterMs;
    }
    const delayMs = BASE_ERROR_RETRY_DELAY_MS * Math.pow(2, Math.max(0, retryCount - 1));
    return Math.min(delayMs, MAX_ERROR_RETRY_DELAY_MS);
  }

  private getProviderQuotaRetryDelayMs(retryCount: number, providerRetryAfterMs?: number): number {
    if (typeof providerRetryAfterMs === 'number' && providerRetryAfterMs >= 0) {
      return Math.max(CREDIT_RECHECK_DELAY_MS, providerRetryAfterMs);
    }
    const exponent = Math.min(4, Math.max(0, retryCount - 1));
    return Math.min(
      PROVIDER_QUOTA_BASE_RECHECK_DELAY_MS * Math.pow(2, exponent),
      PROVIDER_QUOTA_MAX_RECHECK_DELAY_MS,
    );
  }

  private resolvePersistedErrorBlock(error: AppError): PersistedErrorBlock {
    if (error.is(ERROR_CODES.LLM_CONTENT_FILTER_TRIGGERED)) {
      return { blockedReason: 'awaiting_user', recoverable: false, code: 'content_filter' };
    }

    if (!error.retryable) {
      return { blockedReason: 'awaiting_user', recoverable: false, code: error.code };
    }

    return { blockedReason: 'error', recoverable: false };
  }

  private async persistBlockedError(
    sessionId: string,
    session: SessionState,
    error: AppError,
    turnNumber: number,
    recorder?: SessionTraceRecorder,
    block: PersistedErrorBlock = { blockedReason: 'error', recoverable: false },
    executionClaimToken?: string,
  ): Promise<void> {
    const classification: BlockedSessionClassification = {
      blockedReason: block.blockedReason,
      recoverable: block.recoverable,
      code: block.code ?? error.code,
      errorCode: error.code,
      message: error.message,
      userMessage: error.userMessage,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      turnNumber,
    };

    await this.deps.sessionLifecycle.transitionToBlocked({
      sessionId,
      session,
      classification,
      recorder,
      executionClaimToken,
    });
  }
}
