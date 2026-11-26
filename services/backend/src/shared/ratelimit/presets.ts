/**
 * Rate Limiter Presets
 * 
 * Pre-configured rate limiters for common use cases.
 */

import { RATE_LIMIT_WINDOW_MS } from '@/config/timeouts';
import { rateLimit } from './rateLimit';

/**
 * Per-user rate limiter.
 * Uses authenticated userId, falls back to IP for unauthenticated requests.
 * 
 * @param max - Maximum requests per window (default: 100)
 * @param windowMs - Window duration in ms (default: 60000 = 1 min)
 * 
 * @example
 * router.use(createUserRateLimiter(100)); // 100 req/min per user
 */
export const createUserRateLimiter = (max = 100, windowMs = RATE_LIMIT_WINDOW_MS) =>
  rateLimit({
    max,
    windowMs,
    keyGenerator: (req) => {
      // Try various places where userId might be stored
      const userId = req.user?.id ?? req.userId ?? req.auth?.userId;
      if (userId) return `user:${userId}`;
      return `ip:${req.ip || req.socket.remoteAddress || 'anonymous'}`;
    },
  });

/**
 * Per-IP rate limiter.
 * For public endpoints or unauthenticated routes.
 * 
 * @param max - Maximum requests per window (default: 60)
 * @param windowMs - Window duration in ms (default: 60000 = 1 min)
 * 
 * @example
 * router.use(createIpRateLimiter(30)); // 30 req/min per IP
 */
export const createIpRateLimiter = (max = 60, windowMs = RATE_LIMIT_WINDOW_MS) =>
  rateLimit({
    max,
    windowMs,
    keyGenerator: (req) => `ip:${req.ip || req.socket.remoteAddress || 'anonymous'}`,
  });

/**
 * Strict rate limiter for sensitive endpoints.
 * Low limits for endpoints like login, password reset, etc.
 * 
 * @param max - Maximum requests per window (default: 10)
 * @param windowMs - Window duration in ms (default: 60000 = 1 min)
 * 
 * @example
 * router.post('/login', createStrictRateLimiter(5), loginHandler);
 */
export const createStrictRateLimiter = (max = 10, windowMs = RATE_LIMIT_WINDOW_MS) =>
  rateLimit({
    max,
    windowMs,
    keyGenerator: (req) => `strict:${req.ip || req.socket.remoteAddress || 'anonymous'}`,
  });

/**
 * API key rate limiter.
 * For external API consumers using API keys.
 * 
 * @param max - Maximum requests per window (default: 1000)
 * @param windowMs - Window duration in ms (default: 60000 = 1 min)
 */
export const createApiKeyRateLimiter = (max = 1000, windowMs = RATE_LIMIT_WINDOW_MS) =>
  rateLimit({
    max,
    windowMs,
    keyGenerator: (req) => {
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      if (apiKey && typeof apiKey === 'string') return `apikey:${apiKey.slice(0, 16)}`;
      return `ip:${req.ip || req.socket.remoteAddress || 'anonymous'}`;
    },
  });
