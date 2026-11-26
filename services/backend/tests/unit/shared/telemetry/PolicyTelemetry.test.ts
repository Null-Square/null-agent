import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpsPolicyTelemetry } from '@/shared/telemetry/PolicyTelemetry';

const mocks = vi.hoisted(() => ({
  recordPolicyResolution: vi.fn(),
  recordAutomationGuard: vi.fn(),
}));

vi.mock('@/shared/metrics/opsMetrics', () => ({
  opsMetrics: {
    recordPolicyResolution: (...args: any[]) => mocks.recordPolicyResolution(...args),
    recordAutomationGuard: (...args: any[]) => mocks.recordAutomationGuard(...args),
  },
}));

describe('OpsPolicyTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records policy resolution events', () => {
    const telemetry = new OpsPolicyTelemetry();

    telemetry.policyResolved('config', 'default');

    expect(mocks.recordPolicyResolution).toHaveBeenCalledWith('config', 'default');
  });

  it('records automation guard status with defaults', () => {
    const telemetry = new OpsPolicyTelemetry();

    telemetry.automationGuard('fired');

    expect(mocks.recordAutomationGuard).toHaveBeenCalledWith('fired', 0, 0);
  });

  it('records automation guard status with explicit values', () => {
    const telemetry = new OpsPolicyTelemetry();

    telemetry.automationGuard('exhausted', 2, 5);

    expect(mocks.recordAutomationGuard).toHaveBeenCalledWith('exhausted', 2, 5);
  });
});
