import { ERROR_CODES } from '@null-ai/contracts';
import { AppError, type ErrorContext, isAppError } from './AppError';
import { ErrorFactory } from './ErrorFactory';
import { CircuitOpenError } from '../../application/services/CircuitBreaker';

export type TurnErrorContext = ErrorContext & {
  provider?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getName = (error: unknown): string => {
  if (error instanceof Error && error.name) return error.name;
  if (isRecord(error) && typeof error['name'] === 'string') return error['name'] as string;
  if (isRecord(error) && typeof error['type'] === 'string') return error['type'] as string;
  return '';
};

const getMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'] as string;
  return String(error ?? 'Unknown error');
};

const extractProviderFromCircuit = (circuitName: string): string => {
  if (circuitName.includes(':')) {
    const parts = circuitName.split(':');
    return parts[1] ?? circuitName;
  }
  return circuitName;
};

export function classifyTurnError(error: unknown, context: TurnErrorContext = {}): AppError {
  if (isAppError(error)) {
    if (Object.keys(context).length === 0) {
      return error;
    }
    return new AppError(error.code, error.message, {
      retryAfterMs: error.retryAfterMs,
      context: { ...(error.context ?? {}), ...context },
      cause: error.cause,
      userMessage: error.userMessage,
      httpStatus: error.httpStatus,
    });
  }

  if (error instanceof CircuitOpenError) {
    const provider = context.provider ?? extractProviderFromCircuit(error.circuitName);
    return ErrorFactory.llm.providerUnavailable(provider, {
      retryAfterMs: error.retryAfterMs,
      context: { ...context, circuit: error.circuitName },
      cause: error,
    });
  }

  const message = getMessage(error);
  const cause = error instanceof Error ? error : undefined;
  const baseContext = {
    ...context,
    errorName: getName(error) || undefined,
  };

  return new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, message, { context: baseContext, cause });
}
