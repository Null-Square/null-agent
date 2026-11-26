import { Router } from 'express';
import { sendApiError, ERROR_CODES } from '@/shared/errors';

export function createRunnerAgentRouter(): Router {
  const router = Router();

  // WebSocket upgrades are handled at the HTTP server layer. This HTTP handler
  // exists to provide a clear response for non-upgrade requests.
  router.get('/connect', (_req, res) => {
    sendApiError(res, {
      code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
      message: 'WebSocket upgrade required',
      status: 426,
    });
  });

  return router;
}
