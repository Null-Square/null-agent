import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  get: vi.fn(),
  set: vi.fn(),
};

let tokenGuardSettings: typeof import('@/domains/platform/settings/tokenGuardSettings');

describe('tokenGuardSettings', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/domains/platform/settings/SettingsRepository', () => ({
      SettingsRepository: vi.fn().mockImplementation(() => ({
        get: mocks.get,
        set: mocks.set,
      })),
    }));
    tokenGuardSettings = await import('@/domains/platform/settings/tokenGuardSettings');
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('reads token guard settings fresh on each fetch', async () => {
    mocks.get
      .mockResolvedValueOnce({
        perSessionLimit: 0,
        perUserDailyLimit: 0,
        warningThresholdPct: 80,
      })
      .mockResolvedValueOnce({
        perSessionLimit: 10_000_000,
        perUserDailyLimit: 0,
        warningThresholdPct: 80,
      });

    const first = await tokenGuardSettings.getTokenGuardSettings();
    const second = await tokenGuardSettings.getTokenGuardSettings();

    expect(first).toEqual({
      perSessionLimit: 0,
      perUserDailyLimit: 0,
      warningThresholdPct: 80,
    });
    expect(second).toEqual({
      perSessionLimit: 10_000_000,
      perUserDailyLimit: 0,
      warningThresholdPct: 80,
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});
