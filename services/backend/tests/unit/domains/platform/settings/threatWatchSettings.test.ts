import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  get: vi.fn(),
  set: vi.fn(),
};

let threatWatchSettings: typeof import('@/domains/platform/settings/threatWatchSettings');

const settings = (notificationsEnabled: boolean) => ({
  syncEnabled: true,
  syncIntervalMinutes: 120,
  maxPagesPerRun: 10,
  notificationsEnabled,
  notificationActivationAt: null,
  notificationEvidenceMaxAgeDays: 14,
  immediateNotifyMinPriority: 70,
  immediateNotifyOnKev: true,
  maxImmediateNotificationsPerDay: 5,
});

describe('threatWatchSettings', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/domains/platform/settings/SettingsRepository', () => ({
      SettingsRepository: vi.fn().mockImplementation(() => ({
        get: mocks.get,
        set: mocks.set,
      })),
    }));
    threatWatchSettings = await import('@/domains/platform/settings/threatWatchSettings');
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('reads incident controls fresh on every fetch', async () => {
    mocks.get
      .mockResolvedValueOnce(settings(false))
      .mockResolvedValueOnce(settings(true));

    const first = await threatWatchSettings.getThreatWatchSettings();
    const second = await threatWatchSettings.getThreatWatchSettings();

    expect(first.notificationsEnabled).toBe(false);
    expect(second.notificationsEnabled).toBe(true);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});
