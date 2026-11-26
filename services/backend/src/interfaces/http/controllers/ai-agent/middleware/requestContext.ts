import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';
import type { RequestHandler } from 'express';

/**
 * Request context stored in AsyncLocalStorage.
 */
export interface RequestContext {
    /** Unique request ID for tracing */
    requestId: string;
    /** Request start time */
    startTime: number;
    /** User ID if authenticated */
    userId?: string;
    /** Session ID if applicable */
    sessionId?: string;
}

/**
 * AsyncLocalStorage for request context.
 * Allows accessing request context from anywhere without passing it explicitly.
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context.
 * Returns undefined if called outside of a request.
 */
export function getRequestContext(): RequestContext | undefined {
    return requestContextStorage.getStore();
}

/**
 * Get the current request ID.
 * Returns 'unknown' if called outside of a request.
 */
export function getRequestId(): string {
    return getRequestContext()?.requestId ?? 'unknown';
}

/**
 * Run a function with a specific request context.
 * Useful for background tasks that need to preserve context.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
    return requestContextStorage.run(context, fn);
}

/**
 * Create a new request context.
 */
export function createRequestContext(overrides?: Partial<RequestContext>): RequestContext {
    return {
        requestId: overrides?.requestId ?? `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
        startTime: overrides?.startTime ?? Date.now(),
        ...overrides,
    };
}

// Header name for request ID (following OpenAI pattern)
const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Middleware that sets up request context with tracing.
 * 
 * - Generates or uses incoming `x-request-id` header
 * - Stores context in AsyncLocalStorage
 * - Returns `x-request-id` in response headers
 * 
 * @example
 * ```typescript
 * app.use(requestContextMiddleware());
 * 
 * // Later, anywhere in the request:
 * import { getRequestId } from './requestContext';
 * logger.info({ requestId: getRequestId() }, 'Processing...');
 * ```
 */
export function requestContextMiddleware(): RequestHandler {
    return (req, res, next) => {
        // Use incoming request ID or generate new one
        const incomingId = req.headers[REQUEST_ID_HEADER];
        const requestId = typeof incomingId === 'string' && incomingId.trim()
            ? incomingId.trim()
            : `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

        const context = createRequestContext({
            requestId,
            userId: req.userId,
            sessionId: req.params?.sessionId,
        });

        // Set response header
        res.setHeader(REQUEST_ID_HEADER, requestId);

        // Run the rest of the request with this context
        requestContextStorage.run(context, () => {
            next();
        });
    };
}

/**
 * Get request duration in milliseconds.
 */
export function getRequestDuration(): number {
    const context = getRequestContext();
    if (!context) return 0;
    return Date.now() - context.startTime;
}
