import type { ErrorRequestHandler } from 'express';
import { logger } from '@/shared/logger';
import { isAppError, ErrorSerializer } from '@/shared/errors';

/**
 * Express error handler using the new error classification system.
 * 
 * Features:
 * - Uses AppError for typed errors
 * - Consistent JSON response format
 * - Request ID tracking (x-request-id)
 * - User-safe messages in production
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const headers = (_req?.headers ?? {}) as Record<string, unknown>;
  const requestId =
    _req?.requestId ??
    _req?.id ??
    (typeof headers['x-request-id'] === 'string' ? headers['x-request-id'] : undefined);
  const response = ErrorSerializer.serialize(err, requestId, { isDev: _req?.app?.locals?.isDev ?? false });
  const status = response.httpStatus;

  // Log server errors
  if (status >= 500) {
    logger.error(
      {
        err,
        requestId,
        code: isAppError(err) ? err.code : 'unknown',
      },
      'AgentRouter error'
    );
  }

  // Serialize error based on environment
  // Add retry-after header for rate limits
  if (status === 429 && response.retryAfterMs) {
    res.setHeader('Retry-After', Math.ceil(response.retryAfterMs / 1000).toString());
  }

  res.status(status).json(response);
};

