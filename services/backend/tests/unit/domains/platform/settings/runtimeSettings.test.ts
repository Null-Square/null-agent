import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

let runtimeSettings: typeof import('@/domains/platform/settings/runtimeSettings');

describe('runtimeSettings', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/domains/platform/settings/SettingsRepository', () => ({
      SettingsRepository: vi.fn().mockImplementation(() => ({
        get: mocks.get,
        set: mocks.set,
      })),
    }));
    runtimeSettings = await import('@/domains/platform/settings/runtimeSettings');
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('caches runtime settings after the first fetch', async () => {
    mocks.get.mockResolvedValue({
      turnTimeoutMs: 42,
      maxToolCallsPerTurn: 64,
      shellTimeoutMs: 120000,
      webTimeoutMs: 15000,
      webMaxBytes: 1048576,
      sessionTTLMinutes: 120,
    });

    const first = await runtimeSettings.getRuntimeSettings();
    const second = await runtimeSettings.getRuntimeSettings();

    expect(first).toEqual({
      turnTimeoutMs: 42,
      maxToolCallsPerTurn: 64,
      shellTimeoutMs: 120000,
      webTimeoutMs: 15000,
      webMaxBytes: 1048576,
      sessionTTLMinutes: 120,
    });
    expect(second).toEqual(first);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('throws when repository fails', async () => {
    mocks.get.mockRejectedValue(new Error('db down'));

    await expect(runtimeSettings.getRuntimeSettings()).rejects.toThrow(/db down/);
  });

  it('persists runtime settings updates', async () => {
    mocks.get.mockResolvedValue({
      turnTimeoutMs: 42,
      maxToolCallsPerTurn: 64,
      shellTimeoutMs: 120000,
      webTimeoutMs: 15000,
      webMaxBytes: 1048576,
      sessionTTLMinutes: 120,
    });
    await runtimeSettings.setRuntimeSettings({ webMaxBytes: 42 });

    expect(mocks.set).toHaveBeenCalledWith('runtime', {
      turnTimeoutMs: 42,
      maxToolCallsPerTurn: 64,
      shellTimeoutMs: 120000,
      webTimeoutMs: 15000,
      webMaxBytes: 42,
      sessionTTLMinutes: 120,
    });
  });
});
