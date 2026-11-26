import { vi, describe, it, expect, beforeEach } from 'vitest';

describe('opsMetrics summaries', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('tracks policy resolution metadata and counts', async () => {
    const { opsMetrics } = await import('@/shared/metrics/opsMetrics');
    opsMetrics.recordPolicyResolution('config', 'starter');
    opsMetrics.recordPolicyResolution('runtime', 'pro');
    const snap = opsMetrics.snapshot();
    expect(snap.policyResolutions.samples).toBe(2);
    expect(snap.policyResolutions.last?.source).toBe('runtime');
    expect(snap.policyResolutions.last?.profile).toBe('pro');
    expect(snap.policyResolutions.countsBySource?.config).toBe(1);
    expect(snap.policyResolutions.countsBySource?.runtime).toBe(1);
  });

  it('tracks automation guard outcomes', async () => {
    const { opsMetrics } = await import('@/shared/metrics/opsMetrics');
    opsMetrics.recordAutomationGuard('fired', 1, 2);
    opsMetrics.recordAutomationGuard('exhausted', 3, 0);
    const snap = opsMetrics.snapshot();
    expect(snap.automationGuards.samples).toBe(2);
    expect(snap.automationGuards.last?.status).toContain('exhausted');
    expect(snap.automationGuards.last?.retryCount).toBe(3);
    expect(snap.automationGuards.counts?.fired).toBe(1);
    expect(snap.automationGuards.counts?.exhausted).toBe(1);
  });

  it('tracks session resilience metrics', async () => {
    const { opsMetrics } = await import('@/shared/metrics/opsMetrics');
    opsMetrics.recordCircuitBreakerOpen('s1', 'version_conflict');
    opsMetrics.recordVersionConflict('s1', 'running', 'idle');
    opsMetrics.recordForceRecovery('s1', 'force_recovery_after_version_conflicts');
    opsMetrics.recordQuarantinedSession('s2', 'too_many_conflicts');
    opsMetrics.recordSessionGarbageCollected('s3');

    const snap = opsMetrics.snapshot();
    expect(snap.sessionConflicts.samples).toBe(5);
    expect(snap.sessionConflicts.last?.status).toBe('garbage_collected');
  });
});





