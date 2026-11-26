/**
 * Error Code Types
 * 
 * Single source of truth for error codes used by the backend and the frontend.
 * Following OpenAI, Stripe, and Google Cloud patterns.
 * Format: DOMAIN.CATEGORY[.SPECIFIC]
 */

import { z } from 'zod';

// =============================================================================
// Error Categories
// =============================================================================

export const ERROR_CATEGORIES = [
  'auth',       // Authentication & Authorization
  'llm',        // LLM Provider Errors
  'session',    // Session Management
  'tool',       // Tool Execution
  'validation', // Input Validation
  'resource',   // Resource Management
  'gating',     // Feature Gating & Plan Restrictions
  'network',    // Network/Connection
  'platform',   // Platform/Operations
  'internal',   // Internal Errors
] as const;

export const errorCategorySchema = z.enum(ERROR_CATEGORIES);
export type ErrorCategory = z.infer<typeof errorCategorySchema>;

// =============================================================================
// Error Codes
// =============================================================================

export const ERROR_CODES = {
  // Authentication & Authorization
  AUTH_INVALID_API_KEY: 'auth.invalid_api_key',
  AUTH_EXPIRED_TOKEN: 'auth.expired_token',
  AUTH_INSUFFICIENT_PERMISSIONS: 'auth.insufficient_permissions',
  AUTH_RATE_LIMITED_USER: 'auth.rate_limited_user',
  AUTH_INVALID_SESSION: 'auth.invalid_session',
  AUTH_INVALID_TOKEN: 'auth.invalid_token',
  AUTH_INVALID_CREDENTIALS: 'auth.invalid_credentials',
  AUTH_EMAIL_ALREADY_REGISTERED: 'auth.email_already_registered',
  AUTH_ACCOUNT_DISABLED: 'auth.account_disabled',
  AUTH_EMAIL_NOT_VERIFIED: 'auth.email_not_verified',
  AUTH_USER_NOT_FOUND: 'auth.user_not_found',
  AUTH_SIGNUP_FAILED: 'auth.signup_failed',
  AUTH_SIGNIN_FAILED: 'auth.signin_failed',
  AUTH_EARLY_ACCESS_RESTRICTED: 'auth.early_access_restricted',
  AUTH_RESET_PASSWORD_FAILED: 'auth.reset_password_failed',
  AUTH_VERIFY_EMAIL_FAILED: 'auth.verify_email_failed',
  AUTH_SEND_VERIFICATION_FAILED: 'auth.send_verification_failed',

  // LLM Provider Errors
  LLM_PROVIDER_UNAVAILABLE: 'llm.provider_unavailable',
  LLM_RATE_LIMIT_EXCEEDED: 'llm.rate_limit_exceeded',
  LLM_CONTEXT_LENGTH_EXCEEDED: 'llm.context_length_exceeded',
  LLM_CONTENT_FILTER_TRIGGERED: 'llm.content_filter_triggered',
  LLM_INVALID_MODEL: 'llm.invalid_model',
  LLM_TIMEOUT: 'llm.timeout',
  LLM_RESPONSE_PARSE_ERROR: 'llm.response_parse_error',

  // Session Management
  SESSION_NOT_FOUND: 'session.not_found',
  SESSION_VERSION_CONFLICT: 'session.version_conflict',
  SESSION_EXPIRED: 'session.expired',
  SESSION_TERMINATED: 'session.terminated',
  SESSION_INVALID_STATE: 'session.invalid_state',
  SESSION_LOCKED: 'session.locked',

  // Tool Execution
  TOOL_EXECUTION_FAILED: 'tool.execution_failed',
  TOOL_TIMEOUT: 'tool.timeout',
  TOOL_APPROVAL_DENIED: 'tool.approval_denied',
  TOOL_APPROVAL_PENDING: 'tool.approval_pending',
  TOOL_SANDBOX_ERROR: 'tool.sandbox_error',
  TOOL_INVALID_ARGUMENTS: 'tool.invalid_arguments',
  TOOL_NOT_FOUND: 'tool.not_found',

  // Input Validation
  VALIDATION_MISSING_REQUIRED: 'validation.missing_required',
  VALIDATION_INVALID_FORMAT: 'validation.invalid_format',
  VALIDATION_OUT_OF_RANGE: 'validation.out_of_range',
  VALIDATION_CONSTRAINT_VIOLATED: 'validation.constraint_violated',
  VALIDATION_INVALID_JSON: 'validation.invalid_json',

  // Scope Authorization
  SCOPE_TARGET_UNVERIFIED: 'scope.target_unverified',

  // Resource Management
  RESOURCE_NOT_FOUND: 'resource.not_found',
  RESOURCE_QUOTA_EXCEEDED: 'resource.quota_exceeded',
  RESOURCE_CREDITS_EXHAUSTED: 'resource.credits_exhausted',
  RESOURCE_LIMIT_REACHED: 'resource.limit_reached',

  // Network/Connection
  NETWORK_CONNECTION_FAILED: 'network.connection_failed',
  NETWORK_TIMEOUT: 'network.timeout',
  NETWORK_DNS_ERROR: 'network.dns_error',
  NETWORK_SSL_ERROR: 'network.ssl_error',

  // Feature Gating & Plan Restrictions
  GATING_FEATURE_NOT_AVAILABLE: 'gating.feature_not_available',
  GATING_MODEL_NOT_ALLOWED: 'gating.model_not_allowed',
  GATING_TASK_RESTRICTED: 'gating.task_restricted',
  GATING_SCHEDULES_EXCEEDED: 'gating.schedules_exceeded',

  // Platform/Operations
  PLATFORM_UNDER_MAINTENANCE: 'platform.under_maintenance',

  // Internal Errors
  INTERNAL_UNEXPECTED: 'internal.unexpected',
  INTERNAL_CONFIGURATION: 'internal.configuration',
  INTERNAL_DEPENDENCY_FAILED: 'internal.dependency_failed',
} as const;

