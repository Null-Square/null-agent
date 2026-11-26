import { describe, expect, it, vi } from 'vitest';

import {
  NvdClient,
  NvdRateLimited,
  NvdUnavailable,
  clampWindowEnd,
  formatNvdTimestamp,
  hasMorePages,
} from '@/domains/security-ops/advisories/NvdClient';

const at = (iso: string) => new Date(iso);

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

describe('clampWindowEnd', () => {
  it('caps a window at the 120 days NVD accepts', () => {
    const start = at('2026-01-01T00:00:00.000Z');
    const end = clampWindowEnd(start, at('2026-12-31T00:00:00.000Z'));
    const days = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(120);
  });

  it('leaves a window inside the cap untouched', () => {
    const start = at('2026-01-01T00:00:00.000Z');
    const end = at('2026-01-10T00:00:00.000Z');
    expect(clampWindowEnd(start, end)).toEqual(end);
  });
});

describe('formatNvdTimestamp', () => {
  it('emits ISO-8601 without the trailing Z the API rejects', () => {
    expect(formatNvdTimestamp(at('2026-02-01T12:30:00.000Z'))).toBe('2026-02-01T12:30:00.000');
  });
});

describe('NvdClient.buildUrl', () => {
  it('includes the window, page offset and page size', () => {
    const url = new NvdClient({ endpoint: 'https://nvd.test/cves' }).buildUrl({
      queryMode: 'modification',
      windowStart: at('2026-01-01T00:00:00.000Z'),
      windowEnd: at('2026-01-08T00:00:00.000Z'),
      startIndex: 2000,
      resultsPerPage: 2000,
    });

    expect(url).toContain('lastModStartDate=2026-01-01T00%3A00%3A00.000');
    expect(url).toContain('lastModEndDate=2026-01-08T00%3A00%3A00.000');
    expect(url).toContain('startIndex=2000');
    expect(url).toContain('resultsPerPage=2000');
  });

  it('clamps an over-wide window rather than letting the API reject it', () => {
    const url = new NvdClient().buildUrl({
      queryMode: 'modification',
      windowStart: at('2026-01-01T00:00:00.000Z'),
      windowEnd: at('2027-01-01T00:00:00.000Z'),
      startIndex: 0,
      resultsPerPage: 2000,
    });
    expect(url).toContain('lastModEndDate=2026-05-01');
  });

  it('uses publication dates for the historical corpus query', () => {
    const url = new NvdClient().buildUrl({
      queryMode: 'publication',
      windowStart: at('2017-01-01T00:00:00.000Z'),
      windowEnd: at('2017-02-01T00:00:00.000Z'),
      startIndex: 0,
      resultsPerPage: 1,
    });

    expect(url).toContain('pubStartDate=2017-01-01');
    expect(url).toContain('pubEndDate=2017-02-01');
    expect(url).not.toContain('lastModStartDate');
  });
});

describe('NvdClient.fetchPage', () => {
  const window = {
    queryMode: 'modification' as const,
    windowStart: at('2026-01-01T00:00:00.000Z'),
    windowEnd: at('2026-01-08T00:00:00.000Z'),
    startIndex: 0,
  };

  it('returns the CVEs and paging metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        totalResults: 3,
        startIndex: 0,
        resultsPerPage: 2,
        vulnerabilities: [{ cve: { id: 'CVE-2026-1' } }, { cve: { id: 'CVE-2026-2' } }],
      }),
    );

    const page = await new NvdClient({ fetchImpl }).fetchPage(window);

    expect(page.cves.map((cve) => cve.id)).toEqual(['CVE-2026-1', 'CVE-2026-2']);
    expect(page.totalResults).toBe(3);
  });

  it('sends the API key header when one is configured', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ totalResults: 0, vulnerabilities: [] }));
    await new NvdClient({ fetchImpl, apiKey: 'secret' }).fetchPage(window);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ apiKey: 'secret' }) }),
    );
  });

  it('reports the rate limit a key buys', () => {
    expect(new NvdClient().rateLimitPer30s).toBe(5);
    expect(new NvdClient({ apiKey: 'k' }).rateLimitPer30s).toBe(50);
  });

  it('paces consecutive requests instead of spending the provider ceiling in a burst', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ totalResults: 0, vulnerabilities: [] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 1_000;
    const client = new NvdClient({
      fetchImpl,
      minRequestIntervalMs: 6_100,
      sleep,
      nowMs: () => now,
    });

    await client.fetchPage(window);
    now = 2_000;
    await client.fetchPage(window);

    expect(sleep).toHaveBeenCalledWith(5_100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws on rate limiting rather than returning an empty page', async () => {
    // An empty page we did not earn would checkpoint past real data and mark
    // customers unaffected by advisories we never read.
    for (const status of [403, 429]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, status));
      await expect(new NvdClient({ fetchImpl }).fetchPage(window)).rejects.toBeInstanceOf(
        NvdRateLimited,
      );
    }
  });

  it('throws on a server error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(new NvdClient({ fetchImpl }).fetchPage(window)).rejects.toBeInstanceOf(
      NvdUnavailable,
    );
  });

  it('rejects a 200 that carries no pagination fields', async () => {
    // Defaulting these to zero made a malformed response look like a completed
    // page, which advanced the cursor past data we never read.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(new NvdClient({ fetchImpl }).fetchPage(window)).rejects.toBeInstanceOf(
      NvdUnavailable,
    );
  });

  it('pages by entries returned, not by entries usable', async () => {
    // Advancing by the filtered count would re-read the difference next page.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        totalResults: 10,
        vulnerabilities: [{ cve: { id: 'CVE-2026-1' } }, { cve: {} }],
      }),
    );
    const page = await new NvdClient({ fetchImpl }).fetchPage(window);
    expect(page.cves).toHaveLength(1);
    expect(page.returnedCount).toBe(2);
  });

  it('drops entries with no id rather than persisting a nameless advisory', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        totalResults: 2,
        vulnerabilities: [{ cve: { id: 'CVE-2026-1' } }, { cve: {} }],
      }),
    );
    const page = await new NvdClient({ fetchImpl }).fetchPage(window);
    expect(page.cves).toHaveLength(1);
  });
});

describe('hasMorePages', () => {
  it('detects a partially consumed window', () => {
    expect(
      hasMorePages({ cves: new Array(2000).fill({ id: 'x' }), returnedCount: 2000, totalResults: 5000, startIndex: 0, resultsPerPage: 2000 }),
    ).toBe(true);
  });

  it('detects the final page', () => {
    expect(
      hasMorePages({ cves: new Array(1000).fill({ id: 'x' }), returnedCount: 1000, totalResults: 5000, startIndex: 4000, resultsPerPage: 2000 }),
    ).toBe(false);
  });

  it('stops on an empty page even if the total disagrees', () => {
    // Without this the loop would spin forever against a total that never drops.
    expect(hasMorePages({ cves: [], returnedCount: 0, totalResults: 5000, startIndex: 0, resultsPerPage: 2000 })).toBe(
      false,
    );
  });
});
