import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
    ERROR_CODES,
    getErrorMetadata,
    isRetryableCode,
    getHttpStatus,
    getUserMessage,
    getErrorCategory,
} from '@null-ai/contracts';
import { AppError, isAppError, hasErrorCode } from '@/domains/agent-brain/domain/errors';
import { ErrorFactory } from '@/domains/agent-brain/domain/errors';
import { toLogSafeError } from '@/shared/errors';

// =============================================================================
// ErrorCode Tests
// =============================================================================

describe('ErrorCode', () => {
    describe('getErrorMetadata', () => {
        it('should return metadata for valid error code', () => {
            const metadata = getErrorMetadata(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED);

            expect(metadata.httpStatus).toBe(429);
            expect(metadata.retryable).toBe(true);
            expect(metadata.userMessage).toContain('rate limit');
        });

        it('should return internal error metadata for unknown code', () => {
            const metadata = getErrorMetadata('unknown.code' as any);

            expect(metadata.httpStatus).toBe(500);
        });
    });

    describe('isRetryableCode', () => {
        it.each([
            [ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED, true],
            [ERROR_CODES.LLM_PROVIDER_UNAVAILABLE, true],
            [ERROR_CODES.NETWORK_TIMEOUT, true],
            [ERROR_CODES.AUTH_INVALID_API_KEY, false],
            [ERROR_CODES.SESSION_NOT_FOUND, false],
            [ERROR_CODES.TOOL_APPROVAL_DENIED, false],
        ])('%s should be retryable=%s', (code, expected) => {
            expect(isRetryableCode(code)).toBe(expected);
        });
    });

    describe('getHttpStatus', () => {
        it.each([
            [ERROR_CODES.AUTH_INVALID_API_KEY, 401],
            [ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, 403],
            [ERROR_CODES.SESSION_NOT_FOUND, 404],
            [ERROR_CODES.SESSION_VERSION_CONFLICT, 409],
            [ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED, 429],
            [ERROR_CODES.INTERNAL_UNEXPECTED, 500],
            [ERROR_CODES.LLM_PROVIDER_UNAVAILABLE, 503],
        ])('%s should have status %d', (code, expected) => {
            expect(getHttpStatus(code)).toBe(expected);
        });
    });

    describe('getErrorCategory', () => {
        it('should extract domain from error code', () => {
            expect(getErrorCategory(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED)).toBe('llm');
            expect(getErrorCategory(ERROR_CODES.SESSION_NOT_FOUND)).toBe('session');
            expect(getErrorCategory(ERROR_CODES.TOOL_APPROVAL_DENIED)).toBe('tool');
        });
    });
});

describe('toLogSafeError', () => {
    it('redacts database parameter payloads from logged error message and stack', () => {
        const raw = 'Failed query: update agent_sessions set metadata=$1\nparams: [{"metadata":{"liveToolStreams":{"wait_for_shell_job":{"result":{"stdout":"scanner-noise"}}}}}]';
        const error = new Error(raw);
        error.stack = `Error: ${raw}\n    at persistMetadata (SessionPersistenceService.ts:1:1)`;

        const safe = toLogSafeError(error);

        expect(safe.message).toContain('params: [redacted]');
        expect(safe.message).not.toContain('scanner-noise');
        expect(safe.stack).toContain('params: [redacted]');
        expect(safe.stack).not.toContain('scanner-noise');
    });
});

// =============================================================================
// AppError Tests
// =============================================================================

