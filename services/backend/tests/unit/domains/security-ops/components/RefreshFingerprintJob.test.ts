import { describe, expect, it, vi } from 'vitest';

import { RefreshFingerprintJob } from '@/domains/security-ops/components/RefreshFingerprintJob';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const staleAsset = (over: Record<string, unknown> = {}) => ({
  assetId: 'asset-1',
  organizationId: 'org-1',
  assetValue: 'shop.example.com',
  oldestConfirmedAt: new Date('2026-05-01T00:00:00.000Z'),
  ...over,
});

const createDb = (rows: unknown[]) => {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));

  return { select: vi.fn(() => chain), chain };
};

const okOutcome = (data: Record<string, unknown>) => ({ status: 'ok' as const, data, durationMs: 1 });

const createJob = (
  rows: unknown[],
  collect: ReturnType<typeof vi.fn>,
  recordObservation = vi.fn().mockResolvedValue({ status: 'recorded' }),
) => {
  const db = createDb(rows);
  const job = new RefreshFingerprintJob(
    db as never,
    { recordObservation } as never,
    { collect: collect as never, createBudget: () => ({}) as never },
    () => NOW,
  );
  return { job, db, recordObservation };
};

describe('RefreshFingerprintJob', () => {
  it('re-observes a stale asset and records what it sees', async () => {
    const collect = vi.fn().mockResolvedValue(
      okOutcome({
        server: 'nginx/1.18.0',
        poweredBy: null,
        generator: 'WordPress 6.4.2',
        technologies: [],
        wordpressPlugins: [{ slug: 'elementor', version: '3.21.4', confidence: 0.7 }],
        wordpressThemes: [],
      }),
    );
    const { job, recordObservation } = createJob([staleAsset()], collect);

    const result = await job.refreshStaleAssets();

    expect(result).toMatchObject({ assetsConsidered: 1, assetsRefreshed: 1, assetsUnreachable: 0 });
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'scan_preview', product: 'nginx', version: '1.18.0' }),
    );
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        product: 'elementor',
        version: '3.21.4',
        category: 'wordpress-plugin',
      }),
    );
  });

  it('records nothing and does not count a refresh when the site is unreachable', async () => {
    // "We could not look" must never advance last_confirmed_at — that would make
    // stale evidence look fresh and let it interrupt someone.
    const collect = vi.fn().mockResolvedValue({ status: 'unavailable', data: null, durationMs: 1 });
    const { job, recordObservation } = createJob([staleAsset()], collect);

    const result = await job.refreshStaleAssets();

    expect(result).toMatchObject({ assetsRefreshed: 0, assetsUnreachable: 1 });
    expect(recordObservation).not.toHaveBeenCalled();
  });

  it('treats an empty observation set as a successful refresh', async () => {
    // Distinct from unreachable: we looked, the site responded, and it simply
    // advertises nothing we recognise.
    const collect = vi.fn().mockResolvedValue(
      okOutcome({ server: null, poweredBy: null, generator: null, technologies: [] }),
    );
    const { job } = createJob([staleAsset()], collect);

    await expect(job.refreshStaleAssets()).resolves.toMatchObject({
      assetsRefreshed: 1,
      observationsRecorded: 0,
    });
  });

  it('spends its budget on the most decayed evidence first', async () => {
    const collect = vi.fn().mockResolvedValue(okOutcome({ technologies: [] }));
    const { job, db } = createJob([], collect);

    await job.refreshStaleAssets({ limit: 25 });

    expect(db.chain.orderBy).toHaveBeenCalled();
    expect(db.chain.limit).toHaveBeenCalledWith(25);
  });

  it('does nothing when no asset is stale', async () => {
    const collect = vi.fn();
    const { job } = createJob([], collect);

    await expect(job.refreshStaleAssets()).resolves.toMatchObject({ assetsConsidered: 0 });
    expect(collect).not.toHaveBeenCalled();
  });

  it('never starts an agent session or consumes credits', async () => {
    // The whole economic argument: re-confirming inventory weekly must cost
    // effectively nothing, or continuous monitoring cannot be sold cheaply.
    const collect = vi.fn().mockResolvedValue(okOutcome({ technologies: ['nginx/1.18.0'] }));
    const { job, recordObservation } = createJob([staleAsset()], collect);

    await job.refreshStaleAssets();

    expect(recordObservation).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() }),
    );
  });
});
