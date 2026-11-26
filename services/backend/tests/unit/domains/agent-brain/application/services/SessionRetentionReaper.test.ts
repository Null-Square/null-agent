import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRetentionReaper } from '@/domains/agent-brain/application/services/SessionRetentionReaper';

const opsMocks = vi.hoisted(() => ({
  recordRetentionRun: vi.fn(),
}));

vi.mock('@/shared/metrics/opsMetrics', () => ({
  opsMetrics: {
    recordRetentionRun: opsMocks.recordRetentionRun,
  },
}));

describe('SessionRetentionReaper', () => {
  beforeEach(() => {
    opsMocks.recordRetentionRun.mockReset();
  });

  it('returns early when retention is disabled', async () => {
    const reaper = new SessionRetentionReaper({ retentionEnabled: false } as any, {} as any);

    const result = await reaper.runOnce();

    expect(result).toEqual({ deletedCount: 0, errors: [] });
    expect(opsMocks.recordRetentionRun).not.toHaveBeenCalled();
  });

  it('deletes old sessions and enforces max count', async () => {
    const retentionPort = {
      deleteOldSessions: vi.fn().mockResolvedValue(2),
      enforceMaxCountPerUser: vi.fn().mockResolvedValue(1),
    } as any;

    const reaper = new SessionRetentionReaper(
      { retentionEnabled: true, maxAgeDays: 1, maxCountPerUser: 1 } as any,
      retentionPort,
    );

    const result = await reaper.runOnce();

    expect(result).toEqual({ deletedCount: 3, errors: [] });
    expect(opsMocks.recordRetentionRun).toHaveBeenCalledWith(
      expect.any(Number),
      3,
      false,
    );
  });

  it('captures errors from cleanup passes', async () => {
    const retentionPort = {
      deleteOldSessions: vi.fn().mockRejectedValue(new Error('delete-failed')),
      enforceMaxCountPerUser: vi.fn().mockRejectedValue(new Error('execute-failed')),
    } as any;

    const reaper = new SessionRetentionReaper(
      { retentionEnabled: true, maxAgeDays: 1, maxCountPerUser: 1 } as any,
      retentionPort,
    );

    const result = await reaper.runOnce();

    expect(result.deletedCount).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('delete-failed');
    expect(result.errors[1]).toContain('execute-failed');
    expect(opsMocks.recordRetentionRun).toHaveBeenCalledWith(
      expect.any(Number),
      0,
      true,
    );
  });

  it('schedules and stops periodic runs', async () => {
    vi.useFakeTimers();
    const reaper = new SessionRetentionReaper({ retentionEnabled: false } as any, {} as any);
    const runSpy = vi.spyOn(reaper, 'runOnce').mockResolvedValue({ deletedCount: 0, errors: [] });

    reaper.start(120_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    reaper.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