describe('AppError', () => {
    describe('constructor', () => {
        it('should create error with code and message', () => {
            const error = new AppError(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED, 'Rate limit hit');

            expect(error.code).toBe(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED);
            expect(error.message).toBe('Rate limit hit');
            expect(error.httpStatus).toBe(429);
            expect(error.retryable).toBe(true);
        });

        it('should include context', () => {
            const error = new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Not found', {
                context: { sessionId: 'abc-123' }
            });

            expect(error.context?.sessionId).toBe('abc-123');
        });

        it('should include retryAfterMs', () => {
            const error = new AppError(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED, 'Wait', {
                retryAfterMs: 5000
            });

            expect(error.retryAfterMs).toBe(5000);
        });

        it('should allow overriding httpStatus', () => {
            const error = new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Custom', {
                httpStatus: 503
            });

            expect(error.httpStatus).toBe(503);
        });
    });

    describe('toJSON', () => {
        it('should serialize error to JSON', () => {
            const error = new AppError(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED, 'Rate limit', {
                retryAfterMs: 5000,
                context: { model: 'gpt-4o', requestId: 'req-123' }
            });

            const json = error.toJSON();

            expect(json.code).toBe('llm.rate_limit_exceeded');
            expect(json.message).toBe('Rate limit');
            expect(json.httpStatus).toBe(429);
            expect(json.retryable).toBe(true);
            expect(json.retryAfterMs).toBe(5000);
            expect(json.requestId).toBe('req-123');
            expect(json.context).toEqual({ model: 'gpt-4o', requestId: 'req-123' });
        });
    });

    describe('toUserResponse', () => {
        it('should return user-safe response', () => {
            const error = new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Database query failed', {
                context: { query: 'SELECT * FROM secrets' }
            });

            const response = error.toUserResponse();

            expect(response.code).toBe(ERROR_CODES.INTERNAL_UNEXPECTED);
            expect(response.userMessage).toBe('An unexpected error occurred. Please try again.');
            expect(response).not.toHaveProperty('context');
            expect(response).not.toHaveProperty('message');
        });
    });

    describe('is', () => {
        it('should check error code', () => {
            const error = new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Not found');

            expect(error.is(ERROR_CODES.SESSION_NOT_FOUND)).toBe(true);
            expect(error.is(ERROR_CODES.SESSION_EXPIRED)).toBe(false);
        });
    });

    describe('inDomain', () => {
        it('should check error domain', () => {
            const error = new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Not found');

            expect(error.inDomain('session')).toBe(true);
            expect(error.inDomain('llm')).toBe(false);
        });
    });

    describe('from', () => {
        it('should return AppError unchanged', () => {
            const original = new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Not found');
            const converted = AppError.from(original);

            expect(converted).toBe(original);
        });

        it('should wrap regular Error', () => {
            const original = new Error('Something went wrong');
            const converted = AppError.from(original);

            expect(converted.code).toBe(ERROR_CODES.INTERNAL_UNEXPECTED);
            expect(converted.message).toBe('Something went wrong');
            expect(converted.cause).toBe(original);
        });

        it('should handle string error', () => {
            const converted = AppError.from('String error');

            expect(converted.message).toBe('String error');
        });
    });
});

// =============================================================================
// Type Guards Tests
// =============================================================================

describe('Type guards', () => {
    describe('isAppError', () => {
        it('should return true for AppError', () => {
            const error = new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Not found');
            expect(isAppError(error)).toBe(true);
        });

        it('should return false for regular Error', () => {
            const error = new Error('Regular error');
            expect(isAppError(error)).toBe(false);
        });
    });

    describe('hasErrorCode', () => {
        it('should return true for matching code', () => {
            const error = new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Not found');
            expect(hasErrorCode(error, ERROR_CODES.SESSION_NOT_FOUND)).toBe(true);
        });

        it('should return false for non-matching code', () => {
            const error = new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Not found');
            expect(hasErrorCode(error, ERROR_CODES.SESSION_EXPIRED)).toBe(false);
        });
    });
});

// =============================================================================
// ErrorFactory Tests
// =============================================================================

describe('ErrorFactory', () => {
    describe('auth', () => {
        it('invalidApiKey should create correct error', () => {
            const error = ErrorFactory.auth.invalidApiKey();
            expect(error.code).toBe(ERROR_CODES.AUTH_INVALID_API_KEY);
            expect(error.httpStatus).toBe(401);
        });

        it('insufficientPermissions should include resource', () => {
            const error = ErrorFactory.auth.insufficientPermissions('admin_panel');
            expect(error.context?.resource).toBe('admin_panel');
        });
    });

    describe('llm', () => {
        it('rateLimitExceeded should include retryAfterMs', () => {
            const error = ErrorFactory.llm.rateLimitExceeded({ retryAfterMs: 5000 });
            expect(error.retryAfterMs).toBe(5000);
        });

        it('contextLengthExceeded should include token counts', () => {
            const error = ErrorFactory.llm.contextLengthExceeded(10000, 8192);
            expect(error.context?.actualTokens).toBe(10000);
            expect(error.context?.maxTokens).toBe(8192);
        });
    });

    describe('session', () => {
        it('notFound should include sessionId', () => {
            const error = ErrorFactory.session.notFound('abc-123');
            expect(error.context?.sessionId).toBe('abc-123');
        });

        it('versionConflict should include versions', () => {
            const error = ErrorFactory.session.versionConflict('abc-123', 5, 3);
            expect(error.context?.expectedVersion).toBe(5);
            expect(error.context?.actualVersion).toBe(3);
        });
    });

    describe('tool', () => {
        it('approvalDenied should include toolName and reason', () => {
            const error = ErrorFactory.tool.approvalDenied('run_command', 'User denied');
            expect(error.context?.toolName).toBe('run_command');
            expect(error.context?.reason).toBe('User denied');
        });
    });

    describe('validation', () => {
        it('missingRequired should include param', () => {
            const error = ErrorFactory.validation.missingRequired('sessionId');
            expect(error.context?.param).toBe('sessionId');
        });

        it('outOfRange should include range details', () => {
            const error = ErrorFactory.validation.outOfRange('count', 1, 100, 150);
            expect(error.context?.min).toBe(1);
            expect(error.context?.max).toBe(100);
            expect(error.context?.actual).toBe(150);
        });
    });
});







