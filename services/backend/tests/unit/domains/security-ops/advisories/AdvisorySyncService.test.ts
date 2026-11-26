import { describe, expect, it, vi } from 'vitest';

import { AdvisorySyncService } from '@/domains/security-ops/advisories/AdvisorySyncService';
import { NvdRateLimited, NvdUnavailable, type NvdClient } from '@/domains/security-ops/advisories/NvdClient';
import type { AdvisoryRepository } from '@/domains/security-ops/advisories/AdvisoryRepository';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const cve = (id: string) => ({
  id,
  lastModified: '2026-05-30T00:00:00.000',
  vulnStatus: 'Analyzed',
  descriptions: [{ lang: 'en', value: `Issue ${id}.` }],
  configurations: [
    {
      nodes: [
        {
          operator: 'OR',
          cpeMatch: [
            {
              vulnerable: true,
              criteria: 'cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*',
              versionEndExcluding: '1.18.1',
            },
          ],
        },
      ],
    },
  ],
});

/** Grants the lock, so tests exercise the sync loop rather than the guard. */
const createDb = (lockAcquired = true) => ({
  $client: {
    connect: vi.fn(async () => ({
      query: vi.fn(async (query: string) => query.includes('pg_try_advisory_lock')
        ? { rows: [{ acquired: lockAcquired }] }
        : { rows: [{ pg_advisory_unlock: true }] }),
      release: vi.fn(),
    })),
  },
});

const createRepository = (cursor: Awaited<ReturnType<AdvisoryRepository['loadCursor']>> = null) => {
  const saveCursor = vi.fn().mockResolvedValue(undefined);
  const upsertPageFromSource = vi.fn().mockImplementation(async (rows: unknown[]) => ({
    advisoriesUpserted: rows.length,
  }));
  return {
    repository: { loadCursor: vi.fn().mockResolvedValue(cursor), saveCursor, upsertPageFromSource } as unknown as AdvisoryRepository,
    saveCursor,
    upsertPageFromSource,
  };
};

const createClient = (pages: Array<{ cves: unknown[]; totalResults: number; startIndex: number }>) => {
  const fetchPage = vi.fn();
  for (const page of pages) {
    fetchPage.mockResolvedValueOnce({
      ...page,
      returnedCount: page.cves.length,
      resultsPerPage: 2000,
    });
  }
  return { client: { fetchPage } as unknown as NvdClient, fetchPage };
};

