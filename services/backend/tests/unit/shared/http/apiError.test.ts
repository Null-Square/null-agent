import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ERROR_CODES, getErrorMetadata } from '@null-ai/contracts';

const mocks = vi.hoisted(() => ({
  uuid: vi.fn(),
}));

let apiError: typeof import('@/shared/http/apiError');

const buildRes = () => ({
  setHeader: vi.fn(),
  status: vi.fn().mockReturnThis(),
  json: vi.fn().mockReturnThis(),
});

describe('apiError helpers', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.uuid.mockReturnValue('req-123');
    vi.doMock('uuid', () => ({ v4: mocks.uuid }));
    apiError = await import('@/shared/http/apiError');
    apiError.configureApiError({ isDev: true });
  });

  afterEach(() => {
    apiError.configureApiError({ isDev: false });
  });

  it('maps codes to status with fallbacks', () => {
    expect(apiError.getStatusForCode(ERROR_CODES.AUTH_INVALID_SESSION)).toBe(401);
    expect(apiError.getStatusForCode('validation.bad')).toBe(400);
    expect(apiError.getStatusForCode('unknown.error')).toBe(500);
  });

  it('creates error bodies with optional details', () => {
    const result = apiError.createApiError({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      message: 'Missing field',
      requestId: 'req-1',
      details: { field: 'name' },
    });

    const metadata = getErrorMetadata(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED);
    expect(result).toEqual({
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      message: 'Missing field',
      httpStatus: metadata.httpStatus,
      userMessage: metadata.userMessage,
      retryable: metadata.retryable,
      requestId: 'req-1',
      context: { field: 'name' },
    });
  });

  it('sends retry-after for rate-limited responses', () => {
    const res = buildRes();

    apiError.sendApiError(res as any, {
      code: ERROR_CODES.AUTH_RATE_LIMITED_USER,
      message: 'Too many requests',
      retryAfterMs: 2500,
    });

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '3');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ERROR_CODES.AUTH_RATE_LIMITED_USER,
        httpStatus: 429,
      }),
    );
  });

  it('handles API errors with explicit codes', () => {
    const res = buildRes();

    apiError.apiErrorHandler(
      Object.assign(new Error('Bad request'), {
        code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        status: 400,
        details: { field: 'name' },
      }),
      { requestId: 'req-123' } as any,
      res as any,
      {} as any,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        requestId: 'req-123',
        context: expect.objectContaining({ details: { field: 'name' } }),
      }),
    );
  });

  it('uses generic messaging for production errors', () => {
    apiError.configureApiError({ isDev: false });
    const res = buildRes();

    apiError.apiErrorHandler(new Error('Sensitive message'), { requestId: 'req-999' } as any, res as any, {} as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'An unexpected error occurred. Please try again.',
      }),
    );
  });

  it('identifies api error bodies', () => {
    expect(apiError.isApiError({ code: 'x', message: 'y', httpStatus: 500 })).toBe(true);
    expect(apiError.isApiError({ ok: true })).toBe(false);
  });
});
