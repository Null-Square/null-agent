import { describe, it, expect } from 'vitest';
import { ErrorFactory } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';
import { AppError } from '@/domains/agent-brain/domain/errors';

describe('ErrorFactory', () => {
  it('builds auth errors with merged context', () => {
    const err = ErrorFactory.auth.insufficientPermissions('admin', { context: { userId: 'u1' } });

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
    expect(err.message).toContain('admin');
    expect(err.context).toEqual(expect.objectContaining({ userId: 'u1', resource: 'admin' }));
  });

  it('builds LLM errors with token context', () => {
    const err = ErrorFactory.llm.contextLengthExceeded(120, 100);

    expect(err.code).toBe(ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED);
    expect(err.context).toEqual(
      expect.objectContaining({ actualTokens: 120, maxTokens: 100 }),
    );
  });

  it('builds tool errors with reason and context', () => {
    const err = ErrorFactory.tool.approvalDenied('run_command', 'policy', { context: { sessionId: 's1' } });

    expect(err.code).toBe(ERROR_CODES.TOOL_APPROVAL_DENIED);
    expect(err.message).toContain('policy');
    expect(err.context).toEqual(
      expect.objectContaining({ toolName: 'run_command', reason: 'policy', sessionId: 's1' }),
    );
  });

  it('builds validation and resource errors with numeric context', () => {
    const rangeErr = ErrorFactory.validation.outOfRange('limit', 1, 10, 12);
    const quotaErr = ErrorFactory.resource.quotaExceeded('cpu', 10, { retryAfterMs: 5000 });

    expect(rangeErr.code).toBe(ERROR_CODES.VALIDATION_OUT_OF_RANGE);
    expect(rangeErr.context).toEqual(
      expect.objectContaining({ param: 'limit', min: 1, max: 10, actual: 12 }),
    );

    expect(quotaErr.code).toBe(ERROR_CODES.RESOURCE_QUOTA_EXCEEDED);
    expect(quotaErr.retryAfterMs).toBe(5000);
    expect(quotaErr.context).toEqual(expect.objectContaining({ resource: 'cpu', limit: 10 }));
  });

  it('builds network/internal errors and supports fromCode', () => {
    const netErr = ErrorFactory.network.sslError('api.example', 'bad cert');
    const cfgErr = ErrorFactory.internal.configuration('SETTING');
    const fromErr = ErrorFactory.fromCode(
      ERROR_CODES.SESSION_NOT_FOUND,
      'missing',
      { context: { sessionId: 's1' } },
    );

    expect(netErr.code).toBe(ERROR_CODES.NETWORK_SSL_ERROR);
    expect(netErr.context).toEqual(expect.objectContaining({ host: 'api.example', reason: 'bad cert' }));

    expect(cfgErr.code).toBe(ERROR_CODES.INTERNAL_CONFIGURATION);
    expect(cfgErr.context).toEqual(expect.objectContaining({ setting: 'SETTING' }));

    expect(fromErr.code).toBe(ERROR_CODES.SESSION_NOT_FOUND);
    expect(fromErr.message).toBe('missing');
    expect(fromErr.context).toEqual(expect.objectContaining({ sessionId: 's1' }));
  });
});
