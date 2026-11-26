import { describe, expect, it, vi } from 'vitest';

import { WorkerDelegationService } from '@/domains/agent-brain/application/services/WorkerDelegationService';

describe('enumeration worker mission reservation', () => {
  it('uses the session compare-and-set and only lets the reservation owner release it', async () => {
    const parent: any = {
      id: 'parent',
      coordination: { role: 'direct' },
      workerTasks: [],
    };
    const store = {
      get: vi.fn(() => parent),
      updateSessionAsync: vi.fn(async (
        _sessionId: string,
        mutator: (session: typeof parent) => unknown,
      ) => mutator(parent)),
    } as any;
    const service = new WorkerDelegationService(store);
    const reserve = (service as any).reserveEnumerationMissionFingerprint.bind(service);
    const release = (service as any).releaseEnumerationMissionReservation.bind(service);
    const fingerprint = 'a'.repeat(64);

    const results = await Promise.allSettled([
      reserve('parent', fingerprint, 'task-1'),
      reserve('parent', fingerprint, 'task-2'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(parent.coordination.enumerationMissionReservations[fingerprint].taskId).toBe('task-1');

    await release('parent', fingerprint, 'task-2');
    expect(parent.coordination.enumerationMissionReservations[fingerprint].taskId).toBe('task-1');
    await release('parent', fingerprint, 'task-1');
    expect(parent.coordination.enumerationMissionReservations).toBeUndefined();
  });

  it('reserves distinct missions concurrently with no credit state: Null AI charges nothing', async () => {
    const parent: any = {
      id: 'parent',
      flags: {},
      coordination: { role: 'direct' },
      workerTasks: [],
    };
    const store = {
      get: vi.fn(() => parent),
      updateSessionAsync: vi.fn(async (
        _sessionId: string,
        mutator: (session: typeof parent) => unknown,
      ) => mutator(parent)),
    } as any;
    const service = new WorkerDelegationService(store);
    const reserve = (service as any).reserveEnumerationMissionFingerprint.bind(service);

    const results = await Promise.allSettled([
      reserve('parent', 'a'.repeat(64), 'task-1'),
      reserve('parent', 'b'.repeat(64), 'task-2'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(Object.keys(parent.coordination.enumerationMissionReservations)).toHaveLength(2);
  });

  it('counts in-flight mission reservations against the active worker cap', async () => {
    const parent: any = {
      id: 'parent',
      flags: {
        securityops: { maxActiveWorkers: 1 },
      },
      coordination: { role: 'direct' },
      workerTasks: [],
    };
    const store = {
      get: vi.fn(() => parent),
      updateSessionAsync: vi.fn(async (
        _sessionId: string,
        mutator: (session: typeof parent) => unknown,
      ) => mutator(parent)),
    } as any;
    const service = new WorkerDelegationService(store);
    const reserve = (service as any).reserveEnumerationMissionFingerprint.bind(service);

    const results = await Promise.allSettled([
      reserve('parent', 'a'.repeat(64), 'task-1'),
      reserve('parent', 'b'.repeat(64), 'task-2'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(String(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    )).toContain('active_cap_reached');
  });
});
