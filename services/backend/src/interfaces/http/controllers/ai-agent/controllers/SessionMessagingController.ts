/**
 * SessionMessagingController - Handle session messaging operations
 * 
 * Routes:
 * - POST /sessions/:sessionId/message - Send message to session
 * - GET /sessions/:sessionId/summary - Get session summary
 * - GET /sessions/:sessionId/usage - Get session usage stats
 */

import { type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@/domains/agent-brain/domain/types';
import {
  BaseSessionController,
  type SessionControllerContext,
  type AuthenticatedRequest,
} from './types';
import { ensureSessionAccess, ensureSessionExists } from '../routes/helpers/sessionAccess';
import {
  STALE_PHASE_SESSION_STATUSES,
  buildStalePhaseSessionResponse,
  writeWorkbenchActionTrace,
} from '../routes/helpers/workbenchLifecycle';
import { assertRunObservabilityAccess } from '../routes/helpers/sessionAccess';
import { scopeVerificationMessage } from '@/domains/security-ops/scopes/scopeVerificationGate';
import { scopeVerificationGate } from '@/domains/security-ops/scopes/securityOpsScopeVerificationGate';
import { ErrorFactory, isAppError, getErrorMessage } from '@/shared/errors';
import {
  resolveSessionPresentation,
  type SessionExecutionReadModel,
} from '@null-ai/contracts';

// Helper
const getErrorCode = (error: unknown, fallback: string): string => {
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return fallback;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : fallback;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class SessionMessagingController extends BaseSessionController {
  constructor(context: SessionControllerContext) {
    super(context);
  }

  private async executionMutationResponse(
    sessionId: string,
  ): Promise<SessionExecutionReadModel & {
    status: ReturnType<typeof resolveSessionPresentation>['status'];
    pause_reason: ReturnType<typeof resolveSessionPresentation>['pauseReason'];
    interaction_type: 'none';
    blocked_reason: string | null;
  }> {
    const executionReadModel = await this.services.sessionStore.getExecutionReadModel(sessionId);
    if (!executionReadModel) {
      throw ErrorFactory.internal.unexpected('Session execution projection is unavailable.', {
        context: { sessionId },
      });
    }
    const presentation = resolveSessionPresentation(executionReadModel);
    const blockedReason = await this.sessionRepository.getBlockedReason(sessionId).catch(() => null);
    return {
      ...executionReadModel,
      status: presentation.status,
      pause_reason: presentation.pauseReason,
      interaction_type: 'none',
      blocked_reason: blockedReason,
    };
  }

  /**
   * POST /sessions/:sessionId/message - Send message to session
   */
  async sendMessage(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const { text, profileKey, extraContext } = req.body as {
      text: string;
      profileKey?: string;
      extraContext?: string;
    };

    const session = await this.services.sessionStore.getOrHydrate(sessionId);
    const authedReq = req as AuthenticatedRequest;
    ensureSessionExists(session, sessionId);
    ensureSessionAccess(session, authedReq);
    await assertRunObservabilityAccess({
      session,
      req: authedReq,
      accessControl: this.ctx.accessControl,
    });
    const policyLock = isRecord(session.flags?.policy_lock) ? session.flags.policy_lock : undefined;
    const lockedProfileKey = typeof policyLock?.profileKey === 'string' ? policyLock.profileKey.trim() : undefined;

    if (
      lockedProfileKey &&
      typeof profileKey === 'string' &&
      profileKey.trim().length > 0 &&
      profileKey.trim() !== lockedProfileKey
    ) {
      res.status(403).json({
        accepted: false,
        message: 'Profile override is not allowed for this session.',
      });
      return;
    }

    const securityOps = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;

    // Scope target ownership. PreTurnChecks is the authoritative gate, but a
    // session can outlive the target it was created against (targets are
    // deletable), so reject here too and give the client a real status code
    // instead of a 202 followed by a halted turn.
    const scopeId =
      (typeof session.scopeId === 'string' && session.scopeId.trim()) ||
      (typeof securityOps?.scopeId === 'string' && securityOps.scopeId.trim()) ||
      '';
    if (scopeId) {
      const gate = this.ctx.scopeVerificationGate ?? scopeVerificationGate;
      const ownership = await gate.check(scopeId);
      if (!ownership.verified) {
        const reason = ownership.reason ?? 'unverified';
        this.log.info({ sessionId, scopeId, reason }, '[sessions] Blocked message on unverified scope');
        res.status(403).json({
          accepted: false,
          code: 'scope.target_unverified',
          reason,
          message: scopeVerificationMessage(reason, 'assistant'),
        });
        return;
      }
    }

    const runId = typeof securityOps?.runId === 'string' ? securityOps.runId.trim() : '';
    const isRunWorkbenchSession = session.mode === 'automated' && runId.length > 0;
    const effectiveProfileKey = (lockedProfileKey || profileKey)?.trim() || undefined;
    const acceptedInput: Message = {
      id: uuidv4(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      metadata: {
        visibility: 'public',
        source: 'human',
        ...((effectiveProfileKey || extraContext)
          ? {
              turnExecution: {
                ...(effectiveProfileKey ? { profileKey: effectiveProfileKey } : {}),
                ...(extraContext ? { extraContext } : {}),
              },
            }
          : {}),
      },
    };

    if (isRunWorkbenchSession) {
      const phaseRouting = await this.sessionRepository.findPhaseSessionRouting?.(sessionId).catch(() => null);
      if (phaseRouting?.current && STALE_PHASE_SESSION_STATUSES.has(phaseRouting.current.status)) {
        await writeWorkbenchActionTrace({
          traceRecorder: this.services.traceRecorder,
          session,
          sessionId,
          action: 'redirect',
          operatorId: authedReq.user?.id ?? null,
          targetSessionId: phaseRouting.active?.sessionId ?? null,
          runId: phaseRouting.current.runId,
          phaseId: phaseRouting.current.id,
          phaseKey: phaseRouting.current.phaseKey,
          result: 'offered',
          extra: {
            stalePhaseStatus: phaseRouting.current.status,
          },
        });
        res.status(409).json({
          ...(await this.executionMutationResponse(sessionId)),
          ...buildStalePhaseSessionResponse(phaseRouting),
        });
        return;
      }

      const persistedRow = await this.sessionRepository.findById(sessionId).catch(() => null);
      const blockedReason =
        persistedRow?.blockedReason ??
        (await this.sessionRepository.getBlockedReason?.(sessionId).catch(() => null)) ??
        session.blockedReason ??
        null;
      const completed = persistedRow?.completed ?? false;
      const derivedState = this.responseBuilder.deriveRuntimeState({
        row: persistedRow ?? null,
        liveSession: session,
        metadata: persistedRow?.metadata ?? null,
        blockedReason,
        completed,
      });
      const executionIsActive = derivedState.status === 'running';
      const awaitingStructuredResponse = derivedState.interactionType !== 'none';

      if (executionIsActive || awaitingStructuredResponse) {
        const message = awaitingStructuredResponse
          ? 'This session is waiting for a structured response. Use the response form to continue.'
          : 'Stop the run before sending a workbench message.';

        res.status(409).json({
          accepted: false,
          ...(await this.executionMutationResponse(sessionId)),
          version: session.version ?? 0,
          message,
        });
        return;
      }

      const scheduled = await this.services.sessionStore.recordInputAndStartRequestedAsync?.(
        sessionId,
        acceptedInput,
        'workbench message accepted',
        authedReq.user?.id,
      ) ?? false;
      if (scheduled) {
        await writeWorkbenchActionTrace({
          traceRecorder: this.services.traceRecorder,
          session,
          sessionId,
          action: 'start',
          operatorId: authedReq.user?.id ?? null,
          targetSessionId: sessionId,
          runId,
          reason: 'message',
          result: 'accepted',
        });
        res.status(202).json({
          accepted: true,
          scheduled: true,
          ...(await this.executionMutationResponse(sessionId)),
        });
        return;
      }
    } else {
      const scheduled = await this.services.sessionStore.recordInputAndStartRequestedAsync?.(
        sessionId,
        acceptedInput,
        'message accepted',
        authedReq.user?.id,
      ) ?? false;
      if (scheduled) {
        res.status(202).json({
          accepted: true,
          scheduled: true,
          ...(await this.executionMutationResponse(sessionId)),
        });
        return;
      }
    }

    const ports = this.services.ports;

    this.services.orchestrator
      .processMessage(sessionId, text, effectiveProfileKey, extraContext)
      .catch((error) => {
        if (isAppError(error)) {
          ports.events.emit(sessionId, {
            type: 'error',
            data: { code: error.code, message: error.message },
          });
          return;
        }
        const code = getErrorCode(error, 'MESSAGE_PROCESSING_ERROR');
        const message = getErrorMessage(error);
        console.error(`Error processing message for session ${sessionId}:`, error);
        ports.events.emit(sessionId, {
          type: 'error',
          data: { code, message },
        });
      });

    if (isRunWorkbenchSession) {
      await writeWorkbenchActionTrace({
        traceRecorder: this.services.traceRecorder,
        session,
        sessionId,
        action: 'start',
        operatorId: authedReq.user?.id ?? null,
        targetSessionId: sessionId,
        runId,
        result: 'accepted',
      });
    }

    res.status(202).json({
      accepted: true,
      ...(await this.executionMutationResponse(sessionId)),
    });
  }

  /**
   * GET /sessions/:sessionId/summary - Get session summary
   */
  async getSummary(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const session = await this.services.sessionStore.getOrHydrate(sessionId);

    const authedReq = req as AuthenticatedRequest;
    ensureSessionExists(session, sessionId);
    ensureSessionAccess(session, authedReq);

    const sessionSummaryService = this.ctx.sessionSummaryService as {
      generateSummary(session: unknown): Promise<string | null>;
    };
    const summaryText = await sessionSummaryService.generateSummary(session);
    if (!summaryText) {
      throw ErrorFactory.resource.notFound('summary', sessionId, { context: { sessionId } });
    }
    res.status(200).json({ text: summaryText });
  }

  /**
   * GET /sessions/:sessionId/usage - Get usage stats
   */
  async getUsage(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const session = await this.services.sessionStore.getOrHydrate(sessionId);

    const authedReq = req as AuthenticatedRequest;
    ensureSessionExists(session, sessionId);
    ensureSessionAccess(session, authedReq);

    const tokenGuard = this.services.tokenGuard;
    const checkResult = tokenGuard.checkLimits(session);

    res.status(200).json({
      limits: {
        current: checkResult.currentUsage,
        limit: checkResult.limit,
        usagePct: Math.round(checkResult.usagePct),
        limitType: checkResult.limitType,
        exceeded: checkResult.exceeded,
        warning: checkResult.warning,
        message: checkResult.message,
      },
      usage: this.responseBuilder.resolveUsage(session),
    });
  }
}
