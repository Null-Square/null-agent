import {
    ERROR_CODES,
    type ErrorCodeValue,
    getErrorMetadata,
} from '@null-ai/contracts';

/**
 * Application error context for debugging.
 */
export interface ErrorContext {
    /** Affected parameter name */
    param?: string;
    /** Request/correlation ID for tracing */
    requestId?: string;
    /** Session ID if applicable */
    sessionId?: string;
    /** Tool name if applicable */
    toolName?: string;
    /** Model name if applicable */
    model?: string;
    /** Additional context data */
    [key: string]: unknown;
}

/**
 * Serialized error format for API responses.
 */
export interface SerializedError {
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
 * AppError is the base error class for all application errors.
 * 
 * Follows patterns from OpenAI, Stripe, and Google Cloud:
 * - Hierarchical error codes (domain.category.specific)
 * - Machine-readable for programmatic handling
 * - Separate developer vs. user messages
 * - Retry metadata for client-side handling
 * 
 * @example
 * ```typescript
 * throw new AppError(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED, 'OpenAI rate limit hit', {
 *   retryAfterMs: 5000,
 *   context: { model: 'gpt-4o' }
 * });
 * ```
 */
export class AppError extends Error {
    /** Machine-readable error code */
    public readonly code: ErrorCodeValue;
    /** HTTP status code */
    public readonly httpStatus: number;
    /** User-safe message (no technical details) */
    public readonly userMessage: string;
    /** Whether client should retry */
    public readonly retryable: boolean;
    /** Suggested retry delay in milliseconds */
    public readonly retryAfterMs?: number;
    /** Additional debug context */
    public readonly context?: ErrorContext;
    /** Original underlying error */
    public readonly cause?: Error;

    constructor(
        code: ErrorCodeValue,
        message: string,
        options: {
            retryAfterMs?: number;
            context?: ErrorContext;
            cause?: Error;
            /** Override default user message */
            userMessage?: string;
            /** Override default HTTP status */
            httpStatus?: number;
        } = {}
    ) {
        super(message);
        this.name = 'AppError';
        this.code = code;

        const metadata = getErrorMetadata(code);
        this.httpStatus = options.httpStatus ?? metadata.httpStatus;
        this.userMessage = options.userMessage ?? metadata.userMessage;
        this.retryable = metadata.retryable;
        this.retryAfterMs = options.retryAfterMs;
        this.context = options.context;
        this.cause = options.cause;

        // Maintain proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }

    /**
     * Serialize the error for API response.
     */
    toJSON(): SerializedError {
        return {
            code: this.code,
            message: this.message,
            httpStatus: this.httpStatus,
            userMessage: this.userMessage,
            retryable: this.retryable,
            ...(this.retryAfterMs !== undefined && { retryAfterMs: this.retryAfterMs }),
            ...(this.context?.requestId && { requestId: this.context.requestId }),
            ...(this.context && Object.keys(this.context).length > 0 && { context: this.context }),
        };
    }

    /**
     * Create a user-safe error response (hides internal details).
     */
    toUserResponse(): Pick<SerializedError, 'code' | 'userMessage' | 'retryable' | 'retryAfterMs'> {
        return {
            code: this.code,
            userMessage: this.userMessage,
            retryable: this.retryable,
            ...(this.retryAfterMs !== undefined && { retryAfterMs: this.retryAfterMs }),
        };
    }

    /**
     * Check if this error is of a specific code.
     */
    is(code: ErrorCodeValue): boolean {
        return this.code === code;
    }

    /**
     * Check if this error is in a specific domain.
     */
    inDomain(domain: string): boolean {
        return this.code.startsWith(domain + '.');
    }

    /**
     * Create an AppError from an unknown error.
     */
    static from(error: unknown, fallbackCode: ErrorCodeValue = ERROR_CODES.INTERNAL_UNEXPECTED): AppError {
        if (error instanceof AppError) {
            return error;
        }

        if (error instanceof Error) {
            return new AppError(fallbackCode, error.message, { cause: error });
        }

        return new AppError(fallbackCode, String(error));
    }

    /**
     * Wrap an error with additional context.
     */
    static wrap(
        error: unknown,
        message: string,
        options: { code?: ErrorCodeValue; context?: ErrorContext } = {}
    ): AppError {
        const cause = error instanceof Error ? error : undefined;
        const code = options.code ?? (error instanceof AppError ? error.code : ERROR_CODES.INTERNAL_UNEXPECTED);

        return new AppError(code, message, {
            cause,
            context: {
                ...(error instanceof AppError ? error.context : {}),
                ...options.context,
            },
        });
    }
}

/**
 * Type guard to check if an error is an AppError.
 */
export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
}

/**
 * Type guard to check if an error has a specific code.
 */
export function hasErrorCode(error: unknown, code: ErrorCodeValue): boolean {
    return error instanceof AppError && error.code === code;
}
