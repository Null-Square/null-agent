import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = {
  get: vi.fn(),
  set: vi.fn(),
};

let networkSettings: typeof import('@/domains/platform/settings/networkSettings');

describe('networkSettings', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/domains/platform/settings/SettingsRepository', () => ({
      SettingsRepository: vi.fn().mockImplementation(() => ({
        get: mocks.get,
        set: mocks.set,
      })),
    }));
    networkSettings = await import('@/domains/platform/settings/networkSettings');
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('falls back to the origins of this computer only when network settings are invalid', async () => {
    mocks.get.mockResolvedValue({
      corsAllowedOrigins: 'invalid',
      allowOutbound: 'yes',
      outboundAllowlist: ['api.example.com'],
    });

    // Function now gracefully falls back to defaults instead of throwing
    const result = await networkSettings.getNetworkSettings();
    expect(result.corsAllowedOrigins).toEqual(['*.localhost']);
    expect(result.allowOutbound).toBe(true);
  });

  it('caches network settings after first fetch', async () => {
    mocks.get.mockResolvedValue({
      corsAllowedOrigins: ['https://app.example.com'],
      allowOutbound: true,
      outboundAllowlist: ['api.example.com'],
    });

    const first = await networkSettings.getNetworkSettings();
    const second = await networkSettings.getNetworkSettings();

    expect(first).toEqual({
      corsAllowedOrigins: ['https://app.example.com'],
      allowOutbound: true,
      outboundAllowlist: ['api.example.com'],
    });
    expect(second).toEqual(first);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('persists network settings updates', async () => {
    mocks.get.mockResolvedValue({
      corsAllowedOrigins: ['https://app.example.com'],
      allowOutbound: true,
      outboundAllowlist: ['api.example.com'],
    });
    await networkSettings.setNetworkSettings({ allowOutbound: false });

    expect(mocks.set).toHaveBeenCalledWith('network', {
      corsAllowedOrigins: ['https://app.example.com'],
      allowOutbound: false,
      outboundAllowlist: ['api.example.com'],
    });
  });
});
