/**
 * Typed Error Handling Utilities
 * 
 * Provides helper functions for consistent, type-safe error handling
 * throughout the codebase. Eliminates the need for `catch (error: any)`.
 * 
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   throw toAppError(error, ErrorCode.INTERNAL_UNEXPECTED, { sessionId });
 * }
 * ```
 */

import { AppError, isAppError } from './AppError';
import { ERROR_CODES, type ErrorCodeValue } from '@null-ai/contracts';

type HttpErrorLike = {
  code: string;
  status: number;
  message?: string;
  detail?: unknown;
  details?: unknown;
  extras?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isHttpErrorLike = (error: unknown): error is HttpErrorLike => {
  if (!isRecord(error)) return false;
  return typeof error.code === 'string' && typeof error.status === 'number';
};

const resolveErrorCode = (code: string, fallbackCode: ErrorCodeValue): ErrorCodeValue => {
  const values = Object.values(ERROR_CODES) as string[];
  return values.includes(code) ? (code as ErrorCodeValue) : fallbackCode;
};

const buildHttpErrorContext = (
  error: HttpErrorLike,
  context?: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const merged: Record<string, unknown> = { ...(context ?? {}) };
  if (error.detail !== undefined) merged.detail = error.detail;
  if (error.details !== undefined) merged.details = error.details;
  if (error.extras && Object.keys(error.extras).length > 0) {
    merged.extras = error.extras;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

/**
 * Convert any caught error to an AppError with consistent handling.
 * 
 * This is the recommended way to handle errors in catch blocks:
 * - Preserves existing AppErrors
 * - Wraps native Errors with proper codes
 * - Handles unknown error types gracefully
 * 
 * @param error - The caught error (unknown type from catch block)
 * @param fallbackCode - Error code to use if not already an AppError
 * @param context - Additional context to merge into the error
 */
export function toAppError(
  error: unknown,
  fallbackCode: ErrorCodeValue = ERROR_CODES.INTERNAL_UNEXPECTED,
  context?: Record<string, unknown>,
): AppError {
  if (isAppError(error)) {
    // If context provided, wrap with additional context
    if (context) {
      return AppError.wrap(error, error.message, { context });
    }
    return error;
  }

  if (isHttpErrorLike(error)) {
    const code = resolveErrorCode(error.code, fallbackCode);
    return new AppError(code, error.message ?? error.code, {
      httpStatus: error.status,
      context: buildHttpErrorContext(error, context),
      cause: error instanceof Error ? error : undefined,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new AppError(fallbackCode, message, {
    cause: error instanceof Error ? error : undefined,
    context,
  });
}

/**
 * Get error message from any error type safely.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

/**
 * Get error stack from any error type safely.
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/**
 * Check if error is retryable based on AppError metadata.
 */
export function isRetryableError(error: unknown): boolean {
  if (isAppError(error)) {
    return error.retryable;
  }
  // Network errors are typically retryable
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('network')
    );
  }
  return false;
}

/**
 * Run an async function with typed error handling.
 * Returns [result, null] on success, [null, AppError] on failure.
 * 
 * @example
 * ```typescript
 * const [result, error] = await tryCatch(() => riskyOperation());
 * if (error) {
 *   logger.error({ err: error }, 'Operation failed');
 *   return null;
 * }
 * return result;
 * ```
 */
export async function tryCatch<T>(
  fn: () => Promise<T>,
  fallbackCode: ErrorCodeValue = ERROR_CODES.INTERNAL_UNEXPECTED,
): Promise<[T, null] | [null, AppError]> {
  try {
    const result = await fn();
    return [result, null];
  } catch (error) {
    return [null, toAppError(error, fallbackCode)];
  }
}

/**
 * Synchronous version of tryCatch.
 */
export function tryCatchSync<T>(
  fn: () => T,
  fallbackCode: ErrorCodeValue = ERROR_CODES.INTERNAL_UNEXPECTED,
): [T, null] | [null, AppError] {
  try {
    const result = fn();
    return [result, null];
  } catch (error) {
    return [null, toAppError(error, fallbackCode)];
  }
}
