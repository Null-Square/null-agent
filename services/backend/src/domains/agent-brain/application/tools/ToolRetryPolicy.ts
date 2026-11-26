import { logger as appLogger } from '@/shared/logger';

/**
 * Retryable error types for tool execution.
 * These are transient errors that may succeed on retry.
 */
const RETRYABLE_ERROR_PATTERNS = [
    // Network errors
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'socket hang up',
    'network',
    // HTTP transient errors
    '429',
    'too many requests',
    'rate limit',
    '503',
    'service unavailable',
    '502',
    'bad gateway',
    '504',
    'gateway timeout',
    // API specific
    'temporary error',
    'internal server error',
];

export interface ToolRetryConfig {
    /** Maximum number of retries. Default: 2 */
    maxRetries?: number;
    /** Base delay in milliseconds. Default: 500 */
    baseDelayMs?: number;
    /** Maximum delay in milliseconds. Default: 4000 */
    maxDelayMs?: number;
    /** Abort signal */
    signal?: AbortSignal;
    /** Tool name for logging */
    toolName?: string;
    /** Session ID for logging */
    sessionId?: string;
}

const logger = appLogger.child({ scope: 'ToolRetryPolicy' });

/**
 * Check if a tool error is retryable.
 */
export function isRetryableToolError(error: unknown): boolean {
    if (!error) return false;

    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

    return RETRYABLE_ERROR_PATTERNS.some(pattern => message.includes(pattern.toLowerCase()));
}

/**
 * Sleep with abort support.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Aborted'));
            return;
        }
        const timeout = setTimeout(resolve, ms);
        const abortHandler = () => {
            clearTimeout(timeout);
            reject(new Error('Aborted'));
        };
        signal?.addEventListener('abort', abortHandler, { once: true });
    });
}

/**
 * Execute a tool function with retry logic.
 * 
 * This is an opt-in retry mechanism for tools that perform network operations.
 * It should NOT be used for tools that have side effects that cannot be safely repeated.
 * 
 * @param fn - Tool function to execute
 * @param config - Retry configuration
 * @returns Tool result or throws after max retries
 * 
 * @example
 * ```typescript
 * // In a tool implementation:
 * export async function execute(args: Args, context: ToolContext) {
 *   return withToolRetry(
 *     () => fetchExternalAPI(args),
 *     { maxRetries: 2, toolName: 'fetch_api', sessionId: context.sessionId }
 *   );
 * }
 * ```
 */
export async function withToolRetry<T>(
    fn: () => Promise<T>,
    config: ToolRetryConfig = {}
): Promise<T> {
    const {
        maxRetries = 2,
        baseDelayMs = 500,
        maxDelayMs = 4000,
        signal,
        toolName = 'unknown',
        sessionId,
    } = config;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (signal?.aborted) {
            throw new Error('Aborted');
        }

        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Don't retry on final attempt or non-retryable errors
            if (attempt > maxRetries || !isRetryableToolError(error)) {
                throw lastError;
            }

            const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

            logger.info(
                { toolName, sessionId, attempt, maxRetries, delayMs, error: lastError.message },
                'Retrying tool execution after transient error'
            );

            try {
                await sleep(delayMs, signal);
            } catch {
                throw lastError;
            }
        }
    }

    throw lastError ?? new Error('Tool retry exhausted');
}

/**
 * Mark a tool execution function as retryable.
 * 
 * This is a higher-order function that wraps a tool executor with retry logic.
 * 
 * @param fn - Original tool function  
 * @param defaultConfig - Default retry configuration
 * @returns Wrapped function with retry
 */
export function retryable<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    defaultConfig: Omit<ToolRetryConfig, 'signal'> = {}
): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs) => {
        return withToolRetry(() => fn(...args), defaultConfig);
    };
}
