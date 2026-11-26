/**
 * PreTurnChecks - Pre-flight validation before turn execution
 *
 * Handles:
 * - Work continuation, run authorization and scope verification
 * - Token limits
 * - Sandbox health checks
 *
 * Extracted from OrchestratorAdapter to improve maintainability.
 */

import { logger } from '@/shared/logger';
import type { SessionState } from '../../../domain/types';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { SandboxHealthPort, ScopeVerificationPort } from '../../../ports';
import {
  PINNED_SOURCE_REVIEW_MESSAGES,
  evaluatePinnedSourceReview,
  readAuthorizationModel,
  readPinnedSourceReviewEvidence,
} from './runAuthorization';
import type { TokenGuard } from '../../services/TokenGuard';
import type { WorkContinuationGuard } from './WorkContinuationGuard';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * A session is scope-bound when it carries scope context into the prompt. Those
 * are exactly the sessions the ownership gate applies to; unscoped sessions
 * (admin playground, legacy) are unaffected.
 */
const readScopeId = (session: SessionState): string | undefined => {
  const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const fromFlags = securityops?.scopeId;
  const candidate =
    typeof session.scopeId === 'string' && session.scopeId.trim().length > 0
      ? session.scopeId
      : typeof fromFlags === 'string' && fromFlags.trim().length > 0
        ? fromFlags
        : undefined;
  return candidate?.trim();
};

const DEFAULT_SCOPE_UNVERIFIED_MESSAGE = 'Verify target ownership for this scope before continuing.';

/** Warning emitted during pre-turn checks */
export interface PreTurnWarning {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Result of pre-turn validation */
export interface PreTurnCheckResult {
  /** Whether to proceed with the turn */
  proceed: boolean;
  /** Reason if not proceeding */
  haltReason?:
    'token_limit_exceeded' | 'work_blocked' | 'scope_unverified' | 'source_review_unauthorized';
  /** Data to send with halt event */
  haltEventData?: Record<string, unknown>;
  /** Warnings to emit before turn */
  warnings: PreTurnWarning[];
}

/** Stream interface for emitting events during checks */
export interface PreTurnStream {
  raw(type: string, data: unknown): void;
  done(): void;
}

/** Dependencies for PreTurnChecks */
export interface PreTurnChecksDeps {
  sandboxHealthChecker?: SandboxHealthPort;
  tokenGuard: TokenGuard;
  scopeVerificationPort?: ScopeVerificationPort;
  workContinuationGuard?: WorkContinuationGuard;
}

/**
 * PreTurnChecks validates session state before executing a turn.
 * Returns warnings and can halt execution when a check fails.
 */
export class PreTurnChecks {
  private readonly log = logger.child({ scope: 'PreTurnChecks' });

  constructor(private readonly deps: PreTurnChecksDeps) {}

