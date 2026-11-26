import { ZodError, type ZodTypeAny } from 'zod';
import type { RequestHandler } from 'express';
import { AppError } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';

type Schema = ZodTypeAny | undefined;

export const validate = ({
  body,
  params,
  query,
}: {
  body?: Schema;
  params?: Schema;
  query?: Schema;
}): RequestHandler => {
  return (req, _res, next) => {
    try {
      if (params) req.params = params.parse(req.params);
      if (query) req.query = query.parse(req.query);
      if (body) req.body = body.parse(req.body);
      next();
    } catch (error) {
      const zodError = error instanceof ZodError ? error : null;
      const context = zodError ? { issues: zodError.flatten() } : { error: String(error) };
      next(
        new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Validation failed', {
          cause: error instanceof Error ? error : undefined,
          context,
          httpStatus: 400,
        }),
      );
    }
  };
};

