import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/domains/platform/settings/SettingsRepository', () => ({
  SettingsRepository: class {
    get = (...args: any[]) => mocks.get(...args);
    set = (...args: any[]) => mocks.set(...args);
  },
}));

vi.mock('@/shared/logger', () => ({
  logger: {
    warn: (...args: any[]) => mocks.warn(...args),
  },
}));

import {
  getWebSearchSettings,
  setWebSearchSettings,
  clearWebSearchSettingsCache,
} from '@/domains/platform/settings/webSearchSettings';

const baseWebSearchSettings = {
  provider: 'tavily' as const,
  duckBaseUrl: 'https://api.duckduckgo.com/',
  duckLiteBaseUrl: 'https://duckduckgo.com/html/',
  tavilyBaseUrl: 'https://api.tavily.com/search',
  maxResults: 5,
  timeoutMs: 15_000,
  maxBytes: 1_048_576,
};

describe('webSearchSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWebSearchSettingsCache();
  });

  it('allows Tavily settings without a DB-stored API key', async () => {
    mocks.get.mockResolvedValue({
      ...baseWebSearchSettings,
      tavilyApiKey: null,
    });

    const settings = await getWebSearchSettings();

    expect(settings.provider).toBe('tavily');
    expect(settings.tavilyApiKey).toBeUndefined();
  });

  it('serializes missing Tavily API key as null', async () => {
    mocks.get.mockResolvedValue(null);

    await setWebSearchSettings(baseWebSearchSettings);

    expect(mocks.set).toHaveBeenCalledWith('web_search', {
      ...baseWebSearchSettings,
      tavilyApiKey: null,
    });
  });
});
