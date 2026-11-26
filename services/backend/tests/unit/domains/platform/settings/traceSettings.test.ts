import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = {
  get: vi.fn(),
  set: vi.fn(),
};

let traceSettings: typeof import('@/domains/platform/settings/traceSettings');

describe('traceSettings', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/domains/platform/settings/SettingsRepository', () => ({
      SettingsRepository: vi.fn().mockImplementation(() => ({
        get: mocks.get,
        set: mocks.set,
      })),
    }));
    traceSettings = await import('@/domains/platform/settings/traceSettings');
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('loads trace settings from repository', async () => {
    mocks.get.mockResolvedValue({
      traceInlineLimit: 100,
      stdoutChunkSize: 2048,
      traceCompressOverBytes: 1048576,
      traceRetentionDays: 14,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 5000,
    });

    const result = await traceSettings.getTraceSettings();

    expect(result).toEqual({
      traceInlineLimit: 100,
      stdoutChunkSize: 2048,
      traceCompressOverBytes: 1048576,
      traceRetentionDays: 14,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 5000,
    });
  });

  it('caches trace settings after first fetch', async () => {
    mocks.get.mockResolvedValue({
      traceInlineLimit: 200,
      stdoutChunkSize: 2048,
      traceCompressOverBytes: 1048576,
      traceRetentionDays: 14,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 5000,
    });

    const first = await traceSettings.getTraceSettings();
    const second = await traceSettings.getTraceSettings();

    expect(first).toEqual({
      traceInlineLimit: 200,
      stdoutChunkSize: 2048,
      traceCompressOverBytes: 1048576,
      traceRetentionDays: 14,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 5000,
    });
    expect(second).toEqual(first);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('persists trace settings updates', async () => {
    mocks.get.mockResolvedValue({
      traceInlineLimit: 300,
      stdoutChunkSize: 1024,
      traceCompressOverBytes: 1048576,
      traceRetentionDays: 14,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 5000,
    });
    await traceSettings.setTraceSettings({ stdoutChunkSize: 4096 });

    expect(mocks.set).toHaveBeenCalledWith('trace', {
      traceInlineLimit: 300,
      stdoutChunkSize: 4096,
      traceCompressOverBytes: 1048576,
      traceRetentionDays: 14,
      traceLogsRoot: 'storage/object-store/traces',
      artifactDirName: '.artifacts',
      artifactMaxChars: 5000,
    });
  });
});
