/**
 * Rate Limiting Middleware
 *
 * Fixed-window counters held in memory.
 * Suitable for single-pod deployments; use Redis for multi-pod.
 *
 * Every limiter owns a private bucket namespace, so two limiters with
 * different budgets can never share a counter by accident. Before this was
 * enforced, the 120/min app limiter and the 300/min agent limiter both keyed
 * on the bare client IP and incremented the same number.
 */

import type { RequestHandler } from 'express';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_CLEANUP_MS } from '@/config/timeouts';
import { sendApiError, ERROR_CODES } from '@/shared/errors';

export interface RateLimitOptions {
  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number;
  /** Maximum requests per window (default: 300) */
  max?: number;
  /**
   * Bucket namespace. Limiters sharing a name share a budget; each limiter
   * gets a distinct auto-generated name when this is omitted. Name your
   * limiters — it makes the intent explicit and keeps buckets debuggable.
   */
  name?: string;
  /** Function to generate rate limit key from request */
  keyGenerator?: (req: Parameters<RequestHandler>[0]) => string;
  /** Custom handler for rate-limited requests */
  handler?: RequestHandler;
}

interface Bucket {
  hits: number;
  resetAt: number;
}

const DEFAULT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
const DEFAULT_MAX = 300;
const buckets = new Map<string, Bucket>();

let unnamedLimiterCount = 0;
let lastSweepAt = 0;

/**
 * Reset all rate limit buckets.
 * Useful for testing isolation.
 */
export const resetRateLimitBuckets = (): void => {
  buckets.clear();
  lastSweepAt = 0;
};

/** Bucket count. Exposed for the leak regression test. */
export const rateLimitBucketCount = (): number => buckets.size;

/**
 * Drop expired buckets.
 *
 * Without this the map keeps one permanent entry per unique client IP for the
 * life of the process. Swept inline, at most once per RATE_LIMIT_CLEANUP_MS,
 * so there is no interval timer to leak in tests or hold the process open on
 * shutdown.
 */
const sweepExpired = (now: number): void => {
  if (now - lastSweepAt < RATE_LIMIT_CLEANUP_MS) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
};

const getBucket = (key: string, windowMs: number, now: number): Bucket => {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) {
    return existing;
  }
  const bucket: Bucket = { hits: 0, resetAt: now + windowMs };
  buckets.set(key, bucket);
  return bucket;
};

/**
 * Create rate limiting middleware.
 *
 * Mount each limiter exactly once per request path. Express runs every
 * middleware whose mount path prefixes the request, so gating both `/api/app`
 * and `/api/app/scopes` with the same limiter counts one request twice and
 * silently halves the budget.
 *
 * @example
 * // Basic usage with defaults (300 req/min per IP)
 * router.use(rateLimit({ name: 'my-feature' }));
 *
 * @example
 * // Custom limits
 * router.use(rateLimit({ name: 'my-feature', max: 100, windowMs: 60_000 }));
 *
 * @example
 * // Per-user limiting
 * router.use(rateLimit({
 *   name: 'my-feature',
 *   keyGenerator: (req) => req.user?.id ?? req.ip,
 * }));
 */
export const rateLimit = ({
  windowMs = DEFAULT_WINDOW_MS,
  max = DEFAULT_MAX,
  name,
  keyGenerator = (req) => req.ip || req.socket.remoteAddress || 'anonymous',
  handler,
}: RateLimitOptions = {}): RequestHandler => {
  const namespace = name ?? `unnamed-${(unnamedLimiterCount += 1)}`;

  return (req, res, next) => {
    const now = Date.now();
    sweepExpired(now);

    const key = `${namespace}::${keyGenerator(req)}`;
    const bucket = getBucket(key, windowMs, now);
    bucket.hits += 1;

    const remaining = Math.max(max - bucket.hits, 0);
    const resetSeconds = Math.ceil(bucket.resetAt / 1000);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', resetSeconds.toString(10));

    if (bucket.hits > max) {
      // Retry-After is the honest time until this window resets. Clients must
      // not sleep-and-retry on it (see RETRY_STATUSES in the frontend api
      // client) — it is for telling the user when to try again.
      res.setHeader('Retry-After', retryAfterSeconds.toString());

      if (handler) {
        return handler(req, res, next);
      }

      return sendApiError(res, {
        code: ERROR_CODES.AUTH_RATE_LIMITED_USER,
        message: 'Rate limit exceeded',
        status: 429,
        retryAfterMs: retryAfterSeconds * 1000,
      });
    }

    next();
  };
};
