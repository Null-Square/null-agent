import { describe, expect, it } from 'vitest';
import { parseApiError, shouldRetry, ERROR_CODES } from './apiError';

describe('apiError', () => {
  describe('parseApiError', () => {
    it('parses Axios-style errors', () => {
      const err = {
        isAxiosError: true,
        response: { status: 429, data: { error: 'rate_limited' } },
        message: 'Request failed',
      };
      const parsed = parseApiError(err);
      expect(parsed.status).toBe(429);
      expect(parsed.code).toBe(ERROR_CODES.AUTH_RATE_LIMITED_USER);
    });

    it('parses fetch-like errors', () => {
      const err = {
        status: 500,
        statusText: 'Server Error',
        json: async () => ({ error: 'server_error' }),
      };
      const parsed = parseApiError(err);
      expect(parsed.status).toBe(500);
      expect(parsed.code).toBe(ERROR_CODES.INTERNAL_UNEXPECTED);
    });

    it('handles plain Error objects', () => {
      const err = new Error('boom');
      const parsed = parseApiError(err);
      expect(parsed.status).toBe(500);
      expect(parsed.code).toBe(ERROR_CODES.INTERNAL_UNEXPECTED);
    });
  });

  describe('shouldRetry', () => {
    it('retries on 5xx', () => {
      expect(shouldRetry({ status: 500 })).toBe(true);
    });

    it('does not retry on rate limit', () => {
      // Retrying a 429 spends the next window's budget and keeps the caller
      // limited for longer. The rate limit must surface to the UI instead.
      expect(shouldRetry({ status: 429, code: ERROR_CODES.AUTH_RATE_LIMITED_USER })).toBe(false);
    });

    it('does not retry on 4xx client errors', () => {
      expect(shouldRetry({ status: 400 })).toBe(false);
    });
  });
});
