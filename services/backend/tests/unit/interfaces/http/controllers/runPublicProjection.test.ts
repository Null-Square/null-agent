import { describe, expect, it } from 'vitest';

import {
  customerRunnerName,
  schedulingProjection,
  withRunUiFlags,
} from '@/interfaces/http/controllers/runPublicProjection';

describe('public Run scheduling projection', () => {
  it('exposes a safe queued state without platform ownership or scheduler internals', () => {
    const raw = {
      id: 'run-1',
      sessionId: null,
      goal: 'Assess the target',
      status: 'queued',
      executionTarget: 'cloud',
      runnerId: 'platform-runner-1',
      capacityWaitReason: 'runner_host_memory_pressure:secret-host',
      queuedAt: new Date('2026-08-01T12:00:00.000Z'),
      claimOwner: 'scheduler-host-1',
      claimExpiresAt: new Date(),
      admissionEpoch: 3,
      launchPayload: { secret: true },
      capacityProfile: 'heavy',
      capacityProfileVersion: 1,
      admissionLastError: 'internal launch details',
      missionEnvelope: { internal: true },
    };

    const projected = withRunUiFlags(raw);

    expect(projected).toMatchObject({
      id: 'run-1',
      sessionId: null,
      activeSessionId: null,
      status: 'queued',
      runnerId: null,
      capacityWaitReason: 'waiting_for_capacity',
    });
    for (const key of [
      'claimOwner',
      'claimExpiresAt',
      'admissionEpoch',
      'launchPayload',
      'capacityProfile',
      'capacityProfileVersion',
      'admissionLastError',
      'missionEnvelope',
    ]) {
      expect(projected).not.toHaveProperty(key);
    }
    expect(customerRunnerName(raw, 'secret-host')).toBeNull();
    expect(schedulingProjection(raw)).toEqual({
      state: 'preparing',
      reason: 'waiting_for_capacity',
      submittedAt: raw.queuedAt,
      estimatedStart: null,
    });
  });
});
