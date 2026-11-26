/**
 * Telemetry module exports
 * 
 * Re-exports tracing and span utilities for convenient imports.
 */

export { startTracing, stopTracing, isTracingEnabled } from './tracing';
export {
    withSpan,
    spanTurn,
    spanToolExec,
    spanSandbox,
    spanTransition,
    spanLLMCall,
    addSpanEvent,
    setSpanAttributes,
    getCurrentTraceId,
    getCurrentSpanId,
} from './spans';
