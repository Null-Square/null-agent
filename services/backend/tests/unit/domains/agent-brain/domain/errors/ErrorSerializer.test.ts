import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorSerializer } from '@/domains/agent-brain/domain/errors';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES, getErrorMetadata } from '@null-ai/contracts';

describe('ErrorSerializer', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = originalEnv;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('serializes AppError with request id and param (API response)', () => {
    const error = new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'missing', {
      retryAfterMs: 500,
      context: { param: 'name' },
    });

    const result = ErrorSerializer.toApiResponse(error, 'req-123');

    expect(result).toEqual({
      code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
      message: 'missing',
      httpStatus: error.httpStatus,
      userMessage: error.userMessage,
      retryable: error.retryable,
      retryAfterMs: 500,
      requestId: 'req-123',
      context: { param: 'name' },
    });
  });

  it('serializes AppError with user-safe message (user response)', () => {
    const error = new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'bad', {
      retryAfterMs: 1000,
    });

    const result = ErrorSerializer.toUserResponse(error, 'req-456');

    expect(result).toEqual({
      code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
      message: error.userMessage,
      httpStatus: error.httpStatus,
      userMessage: error.userMessage,
      retryable: error.retryable,
      retryAfterMs: 1000,
      requestId: 'req-456',
    });
  });

  it('serializes unknown errors with internal codes', () => {
    const result = ErrorSerializer.toApiResponse(new Error('boom'));

    expect(result.code).toBe(ERROR_CODES.INTERNAL_UNEXPECTED);
    expect(result.message).toBe('boom');
    expect(result.retryable).toBe(true);
  });

  it('hides unknown error details in production user response', () => {
    const metadata = getErrorMetadata(ERROR_CODES.INTERNAL_UNEXPECTED);
    const result = ErrorSerializer.toUserResponse('boom', 'req-789');

    expect(result).toEqual({
      code: ERROR_CODES.INTERNAL_UNEXPECTED,
      message: metadata.userMessage,
      httpStatus: metadata.httpStatus,
      userMessage: metadata.userMessage,
      retryable: metadata.retryable,
      requestId: 'req-789',
    });
  });

  it('resolves HTTP status from AppError or status fields', () => {
    const appError = new AppError(ERROR_CODES.VALIDATION_OUT_OF_RANGE, 'bad');

    expect(ErrorSerializer.getHttpStatus(appError)).toBe(appError.httpStatus);
    expect(ErrorSerializer.getHttpStatus({ status: 404 })).toBe(404);
    expect(ErrorSerializer.getHttpStatus({ statusCode: 503 })).toBe(503);
    expect(ErrorSerializer.getHttpStatus('boom')).toBe(500);
  });

  it('selects response format based on NODE_ENV', () => {
    const error = new AppError(ERROR_CODES.VALIDATION_INVALID_JSON, 'bad json');

    process.env.NODE_ENV = 'development';
    const devResult = ErrorSerializer.serialize(error, 'req-dev', { isDev: true });
    expect(devResult.message).toBe('bad json');

    process.env.NODE_ENV = 'production';
    const prodResult = ErrorSerializer.serialize(error, 'req-prod', { isDev: false });
    expect(prodResult.message).toBe(error.userMessage);
  });
});
