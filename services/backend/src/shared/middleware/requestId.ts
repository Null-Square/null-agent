import type { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { ResolvedConfig } from '@/config/configTypes';
import { requestLogger } from '@/shared/logger';
import { opsMetrics } from '@/shared/metrics/opsMetrics';

type RequestIdMiddlewareOptions = {
  config?: Pick<ResolvedConfig, 'http'>;
};

const SENSITIVE_QUERY_VALUE = /([?&](?:access_token|refresh_token|token|turnstileToken|cf-turnstile-response)=)[^&#]*/gi;

/** Keep routing context in logs without retaining short-lived challenge tokens. */
export const redactSensitiveRequestPath = (path: string | undefined): string | undefined =>
  path?.replace(SENSITIVE_QUERY_VALUE, '$1[redacted]');

/**
 * Attaches a request ID and per-request logger to the request.
 * Also records request latency metrics and writes structured logs.
 */
export const requestIdMiddleware = (options?: RequestIdMiddlewareOptions): RequestHandler => {
  const httpConfig = options?.config?.http;
  if (!httpConfig) {
    throw new Error('[RequestIdMiddleware] Missing http config');
  }

  return (req, res, next) => {
    const requestId = (req.headers['x-request-id'] as string)?.trim() || uuidv4();
    res.setHeader('x-request-id', requestId);
    req.requestId = requestId;
    res.locals.requestId = requestId;

    const reqLogger = requestLogger({
      requestId,
      path: redactSensitiveRequestPath(req.originalUrl),
      method: req.method,
      userId: req.user?.id,
    });
    req.logger = reqLogger;

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      opsMetrics.recordRequest(durationMs, res.statusCode);
      const logPayload = {
        event: 'http_request',
        route: (typeof req.route?.path === 'string' ? req.route.path : undefined) || req.baseUrl || req.path,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      };

      const isOptions = req.method === 'OPTIONS';
      const slowThresholdMs = Number(httpConfig.logSlowMs);
      const debugSampleRate = Number(httpConfig.logDebugSampleRate);
      const quietPrefixes = httpConfig.logQuietPaths.filter(Boolean);
      const isQuiet = quietPrefixes.some((prefix) => req.originalUrl?.startsWith(prefix));
      const shouldSample = debugSampleRate > 0 && Math.random() < debugSampleRate;
      const isSlow = durationMs >= slowThresholdMs;

      if (res.statusCode < 400 && !isSlow && isOptions) {
        return;
      }
      if (res.statusCode < 400 && !isSlow && !isOptions) {
        if (isQuiet && !shouldSample) {
          return;
        }
        if (!isQuiet && debugSampleRate > 0 && !shouldSample) {
          return;
        }
        reqLogger.debug(logPayload, isQuiet ? 'request completed (sampled/quiet)' : 'request completed');
        return;
      }

      if (res.statusCode >= 500) {
        reqLogger.error(logPayload, 'request failed');
      } else if (res.statusCode >= 400) {
        reqLogger.warn(logPayload, 'request completed with client error');
      } else {
        reqLogger.info(logPayload, isSlow ? 'request completed (slow)' : 'request completed');
      }
    });

    next();
  };
};
