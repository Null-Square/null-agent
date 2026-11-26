import { logger as appLogger } from '@/shared/logger';
import { RATE_LIMIT_CLEANUP_MS, RATE_LIMIT_STALE_MS } from '@/config/timeouts';

/**
 * Token bucket rate limiter configuration.
 */
export interface TokenBucketConfig {
    /** Maximum tokens in the bucket. Default: 100 */
    maxTokens?: number;
    /** Tokens to refill per interval. Default: 10 */
    refillRate?: number;
    /** Refill interval in milliseconds. Default: 1000 (1 second) */
    refillIntervalMs?: number;
    /** Initial tokens. Default: maxTokens */
    initialTokens?: number;
}

/**
 * Rate limit result with metadata.
 */
export interface RateLimitResult {
    allowed: boolean;
    tokensRemaining: number;
    retryAfterMs?: number;
    resetAtMs: number;
}

interface Bucket {
    tokens: number;
    lastRefillAt: number;
}

const logger = appLogger.child({ scope: 'RateLimiter' });

/**
 * In-memory Token Bucket Rate Limiter.
 * 
 * The token bucket algorithm allows bursts while enforcing
 * a sustainable long-term rate. Tokens are added at a fixed
 * rate, and each request consumes one token.
 * 
 * For distributed systems, this can be extended to use Redis.
 */
export class TokenBucketRateLimiter {
    private readonly maxTokens: number;
    private readonly refillRate: number;
    private readonly refillIntervalMs: number;
    private readonly buckets = new Map<string, Bucket>();
    private cleanupInterval?: NodeJS.Timeout;

    constructor(config: TokenBucketConfig = {}) {
        this.maxTokens = config.maxTokens ?? 100;
        this.refillRate = config.refillRate ?? 10;
        this.refillIntervalMs = config.refillIntervalMs ?? 1000;

        // Cleanup stale buckets every 5 minutes
        this.cleanupInterval = setInterval(() => this.cleanupStaleBuckets(), RATE_LIMIT_CLEANUP_MS);
    }

    /**
     * Try to consume a token for the given key.
     * 
     * @param key - Unique identifier (userId, sessionId, IP, etc.)
     * @param tokens - Number of tokens to consume. Default: 1
     * @returns Rate limit result with remaining tokens
     */
    consume(key: string, tokens = 1): RateLimitResult {
        const now = Date.now();
        let bucket = this.buckets.get(key);

        if (!bucket) {
            bucket = {
                tokens: this.maxTokens,
                lastRefillAt: now,
            };
            this.buckets.set(key, bucket);
        }

        // Refill tokens based on elapsed time
        const elapsed = now - bucket.lastRefillAt;
        const intervalsElapsed = Math.floor(elapsed / this.refillIntervalMs);

        if (intervalsElapsed > 0) {
            bucket.tokens = Math.min(
                this.maxTokens,
                bucket.tokens + intervalsElapsed * this.refillRate
            );
            bucket.lastRefillAt = now;
        }

        // Calculate reset time (when bucket will be full)
        const tokensNeeded = this.maxTokens - bucket.tokens;
        const intervalsToFull = Math.ceil(tokensNeeded / this.refillRate);
        const resetAtMs = now + intervalsToFull * this.refillIntervalMs;

        // Try to consume
        if (bucket.tokens >= tokens) {
            bucket.tokens -= tokens;
            return {
                allowed: true,
                tokensRemaining: bucket.tokens,
                resetAtMs,
            };
        }

        // Not enough tokens - calculate retry time
        const tokensShort = tokens - bucket.tokens;
        const intervalsNeeded = Math.ceil(tokensShort / this.refillRate);
        const retryAfterMs = intervalsNeeded * this.refillIntervalMs;

        logger.debug(
            { key, tokensRemaining: bucket.tokens, tokensRequested: tokens, retryAfterMs },
            'Rate limit exceeded'
        );

        return {
            allowed: false,
            tokensRemaining: bucket.tokens,
            retryAfterMs,
            resetAtMs,
        };
    }

    /**
     * Check if a request would be allowed without consuming.
     */
    canConsume(key: string, tokens = 1): boolean {
        const bucket = this.buckets.get(key);
        if (!bucket) return true;

        // Calculate current tokens after refill
        const now = Date.now();
        const elapsed = now - bucket.lastRefillAt;
        const intervalsElapsed = Math.floor(elapsed / this.refillIntervalMs);
        const currentTokens = Math.min(
            this.maxTokens,
            bucket.tokens + intervalsElapsed * this.refillRate
        );

        return currentTokens >= tokens;
    }

    /**
     * Get token information for a key.
     */
    getTokens(key: string): { tokens: number; maxTokens: number } {
        const bucket = this.buckets.get(key);
        if (!bucket) {
            return { tokens: this.maxTokens, maxTokens: this.maxTokens };
        }

        // Calculate current tokens after refill
        const now = Date.now();
        const elapsed = now - bucket.lastRefillAt;
        const intervalsElapsed = Math.floor(elapsed / this.refillIntervalMs);
        const currentTokens = Math.min(
            this.maxTokens,
            bucket.tokens + intervalsElapsed * this.refillRate
        );

        return { tokens: currentTokens, maxTokens: this.maxTokens };
    }

    /**
     * Reset a specific key's bucket.
     */
    reset(key: string): void {
        this.buckets.delete(key);
    }

    /**
     * Clean up stale buckets (full buckets that haven't been used).
     */
    private cleanupStaleBuckets(): void {
        const now = Date.now();
        const staleThreshold = RATE_LIMIT_STALE_MS;
        let cleaned = 0;

        for (const [key, bucket] of this.buckets) {
            const elapsed = now - bucket.lastRefillAt;
            // Remove if not accessed for threshold and would be full
            if (elapsed > staleThreshold) {
                this.buckets.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.debug({ cleanedBuckets: cleaned }, 'Cleaned stale rate limit buckets');
        }
    }

    /**
     * Shutdown the rate limiter.
     */
    shutdown(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }
        this.buckets.clear();
    }

    /**
     * Get current bucket count (for monitoring).
     */
    get bucketCount(): number {
        return this.buckets.size;
    }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a rate limiter for user-level throttling.
 * Allows 60 requests per minute with bursts up to 20.
 */
export function createUserRateLimiter(): TokenBucketRateLimiter {
    return new TokenBucketRateLimiter({
        maxTokens: 60,
        refillRate: 1,
        refillIntervalMs: 1000, // 1 token per second
    });
}

/**
 * Create a rate limiter for session-level throttling.
 * Allows 30 requests per minute with bursts up to 10.
 */
export function createSessionRateLimiter(): TokenBucketRateLimiter {
    return new TokenBucketRateLimiter({
        maxTokens: 30,
        refillRate: 1,
        refillIntervalMs: 2000, // 1 token per 2 seconds
    });
}

/**
 * Create a rate limiter for LLM API calls.
 * Stricter limits to control costs.
 */
export function createLLMRateLimiter(): TokenBucketRateLimiter {
    return new TokenBucketRateLimiter({
        maxTokens: 10,
        refillRate: 1,
        refillIntervalMs: 3000, // 1 token per 3 seconds (~20 calls/min)
    });
}
