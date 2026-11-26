import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchArtifactContent,
  downloadArtifactUrl,
  downloadArtifactBlob,
  fetchArtifacts,
} from './artifacts';
import { authenticatedFetch } from '@shared/api';
import { validateArtifacts } from '@shared/lib/validators';

vi.mock('@shared/api', () => ({
  authenticatedFetch: vi.fn(),
  fetchApiBaseUrl: 'http://api.test',
}));

vi.mock('@shared/lib/validators', () => ({
  validateArtifacts: vi.fn((items) => items),
}));

const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);

describe('artifacts API', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it('fetches artifact content', async () => {
    mockAuthenticatedFetch.mockResolvedValue({ content: 'data' });

    const content = await fetchArtifactContent('s1', 'a1');
    expect(content).toBe('data');
    expect(mockAuthenticatedFetch).toHaveBeenCalledWith(
      'http://api.test/api/ai-agent/sessions/s1/artifacts/a1/content',
    );
  });

  it('builds download URLs', () => {
    expect(downloadArtifactUrl('s1', 'a1')).toBe(
      'http://api.test/api/ai-agent/sessions/s1/artifacts/a1/download',
    );
  });

  it('downloads artifact blobs with no Authorization header', async () => {
    const blob = new Blob(['payload'], { type: 'text/plain' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      blob: () => Promise.resolve(blob),
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const data = await downloadArtifactBlob('s1', 'a1');
    expect(data).toBe(blob);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/ai-agent/sessions/s1/artifacts/a1/download',
    );
  });

  it('throws on blob download failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(downloadArtifactBlob('s1', 'a1')).rejects.toThrow(
      'Failed to download artifact: 500 Server Error',
    );
  });

  it('fetches artifact metadata via the API client', async () => {
    mockAuthenticatedFetch.mockResolvedValue({ artifacts: [{ id: 'a1' }] });

    const artifacts = await fetchArtifacts('s1');
    expect(validateArtifacts).toHaveBeenCalledWith([{ id: 'a1' }]);
    expect(artifacts).toEqual([{ id: 'a1' }]);
  });

  it('throws when the API returns an error', async () => {
    mockAuthenticatedFetch.mockRejectedValueOnce(new Error('fail'));
    await expect(fetchArtifacts('s1')).rejects.toThrow('fail');
  });
});
