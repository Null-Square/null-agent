import { vi, describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitState } from '@/domains/agent-brain/application/services/CircuitBreaker';

describe('CircuitBreaker', () => {
  it('opens after reaching failure threshold and exposes retryAfter', () => {
    vi.useFakeTimers();

    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });

    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.getRetryAfterMs()).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it('transitions to HALF_OPEN after reset timeout and closes on successes', () => {
    vi.useFakeTimers();

    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      resetTimeoutMs: 1000,
    });

    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(1000);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    vi.useRealTimers();
  });

  it('reopens when failure occurs in HALF_OPEN', () => {
    vi.useFakeTimers();

    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
    });

    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(1000);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    vi.useRealTimers();
  });

  it('execute short-circuits when open', async () => {
    vi.useFakeTimers();

    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

    // Trip the breaker
    await expect(
      breaker.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');

    expect(breaker.isOpen()).toBe(true);

    // Immediately calling execute should throw CircuitOpenError without invoking fn
    await expect(
      breaker.execute(async () => {
        throw new Error('should not run');
      }),
    ).rejects.toThrow('Circuit');

    vi.useRealTimers();
  });
});







