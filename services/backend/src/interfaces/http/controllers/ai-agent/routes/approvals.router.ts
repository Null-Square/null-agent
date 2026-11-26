import { Router } from 'express';
import { asyncHandler, validate } from '../middleware';
import {
  approvalsParamsSchema,
  approvalDecisionBodySchema,
} from '../schemas';
import type { AgentApiServices } from '../types';
import type { AuthenticatedRequest } from '@/shared/middleware/auth.middleware';
import { ensureSessionAccess, ensureSessionExists } from './helpers/sessionAccess';
import { ErrorFactory } from '@/shared/errors';
import type { ApprovalRequestDTO } from '@/shared/types/dtos';

type IdempotencyRecord = { actionId: string; decision: 'granted' | 'denied'; reason?: string; status: number };
const approvalIdempotencyCache = new Map<string, IdempotencyRecord>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

const makeIdemKey = (sessionId: string, actionId: string, key?: string | null) =>
  key ? `${sessionId}:${actionId}:${key}` : undefined;

const getIdempotentDecision = (sessionId: string, actionId: string, key?: string | null) => {
  const idemKey = makeIdemKey(sessionId, actionId, key);
  if (!idemKey) return undefined;
  const record = approvalIdempotencyCache.get(idemKey);
  if (!record) return undefined;
  return record;
};

const storeIdempotentDecision = (sessionId: string, record: IdempotencyRecord, key?: string | null) => {
  const idemKey = makeIdemKey(sessionId, record.actionId, key);
  if (!idemKey) return;
  approvalIdempotencyCache.set(idemKey, record);
  setTimeout(() => {
    approvalIdempotencyCache.delete(idemKey);
  }, IDEMPOTENCY_TTL_MS).unref?.();
};

export const approvalsRouter = (services: AgentApiServices): Router => {
  const router = Router();

  router.get(
    '/sessions/:id/approvals',
    validate({ params: approvalsParamsSchema }),
    asyncHandler(async (req, res) => {
      const { id: sessionId } = req.params;
      const session = services.sessionStore.get(sessionId);

      ensureSessionExists(session, sessionId);

      const authedReq = req as AuthenticatedRequest;
      ensureSessionAccess(session, authedReq);

      const pending = session.pendingApproval as ApprovalRequestDTO | undefined;
      res.status(200).json({ approval: pending ?? null });
    }),
  );

  router.post(
    '/sessions/:id/approve',
    validate({ params: approvalsParamsSchema, body: approvalDecisionBodySchema }),
    asyncHandler(async (req, res) => {
      const { id: sessionId } = req.params;
      const { actionId } = req.body as { actionId: string; reason?: string };
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const cached = getIdempotentDecision(sessionId, actionId, idempotencyKey);
      if (cached && cached.decision === 'granted') {
        return res.status(cached.status).json({ actionId });
      }

      const session = services.sessionStore.get(sessionId);
      ensureSessionExists(session, sessionId);

      const authedReq = req as AuthenticatedRequest;
      ensureSessionAccess(session, authedReq);

      const pendingApproval = session.pendingApproval as ApprovalRequestDTO | undefined;
      const result = await services.ports.tools.handleApprovalDecision(sessionId, actionId, 'granted');

      if (!result.handled) {
        throw ErrorFactory.resource.notFound('approval', actionId, { context: { sessionId, actionId } });
      }

      services.ports.events.emit(sessionId, {
        type: 'approval_granted',
        data: { actionId },
      });

      const journalOwnsContinuation = Boolean(
        result.needsResume
        && await services.sessionStore.getJournalProjection?.(sessionId),
      );

      // Journal-backed hosts have already recorded the grant and scheduled the
      // due continuation in one commit. Only embedded/journal-less hosts retain
      // the direct compatibility path below.
      if (result.needsResume && services.orchestrator && !journalOwnsContinuation) {
        const orchestratorWithResume = services.orchestrator as typeof services.orchestrator & {
          handleApprovalResume?: (sessionId: string, data: {
            actionId: string;
            toolCallId: string;
            modelRequestId?: string;
            toolName: string;
            args?: Record<string, unknown>;
          }) => Promise<void>;
        };

        if (pendingApproval?.toolCallId && pendingApproval?.tool && orchestratorWithResume.handleApprovalResume) {
          orchestratorWithResume.handleApprovalResume(sessionId, {
            actionId,
            toolCallId: pendingApproval.toolCallId,
            modelRequestId: pendingApproval.modelRequestId,
            toolName: pendingApproval.tool,
            args: pendingApproval.args,
          }).catch((err: unknown) => {
            console.error(`[Approval] Failed to resume session ${sessionId} via handleApprovalResume:`, err);
          });
        } else {
          services.orchestrator.processMessage(sessionId, 'continue').catch((err) => {
            console.error(`[Approval] Failed to resume session ${sessionId} after restart:`, err);
          });
        }
      }

      storeIdempotentDecision(
        sessionId,
        { actionId, decision: 'granted', status: 200 },
        idempotencyKey,
      );
      res.status(200).json({
        actionId,
        resumed: result.needsResume,
        ...(journalOwnsContinuation ? { scheduled: true } : {}),
      });
    }),
  );

  router.post(
    '/sessions/:id/deny',
    validate({ params: approvalsParamsSchema, body: approvalDecisionBodySchema }),
    asyncHandler(async (req, res) => {
      const { id: sessionId } = req.params;
      const { actionId, reason } = req.body as { actionId: string; reason?: string };
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const cached = getIdempotentDecision(sessionId, actionId, idempotencyKey);
      if (cached && cached.decision === 'denied') {
        return res.status(cached.status).json({ actionId });
      }

      const session = services.sessionStore.get(sessionId);
      ensureSessionExists(session, sessionId);

      const authedReq = req as AuthenticatedRequest;
      ensureSessionAccess(session, authedReq);

      const result = await services.ports.tools.handleApprovalDecision(sessionId, actionId, 'denied', reason);

      if (!result.handled) {
        throw ErrorFactory.resource.notFound('approval', actionId, { context: { sessionId, actionId } });
      }

      services.ports.events.emit(sessionId, {
        type: 'approval_denied',
        data: { actionId, reason },
      });

      storeIdempotentDecision(
        sessionId,
        { actionId, decision: 'denied', reason, status: 200 },
        idempotencyKey,
      );
      res.status(200).json({ actionId });
    }),
  );

  return router;
};
