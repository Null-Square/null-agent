import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = {
  get: vi.fn(),
  set: vi.fn(),
};

let sandboxSettings: typeof import('@/domains/platform/settings/sandboxSettings');

describe('sandboxSettings', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/domains/platform/settings/SettingsRepository', () => ({
      SettingsRepository: vi.fn().mockImplementation(() => ({
        get: mocks.get,
        set: mocks.set,
      })),
    }));
    sandboxSettings = await import('@/domains/platform/settings/sandboxSettings');
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('throws when sandbox settings are invalid', async () => {
    mocks.get.mockResolvedValue({
      devUnsafe: true,
      cpuQuota: 'invalid',
      memoryMb: 2048,
      pidsLimit: null,
      stdoutLimitBytes: 2048,
    });

    await expect(sandboxSettings.getSandboxSettings()).rejects.toThrow(/SandboxSettings/);
  });

  it('caches sandbox settings after first fetch', async () => {
    mocks.get.mockResolvedValue({
      devUnsafe: false,
      cpuQuota: 2,
      memoryMb: 4096,
      pidsLimit: 512,
      stdoutLimitBytes: 2048,
    });

    const first = await sandboxSettings.getSandboxSettings();
    const second = await sandboxSettings.getSandboxSettings();

    expect(first).toEqual({
      devUnsafe: false,
      cpuQuota: 2,
      memoryMb: 4096,
      pidsLimit: 512,
      stdoutLimitBytes: 2048,
    });
    expect(second).toEqual(first);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('persists sandbox settings updates', async () => {
    mocks.get.mockResolvedValue({
      devUnsafe: false,
      cpuQuota: 2,
      memoryMb: 4096,
      pidsLimit: 512,
      stdoutLimitBytes: 2048,
    });
    await sandboxSettings.setSandboxSettings({ devUnsafe: true });

    expect(mocks.set).toHaveBeenCalledWith('sandbox', {
      devUnsafe: true,
      cpuQuota: 2,
      memoryMb: 4096,
      pidsLimit: 512,
      stdoutLimitBytes: 2048,
    });
  });
});
