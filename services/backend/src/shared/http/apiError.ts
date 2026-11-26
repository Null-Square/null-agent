/**
 * Standardized API Error Response
 *
 * Uses the AppError/SerializedApiError contract from @null-ai/contracts.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError, ErrorSerializer } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES, type ErrorCodeValue, type SerializedApiError, getErrorMetadata } from '@null-ai/contracts';

/** Standard API error shape */
export type ApiErrorBody = SerializedApiError;

const ERROR_CODE_VALUES = new Set(Object.values(ERROR_CODES) as ErrorCodeValue[]);
let defaultIsDev = false;

export const configureApiError = (options: { isDev: boolean }): void => {
    defaultIsDev = options.isDev;
};

const resolveIsDev = (req?: Request, res?: Response, explicit?: boolean): boolean => {
    if (typeof explicit === 'boolean') {
        return explicit;
    }
    if (res?.app?.locals?.isDev !== undefined) {
        return Boolean(res.app.locals.isDev);
    }
    if (req?.app?.locals?.isDev !== undefined) {
        return Boolean(req.app.locals.isDev);
    }
    return defaultIsDev;
};

/**
 * Get HTTP status for an error code, with fallback
 */
export function getStatusForCode(code: string): number {
    if (ERROR_CODE_VALUES.has(code as ErrorCodeValue)) {
        return getErrorMetadata(code as ErrorCodeValue).httpStatus;
    }

    // Legacy inference
    if (code.startsWith('auth.')) return 401;
    if (code.startsWith('validation.')) return 400;
    if (code.startsWith('rate.')) return 429;
    if (code.startsWith('resource.')) return 404;
    if (code.startsWith('server.')) return 500;

    return 500;
}

/**
 * Create a standardized API error response body
 */
export function createApiError(params: {
    code: ErrorCodeValue;
    message: string;
    status?: number;
    requestId?: string;
    context?: Record<string, unknown>;
    details?: Record<string, unknown>;
    retryAfterMs?: number;
    userMessage?: string;
    isDev?: boolean;
}): ApiErrorBody {
    const context = params.context ?? params.details;
    const appError = new AppError(params.code, params.message, {
        httpStatus: params.status,
        userMessage: params.userMessage,
        retryAfterMs: params.retryAfterMs,
        context,
    });

    return ErrorSerializer.serialize(appError, params.requestId, { isDev: resolveIsDev(undefined, undefined, params.isDev) });
}

/**
 * Send a standardized error response
 */
export function sendApiError(
    res: Response,
    params: {
        code: ErrorCodeValue;
        message: string;
        status?: number;
        requestId?: string;
        context?: Record<string, unknown>;
        details?: Record<string, unknown>;
        retryAfterMs?: number;
        userMessage?: string;
        isDev?: boolean;
    },
): Response {
    const body = createApiError({ ...params, isDev: resolveIsDev(undefined, res, params.isDev) });
    const status = body.httpStatus;

    // Add Retry-After header for rate limiting
    if (status === 429 && body.retryAfterMs) {
        const retryAfterSeconds = Math.ceil(Number(body.retryAfterMs) / 1000);
        res.setHeader('Retry-After', retryAfterSeconds.toString());
    }

    return res.status(status).json(body);
}

/**
 * Convenience functions for common errors
 */
export const ApiErrors = {
    unauthorized: (message = 'Authentication required', requestId?: string) =>
        createApiError({ code: ERROR_CODES.AUTH_INVALID_SESSION, message, requestId }),

    forbidden: (message = 'Access denied', requestId?: string) =>
        createApiError({ code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, message, requestId }),

    notFound: (resource: string, requestId?: string) =>
        createApiError({ code: ERROR_CODES.RESOURCE_NOT_FOUND, message: `${resource} not found`, requestId }),

    validation: (message: string, details?: Record<string, unknown>, requestId?: string) =>
        createApiError({ code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, message, details, requestId }),

    rateLimited: (message = 'Rate limit exceeded', retryAfterMs?: number, requestId?: string) =>
        createApiError({ code: ERROR_CODES.AUTH_RATE_LIMITED_USER, message, retryAfterMs, requestId }),

    creditsExhausted: (details?: Record<string, unknown>, requestId?: string) =>
        createApiError({ code: ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED, message: 'Insufficient credits', details, requestId }),

    tokenLimitExceeded: (details?: Record<string, unknown>, requestId?: string) =>
        createApiError({ code: ERROR_CODES.RESOURCE_LIMIT_REACHED, message: 'Token limit exceeded', details, requestId }),

    serverError: (message = 'Internal server error', requestId?: string) =>
        createApiError({ code: ERROR_CODES.INTERNAL_UNEXPECTED, message, requestId }),

    unavailable: (message = 'Service unavailable', requestId?: string) =>
        createApiError({ code: ERROR_CODES.INTERNAL_DEPENDENCY_FAILED, message, requestId }),
};

/**
 * Express error handler middleware that uses standardized responses
 */
export function apiErrorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    const requestId = req.requestId ?? res.locals?.requestId;
    const response = ErrorSerializer.serialize(err, requestId, { isDev: resolveIsDev(req, res) });

    if (response.httpStatus === 429 && response.retryAfterMs) {
        res.setHeader('Retry-After', Math.ceil(response.retryAfterMs / 1000).toString());
    }

    res.status(response.httpStatus).json(response);
}

/**
 * Check if a value is an ApiErrorBody
 */
export function isApiError(value: unknown): value is ApiErrorBody {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const record = value as { code?: unknown; message?: unknown; httpStatus?: unknown };
    return (
        typeof record.code === 'string' &&
        typeof record.message === 'string' &&
        typeof record.httpStatus === 'number'
    );
}
