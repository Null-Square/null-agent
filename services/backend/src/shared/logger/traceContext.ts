/**
 * Pino mixin that injects OpenTelemetry trace context into every log line.
 * This enables log → trace correlation in Grafana (Loki → Tempo).
 * 
 * @module traceContext
 */

import { trace } from '@opentelemetry/api';

/**
 * Pino mixin function that adds traceId and spanId to log records
 * when an OpenTelemetry span is active.
 * 
 * Usage in logger.ts:
 * ```typescript
 * const baseOptions: LoggerOptions = {
 *   mixin: traceContextMixin,
 *   // ...
 * };
 * ```
 * 
 * This produces log lines like:
 * ```json
 * {
 *   "level": "info",
 *   "traceId": "abc123...",
 *   "spanId": "def456...",
 *   "msg": "Processing request"
 * }
 * ```
 */
export function traceContextMixin(): Record<string, unknown> {
  const span = trace.getActiveSpan();
  if (!span) {
    return {};
  }
  
  const ctx = span.spanContext();
  
  // Only include if trace context is valid (not all zeros)
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') {
    return {};
  }
  
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
  };
}
