import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { withToolRetry, isRetryableToolError, retryable } from '@/domains/agent-brain/application/tools';

// =============================================================================
// Tests
// =============================================================================

describe('ToolRetryPolicy', () => {
    describe('isRetryableToolError', () => {
        it.each([
            'ECONNRESET',
            'ECONNREFUSED',
            'ETIMEDOUT',
            'socket hang up',
            'network error',
            '429 Too Many Requests',
            'rate limit exceeded',
            '503 Service Unavailable',
            '502 Bad Gateway',
            '504 Gateway Timeout',
            'temporary error occurred',
        ])('should return true for retryable error: %s', (message) => {
            expect(isRetryableToolError(new Error(message))).toBe(true);
        });

        it.each([
            'File not found',
            'Permission denied',
            'Invalid argument',
            '401 Unauthorized',
            '403 Forbidden',
            '404 Not Found',
        ])('should return false for non-retryable error: %s', (message) => {
            expect(isRetryableToolError(new Error(message))).toBe(false);
        });

        it('should return false for null/undefined', () => {
            expect(isRetryableToolError(null)).toBe(false);
            expect(isRetryableToolError(undefined)).toBe(false);
        });
    });

    describe('withToolRetry', () => {
        it('should return result on first successful attempt', async () => {
            const fn = vi.fn().mockResolvedValue({ ok: true, data: 'success' });
            const result = await withToolRetry(fn, { toolName: 'test_tool' });
            expect(result).toEqual({ ok: true, data: 'success' });
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should retry on retryable error and succeed', async () => {
            const fn = vi.fn()
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValueOnce({ ok: true });

            const result = await withToolRetry(fn, {
                maxRetries: 2,
                baseDelayMs: 10,
                toolName: 'test_tool'
            });
            expect(result).toEqual({ ok: true });
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should throw after max retries exhausted', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

            await expect(withToolRetry(fn, {
                maxRetries: 2,
                baseDelayMs: 10,
                toolName: 'test_tool'
            })).rejects.toThrow('ECONNRESET');
            expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
        });

        it('should not retry on non-retryable errors', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('Permission denied'));

            await expect(withToolRetry(fn, { toolName: 'test_tool' }))
                .rejects.toThrow('Permission denied');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should abort immediately when signal is aborted', async () => {
            const controller = new AbortController();
            controller.abort();

            const fn = vi.fn().mockResolvedValue({ ok: true });

            await expect(withToolRetry(fn, { signal: controller.signal }))
                .rejects.toThrow('Aborted');
            expect(fn).not.toHaveBeenCalled();
        });
    });

    describe('retryable decorator', () => {
        it('should create a retryable version of a function', async () => {
            const originalFn = vi.fn()
                .mockRejectedValueOnce(new Error('rate limit'))
                .mockResolvedValueOnce('success');

            const retryableFn = retryable(originalFn, {
                maxRetries: 2,
                baseDelayMs: 10,
                toolName: 'decorated_tool'
            });

            const result = await retryableFn('arg1', 'arg2');
            expect(result).toBe('success');
            expect(originalFn).toHaveBeenCalledTimes(2);
            expect(originalFn).toHaveBeenCalledWith('arg1', 'arg2');
        });
    });
});







