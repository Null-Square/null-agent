import { describe, it, expect, beforeEach, vi } from 'vitest';
import { opsMetrics } from '@/shared/metrics/opsMetrics';

const mocks = vi.hoisted(() => ({
  resolvePolicy: vi.fn(),
  invalidateCache: vi.fn(),
  resolveCapabilityProfile: vi.fn(),
}));

vi.mock('@/domains/agent-brain/domain/policy/brainPolicyRuntimeService', () => ({
  createBrainPolicyRuntimeService: () => ({
    resolvePolicy: (...args: any[]) => mocks.resolvePolicy(...args),
    invalidateCache: mocks.invalidateCache,
  }),
}));

vi.mock('@/domains/agent-brain/adapters/sandbox', () => ({
  resolveCapabilityProfile: (...args: any[]) => mocks.resolveCapabilityProfile(...args),
}));

import { PolicyEngine } from '@/domains/agent-brain/application/services/PolicyEngine';

describe('PolicyEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records metrics and telemetry on policy resolution', async () => {
    const telemetry = { policyResolved: vi.fn() };
    const resolver = { resetCache: vi.fn() } as any;
    const recordSpy = vi.spyOn(opsMetrics, 'recordPolicyResolution');
    mocks.resolvePolicy.mockResolvedValue({
      id: 'policy-1',
      profile: 'default',
      sandboxProfile: 'default',
      source: 'default',
    });

    const facade = new PolicyEngine(undefined, resolver, telemetry as any);
    const result = await facade.resolveBrainPolicy();

    expect(result?.profile).toBe('default');
    expect(recordSpy).toHaveBeenCalledWith('default', 'default');
    expect(telemetry.policyResolved).toHaveBeenCalledWith('default', 'default');
  });

  it('skips metrics when policy resolution returns null', async () => {
    const resolver = { resetCache: vi.fn() } as any;
    const recordSpy = vi.spyOn(opsMetrics, 'recordPolicyResolution');
    mocks.resolvePolicy.mockResolvedValue(null);

    const facade = new PolicyEngine(undefined, resolver);
    const result = await facade.resolveBrainPolicy();

    expect(result).toBeNull();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('resets resolver and runtime caches', () => {
    const resolver = { resetCache: vi.fn() } as any;
    const facade = new PolicyEngine(undefined, resolver);

    facade.resetCache();

    expect(resolver.resetCache).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('delegates sandbox capability resolution', async () => {
    const resolver = { resetCache: vi.fn() } as any;
    mocks.resolveCapabilityProfile.mockResolvedValue({ profile: 'default' });
    const facade = new PolicyEngine(undefined, resolver);

    const resolved = await facade.resolveSandboxCapabilities('default');

    expect(mocks.resolveCapabilityProfile).toHaveBeenCalledWith('default', undefined, resolver);
    expect(resolved).toEqual({ profile: 'default' });
  });

  it('returns empty capability results when profile is unknown', async () => {
    const resolver = { resetCache: vi.fn() } as any;
    mocks.resolveCapabilityProfile.mockResolvedValue(null);
    const facade = new PolicyEngine(undefined, resolver);

    const resolved = await facade.resolveSandboxCapabilities('missing');

    expect(resolved).toBeNull();
  });
});

