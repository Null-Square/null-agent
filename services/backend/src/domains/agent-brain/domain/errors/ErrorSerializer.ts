import { isAppError, AppError } from './AppError';
import { ERROR_CODES, type ErrorCodeValue, type SerializedApiError } from '@null-ai/contracts';
import { toAppError } from './catchTyped';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const ERROR_CODE_VALUES = new Set(Object.values(ERROR_CODES) as ErrorCodeValue[]);

const getCodeOverride = (error: unknown): ErrorCodeValue | undefined => {
    if (!isRecord(error)) {
        return undefined;
    }
    const code = error['code'];
    if (typeof code === 'string' && ERROR_CODE_VALUES.has(code as ErrorCodeValue)) {
        return code as ErrorCodeValue;
    }
    return undefined;
};

const getStatusOverride = (error: unknown): number | undefined => {
    if (!isRecord(error)) {
        return undefined;
    }
    const statusField = error['status'] ?? error['statusCode'] ?? error['httpStatus'];
    if (typeof statusField === 'number' && statusField >= 400 && statusField < 600) {
        return statusField;
    }
    if (typeof statusField === 'string' && Number.isFinite(Number(statusField))) {
        const numeric = Number(statusField);
        if (numeric >= 400 && numeric < 600) {
            return numeric;
        }
    }
    return undefined;
};

const getContextOverride = (error: unknown): Record<string, unknown> | undefined => {
    if (!isRecord(error)) {
        return undefined;
    }
    const context: Record<string, unknown> = {};
    const detail = error['detail'];
    const details = error['details'];
    const extras = error['extras'];

    if (detail !== undefined) {
        context.detail = detail;
    }
    if (details !== undefined) {
        context.details = details;
    }
    if (isRecord(extras)) {
        Object.assign(context, extras);
    }

    return Object.keys(context).length > 0 ? context : undefined;
};

const resolveAppError = (error: unknown): AppError => {
    if (isAppError(error)) {
        return error;
    }
    const override = getCodeOverride(error);
    const context = getContextOverride(error);
    if (override) {
        const message = error instanceof Error ? error.message : String(error);
        return new AppError(override, message, {
            cause: error instanceof Error ? error : undefined,
            context,
        });
    }
    return toAppError(error, ERROR_CODES.INTERNAL_UNEXPECTED, context);
};

const buildResponse = (
    error: unknown,
    requestId?: string,
    options?: { sanitizeMessage?: boolean; includeContext?: boolean },
): SerializedApiError => {
    const appError = resolveAppError(error);
    const statusOverride = getStatusOverride(error);
    const code = appError.code;
    const httpStatus = statusOverride ?? appError.httpStatus;
    const message = options?.sanitizeMessage ? appError.userMessage : appError.message;
    const includeContext = options?.includeContext ?? true;

    return {
        code,
        message,
        httpStatus,
        userMessage: appError.userMessage,
        retryable: appError.retryable,
        ...(appError.retryAfterMs !== undefined && { retryAfterMs: appError.retryAfterMs }),
        ...(requestId ? { requestId } : {}),
        ...(includeContext && appError.context && Object.keys(appError.context).length > 0
            ? { context: appError.context }
            : {}),
    };
};

/**
 * ErrorSerializer provides consistent error serialization for API responses.
 * 
 * Follows patterns from OpenAI/Stripe:
 * - Consistent error structure
 * - Request ID for tracing
 * - User-safe messages in production
 */
export const ErrorSerializer = {
    /**
     * Serialize an error for API response (development mode).
     * Includes full error details for debugging.
     */
    toApiResponse(error: unknown, requestId?: string): SerializedApiError {
        return buildResponse(error, requestId, { includeContext: true });
    },

    /**
     * Serialize an error for user-facing response (production mode).
     * Hides internal details, uses user-safe messages.
     */
    toUserResponse(error: unknown, requestId?: string): SerializedApiError {
        return buildResponse(error, requestId, { sanitizeMessage: true, includeContext: false });
    },

    /**
     * Get HTTP status code for an error.
     */
    getHttpStatus(error: unknown): number {
        const override = getStatusOverride(error);
        if (override !== undefined) {
            return override;
        }
        if (isAppError(error)) {
            return error.httpStatus;
        }
        return 500;
    },

    /**
     * Auto-select response format based on environment.
     */
    serialize(error: unknown, requestId: string | undefined, options: { isDev: boolean }): SerializedApiError {
        return options.isDev
            ? this.toApiResponse(error, requestId)
            : this.toUserResponse(error, requestId);
    },
};