export type ErrorCodeKey = keyof typeof ERROR_CODES;
export type ErrorCodeValue = typeof ERROR_CODES[ErrorCodeKey];

// =============================================================================
// Error Metadata
// =============================================================================

export interface ErrorMetadata {
  httpStatus: number;
  retryable: boolean;
  userMessage: string;
}

/**
 * Registry mapping error codes to their metadata.
 * Used for consistent error handling across services.
 */
export const ERROR_METADATA: Record<ErrorCodeValue, ErrorMetadata> = {
  // Auth errors - 401/403/429
  [ERROR_CODES.AUTH_INVALID_API_KEY]: {
    httpStatus: 401,
    retryable: false,
    userMessage: 'Invalid API key. Please check your credentials.',
  },
  [ERROR_CODES.AUTH_EXPIRED_TOKEN]: {
    httpStatus: 401,
    retryable: false,
    userMessage: 'Your session has expired. Please log in again.',
  },
  [ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'You do not have permission to perform this action.',
  },
  [ERROR_CODES.AUTH_RATE_LIMITED_USER]: {
    httpStatus: 429,
    retryable: true,
    userMessage: 'Too many requests. Please slow down.',
  },
  [ERROR_CODES.AUTH_INVALID_SESSION]: {
    httpStatus: 401,
    retryable: false,
    userMessage: 'Invalid session. Please log in again.',
  },
  [ERROR_CODES.AUTH_INVALID_TOKEN]: {
    httpStatus: 401,
    retryable: false,
    userMessage: 'Invalid or expired token. Please log in again.',
  },
  [ERROR_CODES.AUTH_INVALID_CREDENTIALS]: {
    httpStatus: 401,
    retryable: false,
    userMessage: 'Invalid email or password.',
  },
  [ERROR_CODES.AUTH_EMAIL_ALREADY_REGISTERED]: {
    httpStatus: 409,
    retryable: false,
    userMessage: 'Email already registered. Please sign in instead.',
  },
  [ERROR_CODES.AUTH_ACCOUNT_DISABLED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'Account disabled. Contact support.',
  },
  [ERROR_CODES.AUTH_EMAIL_NOT_VERIFIED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'Please verify your email before signing in.',
  },
  [ERROR_CODES.AUTH_USER_NOT_FOUND]: {
    httpStatus: 404,
    retryable: false,
    userMessage: 'User not found.',
  },
  [ERROR_CODES.AUTH_SIGNUP_FAILED]: {
    httpStatus: 500,
    retryable: true,
    userMessage: 'Unable to sign up right now. Please try again later.',
  },
  [ERROR_CODES.AUTH_SIGNIN_FAILED]: {
    httpStatus: 500,
    retryable: true,
    userMessage: 'Unable to sign in right now. Please try again later.',
  },
  [ERROR_CODES.AUTH_EARLY_ACCESS_RESTRICTED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'Registration is invite-only during early access.',
  },
  [ERROR_CODES.AUTH_RESET_PASSWORD_FAILED]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Unable to reset password. Please check your link and try again.',
  },
  [ERROR_CODES.AUTH_VERIFY_EMAIL_FAILED]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Unable to verify email. Please check your link and try again.',
  },
  [ERROR_CODES.AUTH_SEND_VERIFICATION_FAILED]: {
    httpStatus: 503,
    retryable: true,
    userMessage: 'Unable to send verification email. Please try again shortly.',
  },

  // LLM errors - 400/429/503/504
  [ERROR_CODES.LLM_PROVIDER_UNAVAILABLE]: {
    httpStatus: 503,
    retryable: true,
    userMessage: 'AI service is temporarily unavailable. Please try again.',
  },
  [ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED]: {
    httpStatus: 429,
    retryable: true,
    userMessage: 'AI service rate limit exceeded. Please wait a moment.',
  },
  [ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Message too long for the AI model.',
  },
  [ERROR_CODES.LLM_CONTENT_FILTER_TRIGGERED]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Your message was flagged by the content filter.',
  },
  [ERROR_CODES.LLM_INVALID_MODEL]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Invalid AI model specified.',
  },
  [ERROR_CODES.LLM_TIMEOUT]: {
    httpStatus: 504,
    retryable: true,
    userMessage: 'AI request timed out. Please try again.',
  },
  [ERROR_CODES.LLM_RESPONSE_PARSE_ERROR]: {
    httpStatus: 500,
    retryable: true,
    userMessage: 'Failed to parse AI response. Please try again.',
  },

  // Session errors - 404/409/410/423
  [ERROR_CODES.SESSION_NOT_FOUND]: {
    httpStatus: 404,
    retryable: false,
    userMessage: 'Session not found.',
  },
  [ERROR_CODES.SESSION_VERSION_CONFLICT]: {
    httpStatus: 409,
    retryable: true,
    userMessage: 'Session was modified. Please refresh and try again.',
  },
  [ERROR_CODES.SESSION_EXPIRED]: {
    httpStatus: 410,
    retryable: false,
    userMessage: 'Session has expired.',
  },
  [ERROR_CODES.SESSION_TERMINATED]: {
    httpStatus: 410,
    retryable: false,
    userMessage: 'Session was terminated.',
  },
  [ERROR_CODES.SESSION_INVALID_STATE]: {
    httpStatus: 409,
    retryable: false,
    userMessage: 'Session is in an invalid state for this action.',
  },
  [ERROR_CODES.SESSION_LOCKED]: {
    httpStatus: 423,
    retryable: true,
    userMessage: 'Session is currently locked. Please wait.',
  },

  // Tool errors - 202/400/403/404/500/504
  [ERROR_CODES.TOOL_EXECUTION_FAILED]: {
    httpStatus: 500,
    retryable: true,
    userMessage: 'Tool execution failed. Please try again.',
  },
  [ERROR_CODES.TOOL_TIMEOUT]: {
    httpStatus: 504,
    retryable: true,
    userMessage: 'Tool execution timed out.',
  },
  [ERROR_CODES.TOOL_APPROVAL_DENIED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'Tool execution was denied.',
  },
  [ERROR_CODES.TOOL_APPROVAL_PENDING]: {
    httpStatus: 202,
    retryable: false,
    userMessage: 'Waiting for approval.',
  },
  [ERROR_CODES.TOOL_SANDBOX_ERROR]: {
    httpStatus: 500,
    retryable: true,
    userMessage: 'Sandbox error occurred.',
  },
  [ERROR_CODES.TOOL_INVALID_ARGUMENTS]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Invalid tool arguments.',
  },
  [ERROR_CODES.TOOL_NOT_FOUND]: {
    httpStatus: 404,
    retryable: false,
    userMessage: 'Tool not found.',
  },

  // Validation errors - 400
  [ERROR_CODES.VALIDATION_MISSING_REQUIRED]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Required field is missing.',
  },
  [ERROR_CODES.VALIDATION_INVALID_FORMAT]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Invalid format.',
  },
  [ERROR_CODES.VALIDATION_OUT_OF_RANGE]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Value is out of range.',
  },
  [ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Constraint violated.',
  },
  [ERROR_CODES.VALIDATION_INVALID_JSON]: {
    httpStatus: 400,
    retryable: false,
    userMessage: 'Invalid JSON format.',
  },

  // Scope authorization - 403
  [ERROR_CODES.SCOPE_TARGET_UNVERIFIED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'Verify target ownership for this scope before continuing.',
  },

  // Resource errors - 402/404/429
  [ERROR_CODES.RESOURCE_NOT_FOUND]: {
    httpStatus: 404,
    retryable: false,
    userMessage: 'Resource not found.',
  },
  [ERROR_CODES.RESOURCE_QUOTA_EXCEEDED]: {
    httpStatus: 429,
    retryable: true,
    userMessage: 'Quota exceeded. Please upgrade or wait.',
  },
  [ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED]: {
    httpStatus: 402,
    retryable: false,
    userMessage: 'Credits exhausted. Please add more credits.',
  },
  [ERROR_CODES.RESOURCE_LIMIT_REACHED]: {
    httpStatus: 429,
    retryable: false,
    userMessage: 'Resource limit reached.',
  },

  // Network errors - 503/504
  [ERROR_CODES.NETWORK_CONNECTION_FAILED]: {
    httpStatus: 503,
    retryable: true,
    userMessage: 'Connection failed. Please check your network.',
  },
  [ERROR_CODES.NETWORK_TIMEOUT]: {
    httpStatus: 504,
    retryable: true,
    userMessage: 'Network timeout. Please try again.',
  },
  [ERROR_CODES.NETWORK_DNS_ERROR]: {
    httpStatus: 503,
    retryable: true,
    userMessage: 'DNS resolution failed.',
  },
  [ERROR_CODES.NETWORK_SSL_ERROR]: {
    httpStatus: 503,
    retryable: false,
    userMessage: 'SSL/TLS error.',
  },

  // Gating errors - 403
  [ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'This feature is not available on your current plan.',
  },
  [ERROR_CODES.GATING_MODEL_NOT_ALLOWED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'This AI model is not available on your current plan.',
  },
  [ERROR_CODES.GATING_TASK_RESTRICTED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'This task type is restricted on your current plan.',
  },
  [ERROR_CODES.GATING_SCHEDULES_EXCEEDED]: {
    httpStatus: 403,
    retryable: false,
    userMessage: 'Schedule limit exceeded. Please upgrade to create more schedules.',
  },

  // Platform/Operations - 503
  [ERROR_CODES.PLATFORM_UNDER_MAINTENANCE]: {
    httpStatus: 503,
    retryable: true,
    userMessage: "We're performing scheduled maintenance. Please try again later.",
  },

  // Internal errors - 500/503
  [ERROR_CODES.INTERNAL_UNEXPECTED]: {
    httpStatus: 500,
    retryable: true,
    userMessage: 'An unexpected error occurred. Please try again.',
  },
  [ERROR_CODES.INTERNAL_CONFIGURATION]: {
    httpStatus: 500,
    retryable: false,
    userMessage: 'Server configuration error.',
  },
  [ERROR_CODES.INTERNAL_DEPENDENCY_FAILED]: {
    httpStatus: 503,
    retryable: true,
    userMessage: 'A service dependency failed. Please try again.',
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get metadata for an error code.
 */
export function getErrorMetadata(code: ErrorCodeValue): ErrorMetadata {
  return ERROR_METADATA[code] ?? ERROR_METADATA[ERROR_CODES.INTERNAL_UNEXPECTED];
}

/**
 * Check if an error code is retryable.
 */
export function isRetryableCode(code: ErrorCodeValue): boolean {
  return getErrorMetadata(code).retryable;
}

/**
 * Get HTTP status for an error code.
 */
export function getHttpStatus(code: ErrorCodeValue): number {
  return getErrorMetadata(code).httpStatus;
}

/**
 * Get user-safe message for an error code.
 */
export function getUserMessage(code: ErrorCodeValue): string {
  return getErrorMetadata(code).userMessage;
}

/**
 * Extract category from error code (e.g., 'llm' from 'llm.rate_limit_exceeded').
 */
export function getErrorCategory(code: string): ErrorCategory | undefined {
  const category = code.split('.')[0];
  if (ERROR_CATEGORIES.includes(category as ErrorCategory)) {
    return category as ErrorCategory;
  }
  return undefined;
}

// =============================================================================
// Client-Side Error Types (for the Frontend)
// =============================================================================

/**
 * Base error context interface for debugging across all services.
 */
export interface BaseErrorContext {
  /** Request/correlation ID for tracing */
  requestId?: string;
  /** Session ID if applicable */
  sessionId?: string;
  /** Additional context data */
  [key: string]: unknown;
}

/**
 * Serialized error format for API responses.
 * Matches backend AppError.toJSON() output.
 */
export interface SerializedApiError {
  code: string;
  message: string;
  httpStatus: number;
  userMessage: string;
  retryable: boolean;
  retryAfterMs?: number;
  requestId?: string;
  context?: Record<string, unknown>;
}

/**
 * Client-side error class for the frontend.
 * Provides typed access to API error responses with helper methods.
 * 
 * @example
 * ```typescript
 * try {
 *   await api.sendMessage(content);
 * } catch (error) {
 *   const apiError = parseClientApiError(error);
 *   if (apiError.isCreditsError) {
 *     showUpgradeModal();
 *   }
 * }
 * ```
 */
export class ClientApiError extends Error {
  /** Machine-readable error code */
  readonly code: ErrorCodeValue;
  /** HTTP status code */
  readonly status: number;
  /** User-safe message (no technical details) */
  readonly userMessage: string;
  /** Whether client should retry */
  readonly retryable: boolean;
  /** Original API response if available */
  readonly response?: SerializedApiError;
  /** Marker for type checking */
  readonly isClientApiError = true;

  constructor(
    code: ErrorCodeValue,
    message: string,
    status?: number,
    response?: SerializedApiError
  ) {
    super(message);
    this.name = 'ClientApiError';
    this.code = code;
    const meta = getErrorMetadata(code);
    this.status = status ?? meta.httpStatus;
    this.userMessage = response?.userMessage ?? meta.userMessage;
    this.retryable = meta.retryable;
    this.response = response;
  }

  /** Check if this is a credits-related error. */
  get isCreditsError(): boolean {
    return this.code === ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED;
  }

  /** Check if this is a feature gating error. */
  get isGatingError(): boolean {
    return this.code.startsWith('gating.');
  }

  /** Check if this is a rate limit error. */
  get isRateLimited(): boolean {
    return this.status === 429 || this.code === ERROR_CODES.AUTH_RATE_LIMITED_USER;
  }

  /** Check if this is an auth error. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code.startsWith('auth.');
  }

  /** Check if this is a session-related error. */
  get isSessionError(): boolean {
    return this.code.startsWith('session.');
  }

  /** Get upgrade message for gating errors. */
  get upgradeMessage(): string | undefined {
    if (!this.isGatingError) return undefined;
    return this.userMessage;
  }
}

/**
 * Type guard to check if an error is a ClientApiError.
 */
export function isClientApiError(error: unknown): error is ClientApiError {
  return (
    error instanceof ClientApiError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as ClientApiError).isClientApiError === true)
  );
}

