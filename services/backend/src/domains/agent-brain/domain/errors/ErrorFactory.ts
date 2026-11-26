import { ERROR_CODES, type ErrorCodeValue } from '@null-ai/contracts';
import { AppError, type ErrorContext } from './AppError';

/**
 * Common options for error creation.
 */
interface CreateErrorOptions {
    context?: ErrorContext;
    cause?: Error;
    userMessage?: string;
    httpStatus?: number;
    retryAfterMs?: number;
}

/**
 * ErrorFactory provides domain-specific factory methods for creating typed errors.
 * 
 * @example
 * ```typescript
 * throw ErrorFactory.llm.rateLimitExceeded({ retryAfterMs: 5000, context: { model: 'gpt-4o' } });
 * throw ErrorFactory.session.notFound({ context: { sessionId: 'abc-123' } });
 * throw ErrorFactory.tool.approvalDenied({ context: { toolName: 'run_command' } });
 * ```
 */
export const ErrorFactory = {
    // =========================================================================
    // Authentication & Authorization
    // =========================================================================
    auth: {
        invalidApiKey: (options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.AUTH_INVALID_API_KEY, 'Invalid API key', options),

        expiredToken: (options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.AUTH_EXPIRED_TOKEN, 'Token has expired', options),

        insufficientPermissions: (resource: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
                `Insufficient permissions for ${resource}`,
                { ...options, context: { ...options?.context, resource } }
            ),

        rateLimitedUser: (options?: { retryAfterMs?: number } & CreateErrorOptions) =>
            new AppError(ERROR_CODES.AUTH_RATE_LIMITED_USER, 'User rate limit exceeded', options),

        invalidSession: (options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.AUTH_INVALID_SESSION, 'Invalid session', options),
    },

    // =========================================================================
    // LLM Provider Errors
    // =========================================================================
    llm: {
        providerUnavailable: (provider: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.LLM_PROVIDER_UNAVAILABLE,
                `LLM provider ${provider} is unavailable`,
                { ...options, context: { ...options?.context, provider } }
            ),

        rateLimitExceeded: (options?: { retryAfterMs?: number } & CreateErrorOptions) =>
            new AppError(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED, 'LLM rate limit exceeded', options),

        contextLengthExceeded: (
            actual: number,
            max: number,
            options?: CreateErrorOptions
        ) =>
            new AppError(
                ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED,
                `Context length ${actual} exceeds maximum ${max}`,
                { ...options, context: { ...options?.context, actualTokens: actual, maxTokens: max } }
            ),

        contentFilterTriggered: (options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.LLM_CONTENT_FILTER_TRIGGERED, 'Content filter triggered', options),

        invalidModel: (model: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.LLM_INVALID_MODEL,
                `Invalid model: ${model}`,
                { ...options, context: { ...options?.context, model } }
            ),

        timeout: (timeoutMs: number, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.LLM_TIMEOUT,
                `LLM request timed out after ${timeoutMs}ms`,
                { ...options, context: { ...options?.context, timeoutMs } }
            ),

        responseParseError: (options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.LLM_RESPONSE_PARSE_ERROR, 'Failed to parse LLM response', options),
    },

    // =========================================================================
    // Session Management
    // =========================================================================
    session: {
        notFound: (sessionId: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.SESSION_NOT_FOUND,
                `Session ${sessionId} not found`,
                { ...options, context: { ...options?.context, sessionId } }
            ),

        versionConflict: (
            sessionId: string,
            expected: number,
            actual: number,
            options?: CreateErrorOptions
        ) =>
            new AppError(
                ERROR_CODES.SESSION_VERSION_CONFLICT,
                `Version conflict for session ${sessionId}: expected ${expected}, got ${actual}`,
                { ...options, context: { ...options?.context, sessionId, expectedVersion: expected, actualVersion: actual } }
            ),

        expired: (sessionId: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.SESSION_EXPIRED,
                `Session ${sessionId} has expired`,
                { ...options, context: { ...options?.context, sessionId } }
            ),

        terminated: (sessionId: string, reason?: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.SESSION_TERMINATED,
                `Session ${sessionId} was terminated${reason ? `: ${reason}` : ''}`,
                { ...options, context: { ...options?.context, sessionId, reason } }
            ),

        invalidState: (
            sessionId: string,
            currentState: string,
            requiredState: string,
            options?: CreateErrorOptions
        ) =>
            new AppError(
                ERROR_CODES.SESSION_INVALID_STATE,
                `Session ${sessionId} is ${currentState}, required ${requiredState}`,
                { ...options, context: { ...options?.context, sessionId, currentState, requiredState } }
            ),

        locked: (sessionId: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.SESSION_LOCKED,
                `Session ${sessionId} is locked`,
                { ...options, context: { ...options?.context, sessionId } }
            ),
    },

    // =========================================================================
    // Tool Execution
    // =========================================================================
    tool: {
        executionFailed: (toolName: string, reason: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.TOOL_EXECUTION_FAILED,
                `Tool ${toolName} failed: ${reason}`,
                { ...options, context: { ...options?.context, toolName, reason } }
            ),

        timeout: (toolName: string, timeoutMs: number, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.TOOL_TIMEOUT,
                `Tool ${toolName} timed out after ${timeoutMs}ms`,
                { ...options, context: { ...options?.context, toolName, timeoutMs } }
            ),

        approvalDenied: (toolName: string, reason?: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.TOOL_APPROVAL_DENIED,
                `Approval denied for ${toolName}${reason ? `: ${reason}` : ''}`,
                { ...options, context: { ...options?.context, toolName, reason } }
            ),

        approvalPending: (toolName: string, requestId: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.TOOL_APPROVAL_PENDING,
                `Awaiting approval for ${toolName}`,
                { ...options, context: { ...options?.context, toolName, requestId } }
            ),

        sandboxError: (toolName: string, reason: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.TOOL_SANDBOX_ERROR,
                `Sandbox error for ${toolName}: ${reason}`,
                { ...options, context: { ...options?.context, toolName, reason } }
            ),

        invalidArguments: (toolName: string, reason: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.TOOL_INVALID_ARGUMENTS,
                `Invalid arguments for ${toolName}: ${reason}`,
                { ...options, context: { ...options?.context, toolName, reason } }
            ),

        notFound: (toolName: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.TOOL_NOT_FOUND,
                `Tool ${toolName} not found`,
                { ...options, context: { ...options?.context, toolName } }
            ),
    },

    // =========================================================================
    // Input Validation
    // =========================================================================
    validation: {
        missingRequired: (param: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.VALIDATION_MISSING_REQUIRED,
                `Missing required field: ${param}`,
                { ...options, context: { ...options?.context, param } }
            ),

        invalidFormat: (param: string, expected: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.VALIDATION_INVALID_FORMAT,
                `Invalid format for ${param}: expected ${expected}`,
                { ...options, context: { ...options?.context, param, expectedFormat: expected } }
            ),

        outOfRange: (param: string, min: number, max: number, actual: number, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.VALIDATION_OUT_OF_RANGE,
                `${param} must be between ${min} and ${max}, got ${actual}`,
                { ...options, context: { ...options?.context, param, min, max, actual } }
            ),

        constraintViolated: (constraint: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
                `Constraint violated: ${constraint}`,
                { ...options, context: { ...options?.context, constraint } }
            ),

        invalidJson: (options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.VALIDATION_INVALID_JSON, 'Invalid JSON', options),
    },

    // =========================================================================
    // Resource Management
    // =========================================================================
    resource: {
        notFound: (resourceType: string, resourceId: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.RESOURCE_NOT_FOUND,
                `${resourceType} ${resourceId} not found`,
                { ...options, context: { ...options?.context, resourceType, resourceId } }
            ),

        quotaExceeded: (resource: string, limit: number, options?: { retryAfterMs?: number } & CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.RESOURCE_QUOTA_EXCEEDED,
                `Quota exceeded for ${resource}: limit ${limit}`,
                { ...options, context: { ...options?.context, resource, limit } }
            ),

        creditsExhausted: (options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED, 'Credits exhausted', options),

        limitReached: (resource: string, limit: number, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.RESOURCE_LIMIT_REACHED,
                `${resource} limit reached: ${limit}`,
                { ...options, context: { ...options?.context, resource, limit } }
            ),
    },

    // =========================================================================
    // Network/Connection
    // =========================================================================
    network: {
        connectionFailed: (host: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.NETWORK_CONNECTION_FAILED,
                `Failed to connect to ${host}`,
                { ...options, context: { ...options?.context, host } }
            ),

        timeout: (host: string, timeoutMs: number, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.NETWORK_TIMEOUT,
                `Network timeout connecting to ${host} after ${timeoutMs}ms`,
                { ...options, context: { ...options?.context, host, timeoutMs } }
            ),

        dnsError: (host: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.NETWORK_DNS_ERROR,
                `DNS resolution failed for ${host}`,
                { ...options, context: { ...options?.context, host } }
            ),

        sslError: (host: string, reason: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.NETWORK_SSL_ERROR,
                `SSL error for ${host}: ${reason}`,
                { ...options, context: { ...options?.context, host, reason } }
            ),
    },

    // =========================================================================
    // Internal Errors
    // =========================================================================
    internal: {
        unexpected: (message: string, options?: CreateErrorOptions) =>
            new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, message, options),

        configuration: (setting: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.INTERNAL_CONFIGURATION,
                `Configuration error: ${setting}`,
                { ...options, context: { ...options?.context, setting } }
            ),

        dependencyFailed: (dependency: string, options?: CreateErrorOptions) =>
            new AppError(
                ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
                `Dependency ${dependency} failed`,
                { ...options, context: { ...options?.context, dependency } }
            ),
    },

    // =========================================================================
    // Generic factory from code
    // =========================================================================
    fromCode: (code: ErrorCodeValue, message: string, options?: CreateErrorOptions & { retryAfterMs?: number }) =>
        new AppError(code, message, options),
};