  /**
   * Execute all pre-turn checks.
   *
   * @param params Check parameters
   * @returns Result indicating whether to proceed
   */
  async execute(params: {
    sessionId: string;
    session: SessionState;
    turnNumber: number;
    recorder?: SessionTraceRecorder;
  }): Promise<PreTurnCheckResult> {
    const { sessionId, session, turnNumber, recorder } = params;
    const warnings: PreTurnWarning[] = [];

    const continuation = await this.deps.workContinuationGuard?.canContinue({
      sessionId,
      boundary: 'pre_turn',
      hydrateDurable: true,
    });
    if (continuation && !continuation.ok) {
      if (recorder) {
        await recorder.write(sessionId, turnNumber, {
          event: 'session.work_blocked',
          severity: 'warn',
          payload: {
            boundary: 'pre_turn',
            reason: continuation.reason,
            status: 'blocked',
            retryable: false,
            resumeAllowed: continuation.reason !== 'aborted_by_user',
            nextAction: 'resume the session if the work block has been cleared',
            source: continuation.source,
          },
          note: `Work blocked before turn: ${continuation.reason}`,
        });
      }
      return {
        proceed: false,
        haltReason: 'work_blocked',
        haltEventData: {
          sessionId,
          reason: continuation.reason,
          boundary: continuation.boundary,
          source: continuation.source,
        },
        warnings,
      };
    }

    // ========================================================================
    // Run authorization check
    //
    // Authoritative gate for every model-calling path: assistant chat,
    // run phases, automations, resumed sessions. Runs before any model call,
    // so a session whose authorization is unproven makes no model call.
    //
    // Two models, dispatched on what the host declared. `target_ownership`
    // is the default and is unchanged: anything that does not explicitly
    // declare otherwise resolves the scope through the verification port.
    // `pinned_source_review` covers read-only review of public source at a
    // fixed commit, where no live target exists to own — it is evaluated
    // from evidence already on the session, with no database access.
    //
    // Both fail closed. Absence of evidence is never permission.
    // ========================================================================
    const authorizationModel = readAuthorizationModel(session.flags?.securityops);

    if (authorizationModel === 'pinned_source_review') {
      const authorization = evaluatePinnedSourceReview(readPinnedSourceReviewEvidence(session.flags?.securityops));

      if (!authorization.authorized) {
        const reason = authorization.reason ?? 'visibility_unproven';
        const message = authorization.message ?? PINNED_SOURCE_REVIEW_MESSAGES[reason];

        this.log.warn({ sessionId, reason }, '[PreTurnChecks] Pinned source review authorization failed, halting turn');

        if (recorder) {
          await recorder.write(sessionId, turnNumber, {
            event: 'session.source_review_unauthorized',
            severity: 'warn',
            payload: { reason },
            note: message,
          });
        }

        return {
          proceed: false,
          haltReason: 'source_review_unauthorized',
          haltEventData: {
            sessionId,
            reason,
            message,
            code: 'run.source_review_unauthorized',
          },
          warnings,
        };
      }
    }

    const scopeId = readScopeId(session);
    if (authorizationModel === 'target_ownership' && scopeId && this.deps.scopeVerificationPort) {
      const verification = await this.deps.scopeVerificationPort.checkScope(scopeId).catch((err: unknown) => {
        this.log.warn(
          { err, sessionId, scopeId },
          '[PreTurnChecks] Scope verification lookup threw; halting turn (fail closed)',
        );
        return { verified: false, reason: 'lookup_failed' as const };
      });

      if (!verification.verified) {
        const message =
          ('message' in verification && typeof verification.message === 'string' ? verification.message : undefined) ??
          DEFAULT_SCOPE_UNVERIFIED_MESSAGE;
        const reason = verification.reason ?? 'unverified';

        this.log.warn(
          { sessionId, scopeId, reason },
          '[PreTurnChecks] Scope target ownership unverified, halting turn',
        );

        if (recorder) {
          await recorder.write(sessionId, turnNumber, {
            event: 'session.scope_unverified',
            severity: 'warn',
            payload: { scopeId, reason },
            note: message,
          });
        }

        return {
          proceed: false,
          haltReason: 'scope_unverified',
          haltEventData: {
            sessionId,
            scopeId,
            reason,
            message,
            code: 'scope.target_unverified',
          },
          warnings,
        };
      }
    }

    // ========================================================================
    // Token limit check
    // ========================================================================
    const tokenGuard = this.deps.tokenGuard;
    const tokenCheck = tokenGuard.checkLimits(sessionId, session.userId);

    if (tokenCheck.exceeded) {
      this.log.warn(
        {
          sessionId,
          userId: session.userId,
          limitType: tokenCheck.limitType,
          usage: tokenCheck.currentUsage,
          limit: tokenCheck.limit,
        },
        '[PreTurnChecks] Token limit exceeded, halting turn',
      );

      // Log to trace
      if (recorder) {
        await recorder.write(sessionId, turnNumber, {
          event: `session.${tokenCheck.limitType}_token_limit_exceeded`,
          severity: 'warn',
          payload: {
            limitType: tokenCheck.limitType,
            currentUsage: tokenCheck.currentUsage,
            limit: tokenCheck.limit,
            usagePct: tokenCheck.usagePct,
          },
          note: tokenCheck.message ?? 'Token limit exceeded',
        });
      }

      return {
        proceed: false,
        haltReason: 'token_limit_exceeded',
        haltEventData: {
          sessionId,
          limitType: tokenCheck.limitType,
          currentUsage: tokenCheck.currentUsage,
          limit: tokenCheck.limit,
          usagePct: Math.round(tokenCheck.usagePct),
          message: tokenCheck.message,
        },
        warnings,
      };
    }

    if (tokenCheck.warning) {
      warnings.push({
        code: 'tokens_high',
        message: tokenCheck.message ?? 'Approaching token limit',
        data: {
          sessionId,
          limitType: tokenCheck.limitType,
          currentUsage: tokenCheck.currentUsage,
          limit: tokenCheck.limit,
          usagePct: Math.round(tokenCheck.usagePct),
        },
      });
    }

    // ========================================================================
    // Sandbox health check
    // ========================================================================
    if (this.deps.sandboxHealthChecker && session.containerId) {
      try {
        const health = await this.deps.sandboxHealthChecker.check(session.containerId);
        if (!health.healthy) {
          this.log.warn(
            {
              sessionId,
              containerId: session.containerId,
              errors: health.errors,
            },
            '[PreTurnChecks] Sandbox unhealthy',
          );

          // Log to trace
          if (recorder) {
            await recorder.write(sessionId, turnNumber, {
              event: 'sandbox.health_check_failed',
              severity: 'warn',
              payload: {
                containerId: session.containerId,
                errors: health.errors,
                containerRunning: health.containerRunning,
                diskSpaceOk: health.diskSpaceOk,
              },
              note: `Sandbox unhealthy: ${health.errors.join(', ')}`,
            });
          }

          warnings.push({
            code: 'sandbox_unhealthy',
            message: `Sandbox health check failed: ${health.errors.join(', ')}`,
          });
        }
      } catch (err) {
        this.log.warn({ err, sessionId }, '[PreTurnChecks] Failed to check sandbox health');
        // Continue anyway - health check is best-effort
      }
    }

    return {
      proceed: true,
      warnings,
    };
  }
}