/**
 * Response error shape from fetch/axios.
 */
interface ResponseErrorShape {
  response?: {
    status?: number;
    data?: SerializedApiError | { error?: string; message?: string; code?: string };
  };
  status?: number;
  message?: string;
}

/**
 * Parse any error into a ClientApiError with typed access.
 * Handles: ClientApiError, fetch errors, axios errors, plain errors.
 */
export function parseClientApiError(error: unknown): ClientApiError {
  // Already a ClientApiError
  if (isClientApiError(error)) {
    return error;
  }

  // Response-style error (fetch, axios, openapi-fetch)
  if (typeof error === 'object' && error !== null && ('response' in error || 'status' in error)) {
    const resError = error as ResponseErrorShape;
    const status = resError.response?.status ?? resError.status ?? 500;
    const data = resError.response?.data;
    
    // Extract message
    let message = 'Request failed';
    if (data && typeof data === 'object') {
      message = ('error' in data ? data.error : undefined) ?? 
                ('message' in data ? data.message : undefined) ?? 
                resError.message ?? 
                message;
    }
    
    // Infer error code from status or data
    const code = inferErrorCodeFromResponse(status, data);
    const serialized = data && 'httpStatus' in data ? data as SerializedApiError : undefined;
    
    return new ClientApiError(code, message as string, status, serialized);
  }

  // Plain Error
  if (error instanceof Error) {
    const isRateLimit = error.message.includes('429');
    return new ClientApiError(
      isRateLimit ? ERROR_CODES.AUTH_RATE_LIMITED_USER : ERROR_CODES.INTERNAL_UNEXPECTED,
      error.message,
      isRateLimit ? 429 : 500
    );
  }

  // Unknown error
  return new ClientApiError(
    ERROR_CODES.INTERNAL_UNEXPECTED,
    typeof error === 'string' ? error : 'An unexpected error occurred',
    500
  );
}

