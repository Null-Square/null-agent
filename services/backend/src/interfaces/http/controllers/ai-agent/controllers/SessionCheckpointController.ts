/**
 * SessionCheckpointController - Handle session checkpoint operations
 * 
 * Routes:
 * - GET /sessions/:sessionId/checkpoints - List checkpoints
 * - POST /sessions/:sessionId/checkpoints - Create checkpoint
 * - POST /sessions/:sessionId/checkpoints/:checkpointId/restore - Restore checkpoint
 */

import { type Request, type Response } from 'express';
import {
  BaseSessionController,
  type SessionControllerContext,
  type AuthenticatedRequest,
} from './types';
import { ensureSessionAccess, ensureSessionExists } from '../routes/helpers/sessionAccess';
import { ErrorFactory, toAppError, getErrorMessage } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';

export class SessionCheckpointController extends BaseSessionController {
  constructor(context: SessionControllerContext) {
    super(context);
  }

  /**
   * GET /sessions/:sessionId/checkpoints - List checkpoints
   */
  async listCheckpoints(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const session = await this.services.sessionStore.getOrHydrate(sessionId);

    const authedReq = req as AuthenticatedRequest;
    ensureSessionExists(session, sessionId);
    ensureSessionAccess(session, authedReq);

    const checkpoints = await this.services.checkpointManager.list(sessionId);
    res.status(200).json({ checkpoints });
  }

  /**
   * POST /sessions/:sessionId/checkpoints - Create checkpoint
   */
  async createCheckpoint(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    try {
      const session = await this.services.sessionStore.getOrHydrate(sessionId);
      ensureSessionExists(session, sessionId);
      const authedReq = req as AuthenticatedRequest;
      ensureSessionAccess(session, authedReq);

      const checkpoint = await this.services.checkpointManager.create(sessionId);
      res.status(201).json({ checkpoint });
    } catch (error) {
      const appErr = toAppError(error);
      console.error(`Error creating checkpoint for session ${sessionId}:`, appErr);
      if (appErr.code !== ERROR_CODES.INTERNAL_UNEXPECTED) {
        throw appErr;
      }
      const message = getErrorMessage(error) || 'Failed to create checkpoint';
      if (message.includes('Session') && message.includes('not found')) {
        throw ErrorFactory.session.notFound(sessionId);
      }
      throw ErrorFactory.internal.unexpected(message, { context: { sessionId } });
    }
  }

  /**
   * POST /sessions/:sessionId/checkpoints/:checkpointId/restore - Restore checkpoint
   */
  async restoreCheckpoint(req: Request, res: Response): Promise<void> {
    const { sessionId, checkpointId } = req.params;
    try {
      const session = await this.services.sessionStore.getOrHydrate(sessionId);
      ensureSessionExists(session, sessionId);
      const authedReq = req as AuthenticatedRequest;
      ensureSessionAccess(session, authedReq);

      const checkpoint = await this.services.checkpointManager.restore(sessionId, checkpointId);
      res.status(200).json({ checkpoint });
    } catch (error) {
      const appErr = toAppError(error);
      console.error(`Error restoring checkpoint ${checkpointId} for session ${sessionId}:`, appErr);
      if (appErr.code !== ERROR_CODES.INTERNAL_UNEXPECTED) {
        throw appErr;
      }
      const message = getErrorMessage(error) || 'Failed to restore checkpoint';
      const normalized = message.toLowerCase();
      if (normalized.includes('session') && normalized.includes('not found')) {
        throw ErrorFactory.session.notFound(sessionId);
      }
      if (normalized.includes('checkpoint') && normalized.includes('not found')) {
        throw ErrorFactory.resource.notFound('checkpoint', checkpointId, { context: { sessionId } });
      }
      throw ErrorFactory.internal.unexpected(message, { context: { sessionId, checkpointId } });
    }
  }
}
