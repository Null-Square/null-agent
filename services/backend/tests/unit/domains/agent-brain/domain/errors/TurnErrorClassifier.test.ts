import { describe, it, expect } from 'vitest';
import { classifyTurnError } from '@/domains/agent-brain/domain/errors';
import { CircuitOpenError } from '@/domains/agent-brain/application/services/CircuitBreaker';
import { ERROR_CODES } from '@null-ai/contracts';

describe('TurnErrorClassifier', () => {
  it('maps circuit open errors to provider_unavailable', () => {
    const err = new CircuitOpenError('llm:openai', 5000);

    const appError = classifyTurnError(err, { sessionId: 's2' });

    expect(appError.code).toBe(ERROR_CODES.LLM_PROVIDER_UNAVAILABLE);
    expect(appError.retryable).toBe(true);
    expect(appError.retryAfterMs).toBe(5000);
    expect(appError.context?.provider).toBe('openai');
  });

  it('wraps unknown errors as internal unexpected with context', () => {
    const err = new Error('boom');

    const appError = classifyTurnError(err, { sessionId: 's1', model: 'gpt-4' });

    expect(appError.code).toBe(ERROR_CODES.INTERNAL_UNEXPECTED);
    expect(appError.context?.sessionId).toBe('s1');
    expect(appError.context?.model).toBe('gpt-4');
    expect(appError.context?.errorName).toBe('Error');
  });
});
