import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import type { RunnerAuthContext, RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { logger } from '@/shared/logger';

export type RunnerRequest = Request & {
  runnerAuth?: RunnerAuthContext;
};

const parseBearerToken = (headerValue: string | undefined): string | null => {
  if (!headerValue) return null;
  const parts = headerValue.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return null;
  }
  const token = parts[1];
  if (!token || token.length === 0) {
    return null;
  }
  return token;
};

export function createRunnerTokenAuth(runnerService: RunnerService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = parseBearerToken(req.get('authorization'));
    if (!token) {
      sendApiError(res, {
        code: ERROR_CODES.AUTH_INVALID_API_KEY,
        message: 'Runner bearer token is required',
      });
      return;
    }

    try {
      const auth = await runnerService.authenticateToken(token);
      (req as RunnerRequest).runnerAuth = auth;
      next();
    } catch (error) {
      const err = toAppError(error);
      logger.warn({ err }, '[runner-agent] Runner token auth failed');
      sendApiError(res, {
        code: err.httpStatus >= 400 && err.httpStatus < 500 ? err.code : ERROR_CODES.AUTH_INVALID_API_KEY,
        message: err.httpStatus >= 400 && err.httpStatus < 500 ? err.message : 'Invalid runner token',
        status: err.httpStatus >= 400 && err.httpStatus < 500 ? err.httpStatus : undefined,
      });
    }
  };
}
