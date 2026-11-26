/**
 * API Error Handling
 *
 * Typed error utilities consolidated from @null-ai/contracts.
 * This file provides backward-compatible re-exports and legacy type aliases.
 */

import {
  ClientApiError,
  isClientApiError,
  parseClientApiError,
  type ErrorCodeValue,
  type SerializedApiError,
  ERROR_CODES,
} from '@null-ai/contracts';

// ============================================================================
// Re-exports from Contracts (Primary API)
// ============================================================================

export { ClientApiError as ApiError };
export { isClientApiError as isApiError };

export type { ErrorCodeValue, SerializedApiError };

// ============================================================================
// Legacy Type Aliases (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use ErrorCodeValue from @null-ai/contracts instead.
 * Legacy error codes mapped to new contract codes.
 */
export type ApiErrorCode =
  | ErrorCodeValue
  | 'insufficient_credits'
  | 'credits_exhausted'
  | 'feature_not_available'
  | 'session_limit_reached'
  | 'session_not_found'
  | 'session_invalid_state'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'validation_error'
  | 'not_found'
  | 'internal_error'
  | 'task.restricted'
  | 'limit.schedules_exceeded'
  | 'unknown';

/**
 * @deprecated Use SerializedApiError from @null-ai/contracts instead.
 */
export interface ApiErrorResponse {
  error?: string;
  message?: string;
  code?: ApiErrorCode;
  details?: Record<string, unknown>;
}

// ============================================================================
// Additional Utilities
// ============================================================================

type ResponseErrorShape = {
  response?: { status?: number; data?: unknown };
  status?: number;
  message?: string;
};

const LEGACY_CODE_MAP: Record<string, ErrorCodeValue> = {
  // Legacy frontend codes
  feature_not_available: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
  task_restricted: ERROR_CODES.GATING_TASK_RESTRICTED,
  'limit.schedules_exceeded': ERROR_CODES.GATING_SCHEDULES_EXCEEDED,
  insufficient_credits: ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED,
  credits_exhausted: ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED,
  session_limit_reached: ERROR_CODES.RESOURCE_LIMIT_REACHED,
  rate_limited: ERROR_CODES.AUTH_RATE_LIMITED_USER,
  validation_error: ERROR_CODES.VALIDATION_INVALID_FORMAT,
  not_found: ERROR_CODES.RESOURCE_NOT_FOUND,
  unauthorized: ERROR_CODES.AUTH_INVALID_SESSION,
  forbidden: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
  internal_error: ERROR_CODES.INTERNAL_UNEXPECTED,
  unknown: ERROR_CODES.INTERNAL_UNEXPECTED,
  // Backend API error codes
  'auth.unauthorized': ERROR_CODES.AUTH_INVALID_SESSION,
  'auth.forbidden': ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
  'auth.missing_token': ERROR_CODES.AUTH_INVALID_SESSION,
  'auth.invalid_token': ERROR_CODES.AUTH_INVALID_TOKEN,
  invalid_credentials: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
  email_not_verified: ERROR_CODES.AUTH_EMAIL_NOT_VERIFIED,
  email_already_registered: ERROR_CODES.AUTH_EMAIL_ALREADY_REGISTERED,
  account_disabled: ERROR_CODES.AUTH_ACCOUNT_DISABLED,
  early_access_restricted: ERROR_CODES.AUTH_EARLY_ACCESS_RESTRICTED,
  reset_password_failed: ERROR_CODES.AUTH_RESET_PASSWORD_FAILED,
  verify_email_failed: ERROR_CODES.AUTH_VERIFY_EMAIL_FAILED,
  send_verification_failed: ERROR_CODES.AUTH_SEND_VERIFICATION_FAILED,
  'feature.not_available': ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
  'task.restricted': ERROR_CODES.GATING_TASK_RESTRICTED,
  'rate.limited': ERROR_CODES.AUTH_RATE_LIMITED_USER,
  'credits.exhausted': ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED,
  'credits.insufficient': ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED,
  'validation.failed': ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
  'validation.invalid_format': ERROR_CODES.VALIDATION_INVALID_FORMAT,
  'server.internal': ERROR_CODES.INTERNAL_UNEXPECTED,
  'server.unavailable': ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
  'server.timeout': ERROR_CODES.NETWORK_TIMEOUT,
};

function normalizeErrorCode(code?: string): ErrorCodeValue | undefined {
  if (!code) return undefined;
  const values = Object.values(ERROR_CODES) as ErrorCodeValue[];
  if (values.includes(code as ErrorCodeValue)) {
    return code as ErrorCodeValue;
  }
  return LEGACY_CODE_MAP[code];
}

function normalizeErrorData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...record };

  const errorValue = record.error;
  if (errorValue && typeof errorValue === 'object') {
    const errorObj = errorValue as Record<string, unknown>;
    const message = typeof errorObj.message === 'string' ? errorObj.message : undefined;
    const code = typeof errorObj.code === 'string' ? errorObj.code : undefined;
    const status = typeof errorObj.status === 'number' ? errorObj.status : undefined;
    const details = typeof errorObj.details === 'object' ? errorObj.details : undefined;

    if (message && typeof normalized.message !== 'string') {
      normalized.message = message;
    }
    if (message) {
      normalized.error = message;
    }
    if (status && typeof normalized.status !== 'number') {
      normalized.status = status;
    }
    if (details && typeof normalized.details !== 'object') {
      normalized.details = details;
    }
    const mapped = normalizeErrorCode(code);
    if (mapped) {
      normalized.code = mapped;
    } else if (code && typeof normalized.code !== 'string') {
      normalized.code = code;
    }
  }

  if (typeof record.code === 'string') {
    const mapped = normalizeErrorCode(record.code);
    if (mapped) {
      normalized.code = mapped;
    }
  }

  return normalized;
}

export function parseApiError(error: unknown): ClientApiError {
  if (isClientApiError(error)) {
    return error;
  }

  if (typeof error === 'object' && error !== null && ('response' in error || 'status' in error)) {
    const resError = error as ResponseErrorShape;
    const status = resError.response?.status ?? resError.status;
    const normalized = normalizeErrorData(resError.response?.data) ?? (resError.message ? { message: resError.message } : undefined);
    if (typeof status === 'number') {
      return parseClientApiError({ response: { status, data: normalized } });
    }
  }

  return parseClientApiError(error);
}

export const toApiError = parseApiError;

/**
 * Check if error should trigger retry.
 */
export function shouldRetry(error: unknown): boolean {
  const apiError = parseApiError(error);
  // Rate limits are excluded on purpose: retrying a 429 spends the next
  // window's budget and keeps the caller limited for longer. See
  // RETRY_STATUSES in api/client.ts for the matching decision at the
  // fetch layer.
  return apiError.status >= 500;
}

/**
 * Safely extract error message from any error type.
 */
export function getErrorMessage(error: unknown): string {
  if (isClientApiError(error)) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

/**
 * Safely extract error stack from any error type.
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/**
 * Legacy ERROR_CODES re-export for convenience.
 */
export { ERROR_CODES };