/**
 * Infer error code from HTTP status and response data.
 */
function inferErrorCodeFromResponse(
  status: number, 
  data?: { error?: string; message?: string; code?: string } | SerializedApiError
): ErrorCodeValue {
  // Check for explicit code in response
  if (data && 'code' in data && data.code) {
    // Validate it's a known error code
    const values = Object.values(ERROR_CODES);
    if (values.includes(data.code as ErrorCodeValue)) {
      return data.code as ErrorCodeValue;
    }
  }
  
  // Infer from message content
  const msg = (data && 'error' in data ? data.error : undefined)?.toLowerCase() ?? 
              (data && 'message' in data ? data.message : undefined)?.toLowerCase() ?? 
              '';
  
  if (msg.includes('credits')) return ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED;
  if (msg.includes('feature') || msg.includes('plan')) return ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE;
  if (msg.includes('session') && msg.includes('limit')) return ERROR_CODES.RESOURCE_LIMIT_REACHED;
  
  // Infer from HTTP status
  switch (status) {
    case 401: return ERROR_CODES.AUTH_INVALID_SESSION;
    case 402: return ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED;
    case 403: return ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS;
    case 404: return ERROR_CODES.RESOURCE_NOT_FOUND;
    case 409: return ERROR_CODES.SESSION_VERSION_CONFLICT;
    case 429: return ERROR_CODES.AUTH_RATE_LIMITED_USER;
    default: return status >= 500 ? ERROR_CODES.INTERNAL_UNEXPECTED : ERROR_CODES.VALIDATION_INVALID_FORMAT;
  }
}
