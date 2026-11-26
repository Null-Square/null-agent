/**
 * OpenTelemetry Span Utilities
 * 
 * Provides helpers for creating custom spans around business logic.
 * Use these for instrumenting high-value operations.
 * 
 * @module spans
 */

import { trace, SpanStatusCode, SpanKind, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('nullai-backend');

/**
 * Wrap an async function with a traced span
 * 
 * @example
 * ```typescript
 * const result = await withSpan('processMessage', { sessionId }, async () => {
 *   return await orchestrator.process(message);
 * });
 * ```
 */
export async function withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
            const result = await fn(span);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (error) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            throw error;
        } finally {
            span.end();
        }
    });
}

/**
 * Create a span for a turn execution
 */
export function spanTurn<T>(
    sessionId: string,
    turnNumber: number,
    userId: string | undefined,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return withSpan(
        'turn.execute',
        {
            'session.id': sessionId,
            'turn.number': turnNumber,
            'user.id': userId || 'unknown',
        },
        fn,
    );
}

/**
 * Create a span for tool execution
 */
export function spanToolExec<T>(
    toolName: string,
    sessionId: string,
    args: Record<string, unknown>,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return withSpan(
        'tool.execute',
        {
            'tool.name': toolName,
            'session.id': sessionId,
            'tool.args.count': Object.keys(args).length,
        },
        fn,
    );
}

/**
 * Create a span for sandbox operations
 */
export function spanSandbox<T>(
    operation: 'provision' | 'destroy' | 'exec' | 'copy',
    sessionId: string,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return withSpan(
        `sandbox.${operation}`,
        {
            'sandbox.operation': operation,
            'session.id': sessionId,
        },
        fn,
    );
}

/**
 * Create a span for session state transitions
 */
export function spanTransition<T>(
    sessionId: string,
    fromState: string,
    toState: string,
    trigger: string,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return withSpan(
        'session.transition',
        {
            'session.id': sessionId,
            'session.state.from': fromState,
            'session.state.to': toState,
            'session.transition.trigger': trigger,
        },
        fn,
    );
}

/**
 * Create a span for LLM API calls
 */
export function spanLLMCall<T>(
    provider: string,
    model: string,
    sessionId: string,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return tracer.startActiveSpan(
        'llm.call',
        {
            attributes: {
                'llm.provider': provider,
                'llm.model': model,
                'session.id': sessionId,
            },
            kind: SpanKind.CLIENT,
        },
        async (span) => {
            try {
                const result = await fn(span);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            } catch (error) {
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error),
                });
                span.recordException(error instanceof Error ? error : new Error(String(error)));
                throw error;
            } finally {
                span.end();
            }
        },
    );
}

/**
 * Add an event to the current active span
 */
export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
        span.addEvent(name, attributes);
    }
}

/**
 * Set attributes on the current active span
 */
export function setSpanAttributes(attributes: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
        span.setAttributes(attributes);
    }
}

/**
 * Get the current trace ID (useful for correlation in logs)
 */
export function getCurrentTraceId(): string | undefined {
    const span = trace.getActiveSpan();
    if (span) {
        return span.spanContext().traceId;
    }
    return undefined;
}

/**
 * Get the current span ID
 */
export function getCurrentSpanId(): string | undefined {
    const span = trace.getActiveSpan();
    if (span) {
        return span.spanContext().spanId;
    }
    return undefined;
}
