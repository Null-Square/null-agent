import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
    TokenBucketRateLimiter,
    createUserRateLimiter,
    createSessionRateLimiter,
    createLLMRateLimiter
} from '@/domains/agent-brain/application/services/TokenBucketRateLimiter';

// =============================================================================
// Tests
// =============================================================================

describe('TokenBucketRateLimiter', () => {
    let limiter: TokenBucketRateLimiter;

    afterEach(() => {
        limiter?.shutdown();
    });

    describe('consume', () => {
        it('should allow requests when tokens available', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });
            const result = limiter.consume('user-1');

            expect(result.allowed).toBe(true);
            expect(result.tokensRemaining).toBe(9);
        });

        it('should deny requests when tokens exhausted', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 2 });

            limiter.consume('user-1');
            limiter.consume('user-1');
            const result = limiter.consume('user-1');

            expect(result.allowed).toBe(false);
            expect(result.tokensRemaining).toBe(0);
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });

        it('should track separate buckets per key', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });

            limiter.consume('user-1');
            limiter.consume('user-1');
            const result1 = limiter.consume('user-1');
            const result2 = limiter.consume('user-2');

            expect(result1.tokensRemaining).toBe(7);
            expect(result2.tokensRemaining).toBe(9);
        });

        it('should consume multiple tokens at once', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });
            const result = limiter.consume('user-1', 5);

            expect(result.allowed).toBe(true);
            expect(result.tokensRemaining).toBe(5);
        });

        it('should deny when requesting more tokens than available', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 5 });
            const result = limiter.consume('user-1', 10);

            expect(result.allowed).toBe(false);
        });
    });

    describe('token refill', () => {
        it('should refill tokens over time', async () => {
            limiter = new TokenBucketRateLimiter({
                maxTokens: 5,
                refillRate: 2,
                refillIntervalMs: 50
            });

            // Consume all tokens
            limiter.consume('user-1', 5);
            expect(limiter.getTokens('user-1').tokens).toBe(0);

            // Wait for refill
            await new Promise(resolve => setTimeout(resolve, 60));

            // Should have refilled
            const tokens = limiter.getTokens('user-1');
            expect(tokens.tokens).toBeGreaterThan(0);
        });

        it('should not exceed maxTokens', async () => {
            limiter = new TokenBucketRateLimiter({
                maxTokens: 5,
                refillRate: 10,
                refillIntervalMs: 10
            });

            // Wait for multiple refill intervals
            await new Promise(resolve => setTimeout(resolve, 100));

            const tokens = limiter.getTokens('user-1');
            expect(tokens.tokens).toBe(5);
        });
    });

    describe('canConsume', () => {
        it('should return true when tokens available', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });
            expect(limiter.canConsume('user-1')).toBe(true);
        });

        it('should return false when tokens exhausted', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 2 });
            limiter.consume('user-1', 2);
            expect(limiter.canConsume('user-1')).toBe(false);
        });

        it('should not consume tokens', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });
            limiter.canConsume('user-1');
            limiter.canConsume('user-1');

            const result = limiter.consume('user-1');
            expect(result.tokensRemaining).toBe(9); // Only consumed 1
        });
    });

    describe('getTokens', () => {
        it('should return maxTokens for new key', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });
            const tokens = limiter.getTokens('new-user');

            expect(tokens.tokens).toBe(10);
            expect(tokens.maxTokens).toBe(10);
        });

        it('should return current tokens for existing key', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });
            limiter.consume('user-1', 3);

            const tokens = limiter.getTokens('user-1');
            expect(tokens.tokens).toBe(7);
        });
    });

    describe('reset', () => {
        it('should reset a bucket', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });
            limiter.consume('user-1', 8);

            expect(limiter.getTokens('user-1').tokens).toBe(2);

            limiter.reset('user-1');

            expect(limiter.getTokens('user-1').tokens).toBe(10);
        });
    });

    describe('bucketCount', () => {
        it('should track number of active buckets', () => {
            limiter = new TokenBucketRateLimiter({ maxTokens: 10 });

            expect(limiter.bucketCount).toBe(0);

            limiter.consume('user-1');
            limiter.consume('user-2');
            limiter.consume('user-3');

            expect(limiter.bucketCount).toBe(3);
        });
    });
});

describe('Factory functions', () => {
    it('createUserRateLimiter should create user limiter', () => {
        const limiter = createUserRateLimiter();
        expect(limiter).toBeInstanceOf(TokenBucketRateLimiter);

        const tokens = limiter.getTokens('test');
        expect(tokens.maxTokens).toBe(60);
        limiter.shutdown();
    });

    it('createSessionRateLimiter should create session limiter', () => {
        const limiter = createSessionRateLimiter();
        expect(limiter).toBeInstanceOf(TokenBucketRateLimiter);

        const tokens = limiter.getTokens('test');
        expect(tokens.maxTokens).toBe(30);
        limiter.shutdown();
    });

    it('createLLMRateLimiter should create LLM limiter', () => {
        const limiter = createLLMRateLimiter();
        expect(limiter).toBeInstanceOf(TokenBucketRateLimiter);

        const tokens = limiter.getTokens('test');
        expect(tokens.maxTokens).toBe(10);
        limiter.shutdown();
    });
});







