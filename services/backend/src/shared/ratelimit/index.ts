/**
 * Rate Limiting Utilities
 * 
 * Shared rate limiting middleware for API endpoints.
 * 
 * @example
 * import { rateLimit, createUserRateLimiter } from '@/shared/ratelimit';
 * 
 * // Basic usage
 * router.use(rateLimit({ max: 100 }));
 * 
 * // Preset for authenticated routes
 * router.use(createUserRateLimiter(100));
 */

export {
  rateLimit,
  resetRateLimitBuckets,
  rateLimitBucketCount,
  type RateLimitOptions,
} from './rateLimit';

export {
  createUserRateLimiter,
  createIpRateLimiter,
  createStrictRateLimiter,
  createApiKeyRateLimiter,
} from './presets';

export {
  API_RATE_LIMIT_POLICIES,
  createApiTrafficClassLimiters,
} from './apiTrafficClasses';
