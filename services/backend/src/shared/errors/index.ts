/**
 * Centralized Error Exports
 * 
 * Single import point for all error handling utilities:
 * - assertNever: Exhaustive switch/case helper
 * - AppError: Typed application errors
 * - ApiErrors: HTTP response error utilities
 * - Contract error codes: Shared error codes from @null-ai/contracts
 * 
 * @example
 * import { assertNever, toAppError, sendApiError, ERROR_CODES } from '@/shared/errors';
 */

// Exhaustive type checking
export { assertNever, exhaustive } from './assertNever';

// HTTP API error responses
export {
  ApiErrors,
  ApiErrorBody,
  createApiError,
  configureApiError,
  sendApiError,
  apiErrorHandler,
  getStatusForCode,
  isApiError,
} from '../http/apiError';

// Typed application error + helpers
export { AppError, isAppError, hasErrorCode } from '@/domains/agent-brain/domain/errors';
export { ErrorFactory } from '@/domains/agent-brain/domain/errors';
export { ErrorSerializer } from '@/domains/agent-brain/domain/errors';
export { toAppError, getErrorStack, isRetryableError, tryCatch, tryCatchSync } from '@/domains/agent-brain/domain/errors';

// Contract-defined error codes (shared with the frontend through @null-ai/contracts)
export {
  ERROR_CODES,
  ERROR_CATEGORIES,
  ERROR_METADATA,
  ErrorCategory,
  ErrorCodeKey,
  ErrorCodeValue,
  ErrorMetadata,
  getErrorMetadata,
  isRetryableCode,
  getHttpStatus,
  getUserMessage,
  getErrorCategory,
} from '@null-ai/contracts';

/**
 * Convert unknown caught error to a typed error object.
 * Safe to use in catch blocks: `catch (error: unknown) { const e = toSafeError(error); }`
 */
export function toSafeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(`Unknown error: ${JSON.stringify(error)}`);
}

const MAX_LOG_ERROR_MESSAGE_CHARS = 2_000;
const MAX_LOG_ERROR_STACK_CHARS = 6_000;
const NULL_CHAR = String.fromCharCode(0);

const redactVerboseErrorText = (value: string): string =>
  value
    .replace(/(\n\s*params:\s*)[\s\S]*/i, '$1[redacted]')
    .replace(/(\n\s*parameters:\s*)[\s\S]*/i, '$1[redacted]');

const truncateLogText = (value: string, maxChars: number): string => {
  const redacted = redactVerboseErrorText(value).split(NULL_CHAR).join('');
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${redacted.slice(0, maxChars).trimEnd()}...[truncated for log safety]`;
};

/**
 * Convert an unknown error into an Error safe for structured logs.
 * Some database drivers include full SQL parameter payloads in message/stack
 * strings; those params can contain session metadata and scanner output.
 */
export function toLogSafeError(error: unknown): Error {
  const source = toSafeError(error);
  const safe = new Error(truncateLogText(source.message, MAX_LOG_ERROR_MESSAGE_CHARS));
  safe.name = source.name;
  safe.stack = source.stack
    ? truncateLogText(source.stack, MAX_LOG_ERROR_STACK_CHARS)
    : undefined;

  const sourceRecord = source as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
  };
  const safeRecord = safe as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
  };
  if (sourceRecord.code !== undefined) safeRecord.code = sourceRecord.code;
  if (sourceRecord.errno !== undefined) safeRecord.errno = sourceRecord.errno;
  if (sourceRecord.syscall !== undefined) safeRecord.syscall = sourceRecord.syscall;
  return safe;
}

/**
 * Extract error message safely from unknown error.
 */
export function getErrorMessage(error: unknown): string {
  return toSafeError(error).message;
}