describe('AdvisorySyncService', () => {
  it('ingests a complete window and checkpoints it as ok', async () => {
    const { repository, saveCursor, upsertPageFromSource } = createRepository();
    const { client } = createClient([
      { cves: [cve('CVE-2026-1'), cve('CVE-2026-2')], totalResults: 2, startIndex: 0 },
    ]);

    const result = await new AdvisorySyncService(
      createDb() as never,
      client,
      repository,
      { backfillDays: 30 },
      () => NOW,
    ).syncOnce();

    expect(result).toMatchObject({ status: 'ok', advisoriesIngested: 2, windowComplete: true });
    expect(upsertPageFromSource).toHaveBeenCalledOnce();
    expect(upsertPageFromSource.mock.calls[0]?.[0]).toHaveLength(2);
    expect(client.fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      queryMode: 'publication',
    }));
    expect(saveCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        pageOffset: 0,
        mode: 'modification',
        backfillStartedAt: NOW,
        windowStart: NOW,
        windowEnd: NOW,
      }),
    );
    expect(result.moreWindows).toBe(true);
  });

  it('derives affected ranges as it ingests', async () => {
    const { repository, upsertPageFromSource } = createRepository();
    const { client } = createClient([{ cves: [cve('CVE-2026-1')], totalResults: 1, startIndex: 0 }]);

    await new AdvisorySyncService(createDb() as never, client, repository, {}, () => NOW).syncOnce();

    expect(upsertPageFromSource).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'nvd',
        sourceAdvisoryId: 'CVE-2026-1',
        ranges: [expect.objectContaining({ componentKey: 'cpe:f5:nginx', fixedVersion: '1.18.1' })],
      }),
    ]);
  });

  it('walks pages until the window is exhausted', async () => {
    const { repository } = createRepository();
    const { client, fetchPage } = createClient([
      { cves: [cve('CVE-2026-1')], totalResults: 2, startIndex: 0 },
      { cves: [cve('CVE-2026-2')], totalResults: 2, startIndex: 1 },
    ]);

    const result = await new AdvisorySyncService(
      createDb() as never,
      client,
      repository,
      {},
      () => NOW,
    ).syncOnce();

    expect(fetchPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ startIndex: 1 }));
    expect(result).toMatchObject({ status: 'ok', pagesFetched: 2, advisoriesIngested: 2 });
  });

  it('checkpoints partial on rate limiting, at the page it reached', async () => {
    // The cursor must never advance past data we did not confirm we read: a
    // missed advisory is invisible, because nobody gets the alert.
    const { repository, saveCursor } = createRepository();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ cves: [cve('CVE-2026-1')], returnedCount: 1, totalResults: 10, startIndex: 0, resultsPerPage: 2000 })
      .mockRejectedValueOnce(new NvdRateLimited(429));

    const result = await new AdvisorySyncService(
      createDb() as never,
      { fetchPage } as unknown as NvdClient,
      repository,
      {},
      () => NOW,
    ).syncOnce();

    expect(result).toMatchObject({ status: 'partial', advisoriesIngested: 1, windowComplete: false });
    expect(saveCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial', pageOffset: 1 }),
    );
  });

  it('checkpoints failed on a server error', async () => {
    const { repository, saveCursor } = createRepository();
    const fetchPage = vi.fn().mockRejectedValue(new NvdUnavailable('NVD returned 500'));

    const result = await new AdvisorySyncService(
      createDb() as never,
      { fetchPage } as unknown as NvdClient,
      repository,
      {},
      () => NOW,
    ).syncOnce();

    expect(result.status).toBe('failed');
    expect(saveCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', pageOffset: 0 }),
    );
  });

  it('resumes an interrupted window at its saved page', async () => {
    const { repository } = createRepository({
      mode: 'publication',
      windowStart: new Date('2026-01-01T00:00:00.000Z'),
      windowEnd: new Date('2026-04-01T00:00:00.000Z'),
      pageOffset: 4000,
      backfillStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastStatus: 'partial',
    });
    const { client, fetchPage } = createClient([{ cves: [], totalResults: 4000, startIndex: 4000 }]);

    await new AdvisorySyncService(createDb() as never, client, repository, {}, () => NOW).syncOnce();

    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        startIndex: 4000,
        windowStart: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
  });

  it('hands publication backfill to modification catch-up at its durable start watermark', async () => {
    const watermark = new Date('2026-05-01T00:00:00.000Z');
    const { repository, saveCursor } = createRepository({
      mode: 'publication',
      windowStart: new Date('2026-05-01T00:00:00.000Z'),
      windowEnd: NOW,
      pageOffset: 0,
      backfillStartedAt: watermark,
      lastStatus: 'partial',
    });
    const { client } = createClient([{ cves: [], totalResults: 0, startIndex: 0 }]);
    const continuationNextRunAt = new Date('2026-06-01T00:01:00.000Z');

    const result = await new AdvisorySyncService(
      createDb() as never,
      client,
      repository,
      {},
      () => NOW,
    ).syncOnce({ continuationNextRunAt });

    expect(result.moreWindows).toBe(true);
    expect(saveCursor).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'modification',
      windowStart: watermark,
      windowEnd: watermark,
      nextRunAt: continuationNextRunAt,
    }));
  });

  it('pauses at the page budget and marks the window partial', async () => {
    const { repository, saveCursor } = createRepository();
    const fetchPage = vi.fn().mockResolvedValue({
      cves: [cve('CVE-2026-1')],
      returnedCount: 1,
      totalResults: 1_000,
      startIndex: 0,
      resultsPerPage: 2000,
    });

    const result = await new AdvisorySyncService(
      createDb() as never,
      { fetchPage } as unknown as NvdClient,
      repository,
      { maxPagesPerRun: 3 },
      () => NOW,
    ).syncOnce();

    expect(result).toMatchObject({ status: 'partial', pagesFetched: 3 });
    expect(saveCursor).toHaveBeenCalledWith(expect.objectContaining({ status: 'partial' }));
  });

  it('skips the tick when another instance holds the lock', async () => {
    // Without this, every replica ingests the same window and, downstream,
    // every customer is alerted twice.
    const { repository, upsertPageFromSource } = createRepository();
    const { client, fetchPage } = createClient([{ cves: [], totalResults: 0, startIndex: 0 }]);

    const result = await new AdvisorySyncService(
      createDb(false) as never,
      client,
      repository,
      {},
      () => NOW,
    ).syncOnce();

    expect(result.status).toBe('skipped');
    expect(fetchPage).not.toHaveBeenCalled();
    expect(upsertPageFromSource).not.toHaveBeenCalled();
  });

  it('checkpoints after every successful page, not only at boundaries', async () => {
    // A hard kill mid-loop would otherwise replay the whole tick.
    const { repository, saveCursor } = createRepository();
    const { client } = createClient([
      { cves: [cve('CVE-2026-1')], totalResults: 2, startIndex: 0 },
      { cves: [cve('CVE-2026-2')], totalResults: 2, startIndex: 1 },
    ]);

    await new AdvisorySyncService(createDb() as never, client, repository, {}, () => NOW).syncOnce();

    const offsets = saveCursor.mock.calls.map((call) => call[0].pageOffset);
    expect(offsets).toContain(1);
  });

  it('skips advisories that cannot be normalized', async () => {
    const { repository, upsertPageFromSource } = createRepository();
    const { client } = createClient([
      { cves: [cve('CVE-2026-1'), { id: 'CVE-2026-2' }], totalResults: 2, startIndex: 0 },
    ]);

    // The second entry has no lastModified, so it has no usable cursor value.
    await new AdvisorySyncService(createDb() as never, client, repository, {}, () => NOW).syncOnce();

    expect(upsertPageFromSource).toHaveBeenCalledOnce();
    expect(upsertPageFromSource.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
