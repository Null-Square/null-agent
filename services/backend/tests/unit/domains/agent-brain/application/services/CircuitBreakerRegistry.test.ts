import { describe, it, expect, afterEach } from 'vitest';
import { circuitBreakerRegistry, CircuitState } from '@/domains/agent-brain/application/services/CircuitBreaker';

describe('CircuitBreakerRegistry', () => {
  afterEach(() => {
    circuitBreakerRegistry.shutdown();
  });

  it('creates and reuses breakers by name', () => {
    const first = circuitBreakerRegistry.get('svcA');
    const second = circuitBreakerRegistry.get('svcA');

    expect(first).toBe(second);
    expect(circuitBreakerRegistry.has('svcA')).toBe(true);
    expect(circuitBreakerRegistry.list()).toContain('svcA');
  });

  it('resets all breakers to closed state', () => {
    const breaker = circuitBreakerRegistry.get('svcB', { failureThreshold: 1, resetTimeoutMs: 100 });

    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    circuitBreakerRegistry.resetAll();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('shutdown clears breakers and timers', () => {
    circuitBreakerRegistry.get('svcC');
    circuitBreakerRegistry.shutdown();

    expect(circuitBreakerRegistry.has('svcC')).toBe(false);
    expect(circuitBreakerRegistry.list()).toHaveLength(0);

    const rebuilt = circuitBreakerRegistry.get('svcC');
    expect(rebuilt).toBeDefined();
  });
});







