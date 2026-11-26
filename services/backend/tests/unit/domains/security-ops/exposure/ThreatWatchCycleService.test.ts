import { describe, expect, it, vi } from 'vitest';

import { ThreatWatchCycleService } from '@/domains/security-ops/exposure/ThreatWatchCycleService';
import type { AdvisorySyncService } from '@/domains/security-ops/advisories/AdvisorySyncService';
import type { ExposureMatchService } from '@/domains/security-ops/exposure/ExposureMatchService';

const NOW = new Date('2026-06-01T00:00:00.000Z');

/**
 * `selectDistinct` serves the touched-advisories lookup; `select` serves the
 * retracted-advisories lookup. They are separate chains because the cycle now
 * runs both, and a shared queue would let one consume the other's rows.
 */
const createDb = (touchedAdvisoryIds: string[], retracted: Array<{ id: string; state: string }> = []) => {
  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    // The touched-advisories query pages with a keyset, so the chain must
    // support ordering and return an empty page to terminate the loop.
    chain.orderBy = vi.fn(() => chain);
    // The circuit-breaker query aggregates and resolves without `.limit()`.
    chain.groupBy = vi.fn(() => Promise.resolve([]));
    let served = false;
    chain.limit = vi.fn(() => {
      if (served) return Promise.resolve([]);
      served = true;
      return Promise.resolve(rows);
    });
    return chain;
  };

  return {
    selectDistinct: vi.fn(() => makeChain(touchedAdvisoryIds.map((id) => ({ advisoryId: id })))),
    select: vi.fn(() => makeChain(retracted)),
  };
};

const createSync = (over: Partial<Awaited<ReturnType<AdvisorySyncService['syncOnce']>>> = {}) => {
  const syncOnce = vi.fn().mockResolvedValue({
    status: 'ok',
    pagesFetched: 1,
    advisoriesIngested: 3,
    windowComplete: true,
    moreWindows: false,
    ...over,
  });
  return { syncService: { syncOnce } as unknown as AdvisorySyncService, syncOnce };
};

const createMatcher = () => {
  const matchAdvisory = vi.fn().mockResolvedValue({
    advisoryId: 'adv',
    candidatesConsidered: 1,
    matchesCreated: 1,
    matchesUpdated: 0,
    suppressedByOverride: 0,
    skippedIncomparable: 0,
  });
  const markStaleMatches = vi.fn().mockResolvedValue(2);
  const resolveMatchesForAdvisory = vi.fn().mockResolvedValue(1);
  const reprioritizeForAdvisories = vi.fn().mockResolvedValue(2);
  const reconcileComponents = vi
    .fn()
    .mockResolvedValue({ componentsConsidered: 5, advisoriesMatched: 2 });

  return {
    matchService: {
      matchAdvisory,
      markStaleMatches,
      reconcileComponents,
      resolveMatchesForAdvisory,
      reprioritizeForAdvisories,
    } as unknown as ExposureMatchService,
    matchAdvisory,
    markStaleMatches,
    reconcileComponents,
    resolveMatchesForAdvisory,
    reprioritizeForAdvisories,
  };
};

describe('ThreatWatchCycleService', () => {
  it('syncs, then matches only the advisories that were touched', async () => {
    const { syncService, syncOnce } = createSync();
    const { matchService, matchAdvisory } = createMatcher();

    const result = await new ThreatWatchCycleService(
      createDb(['adv-1', 'adv-2']) as never,
      syncService,
      matchService,
      {},
      () => NOW,
    ).runCycle();

    expect(syncOnce).toHaveBeenCalledOnce();
    expect(matchAdvisory).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ advisoriesMatched: 2, matchesCreated: 2, staleMarked: 2 });
  });

  it('does no matching work when another instance holds the lock', async () => {
    // Duplicating the pass would only race the replica already doing it.
    const { syncService } = createSync({ status: 'skipped' });
    const { matchService, matchAdvisory, markStaleMatches } = createMatcher();

    const result = await new ThreatWatchCycleService(
      createDb(['adv-1']) as never,
      syncService,
      matchService,
      {},
      () => NOW,
    ).runCycle();

    expect(matchAdvisory).not.toHaveBeenCalled();
    expect(markStaleMatches).not.toHaveBeenCalled();
    expect(result.advisoriesMatched).toBe(0);
  });

  it('still matches and ages out after a partial sync', async () => {
    // A rate-limited window is incomplete, not useless: what arrived is real.
    const { syncService } = createSync({ status: 'partial', advisoriesIngested: 1, moreWindows: true });
    const { matchService, matchAdvisory, markStaleMatches } = createMatcher();

    const result = await new ThreatWatchCycleService(
      createDb(['adv-1']) as never,
      syncService,
      matchService,
      {},
      () => NOW,
    ).runCycle();

    expect(matchAdvisory).toHaveBeenCalledOnce();
    expect(markStaleMatches).toHaveBeenCalled();
    expect(result.sync).toMatchObject({ status: 'partial', moreWindows: true });
  });

  it('resolves matches for advisories retracted upstream', async () => {
    // The touched-advisories query filters to active advisories, so without
    // this the customer keeps a live claim we no longer stand behind.
    const { syncService } = createSync();
    const { matchService, resolveMatchesForAdvisory } = createMatcher();

    const result = await new ThreatWatchCycleService(
      createDb([], [{ id: 'adv-withdrawn', state: 'withdrawn' }]) as never,
      syncService,
      matchService,
      {},
      () => NOW,
    ).runCycle();

    expect(resolveMatchesForAdvisory).toHaveBeenCalledWith('adv-withdrawn', 'advisory_withdrawn');
    expect(result.matchesRetracted).toBe(1);
  });

  it('skips reconciliation unless asked', async () => {
    const { syncService } = createSync();
    const { matchService, reconcileComponents } = createMatcher();

    const result = await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      {},
      () => NOW,
    ).runCycle();

    expect(reconcileComponents).not.toHaveBeenCalled();
    expect(result.reconciled).toBeUndefined();
  });

  it('reconciles recently confirmed components when asked', async () => {
    // The opposite blind spot to advisory-first matching: without this, a
    // customer onboarded today is never matched against existing advisories.
    const { syncService } = createSync();
    const { matchService, reconcileComponents } = createMatcher();

    const result = await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      { reconcileLookbackHours: 24 },
      () => NOW,
    ).runCycle({ reconcile: true });

    expect(reconcileComponents).toHaveBeenCalledWith({
      since: new Date('2026-05-31T00:00:00.000Z'),
    });
    expect(result.reconciled).toMatchObject({ advisoriesMatched: 2 });
  });

  it('refreshes KEV and EPSS when enrichment is requested', async () => {
    const { syncService } = createSync();
    const { matchService } = createMatcher();
    const replaceKevCatalog = vi
      .fn()
      .mockResolvedValue({ listed: 3, cleared: 1, changedAdvisoryIds: ['adv-kev'] });
    const applyEpssScores = vi
      .fn()
      .mockResolvedValue({ applied: 42, changedAdvisoryIds: [] });
    const loadFeedState = vi.fn().mockResolvedValue(null);
    const recordFeedAttempt = vi.fn().mockResolvedValue(undefined);

    const result = await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      {},
      () => NOW,
      {
        advisoryRepository: {
          replaceKevCatalog,
          applyEpssScores,
          loadFeedState,
          recordFeedAttempt,
        } as never,
        fetchKev: vi.fn().mockResolvedValue([{ cveId: 'CVE-2026-1', addedAt: null, knownRansomware: false }]),
        fetchEpss: vi.fn().mockResolvedValue([{ cveId: 'CVE-2026-1', score: 0.5, percentile: 0.9 }]),
      },
    ).runCycle({ enrich: true });

    expect(result.enrichment).toMatchObject({ kevListed: 3, kevCleared: 1, epssApplied: 42 });
    expect(recordFeedAttempt).toHaveBeenCalledWith(expect.objectContaining({
      source: 'kev',
      status: 'ok',
      recordsIngested: 1,
    }));
    expect(recordFeedAttempt).toHaveBeenCalledWith(expect.objectContaining({
      source: 'epss',
      status: 'ok',
      recordsIngested: 1,
    }));
    // A CVE newly added to KEV gets no NVD modification, so its existing matches
    // must be rescored explicitly or the strongest signal arrives and is ignored.
    expect(matchService.reprioritizeForAdvisories).toHaveBeenCalledWith(['adv-kev']);
  });

  it('completes the cycle when an enrichment feed is down', async () => {
    // A feed outage degrades ranking quality; it must never discard advisories
    // this cycle already ingested and matched.
    const { syncService } = createSync();
    const { matchService, markStaleMatches } = createMatcher();
    const recordFeedAttempt = vi.fn().mockResolvedValue(undefined);

    const result = await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      {},
      () => NOW,
      {
        advisoryRepository: {
          loadFeedState: vi.fn().mockResolvedValue(null),
          recordFeedAttempt,
          replaceKevCatalog: vi.fn().mockResolvedValue({ listed: 0, cleared: 0, changedAdvisoryIds: [] }),
          applyEpssScores: vi.fn().mockResolvedValue({ applied: 0, changedAdvisoryIds: [] }),
        } as never,
        fetchKev: vi.fn().mockRejectedValue(new Error('KEV feed unavailable')),
        fetchEpss: vi.fn().mockResolvedValue([]),
      },
    ).runCycle({ enrich: true });

    expect(result.enrichment).toMatchObject({ kevListed: 0 });
    expect(markStaleMatches).toHaveBeenCalled();
    expect(recordFeedAttempt).toHaveBeenCalledWith(expect.objectContaining({
      source: 'kev',
      status: 'failed',
      error: 'KEV feed unavailable',
    }));
  });

  it('does not download daily snapshots before their persisted next run', async () => {
    const { syncService } = createSync();
    const { matchService } = createMatcher();
    const fetchKev = vi.fn();
    const fetchEpss = vi.fn();
    const future = new Date('2026-06-02T00:00:00.000Z');

    const result = await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      {},
      () => NOW,
      {
        advisoryRepository: {
          loadFeedState: vi.fn().mockResolvedValue({ nextRunAt: future }),
        } as never,
        fetchKev,
        fetchEpss,
      },
    ).runCycle({ enrich: true });

    expect(fetchKev).not.toHaveBeenCalled();
    expect(fetchEpss).not.toHaveBeenCalled();
    expect(result.enrichment).toMatchObject({ kevRefreshed: false, epssRefreshed: false });
  });

  it('skips enrichment unless asked', async () => {
    const { syncService } = createSync();
    const { matchService } = createMatcher();
    const fetchKev = vi.fn();

    const result = await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      {},
      () => NOW,
      { advisoryRepository: {} as never, fetchKev },
    ).runCycle();

    expect(fetchKev).not.toHaveBeenCalled();
    expect(result.enrichment).toBeUndefined();
  });

  it('passes the configured staleness threshold through', async () => {
    const { syncService } = createSync();
    const { matchService, markStaleMatches } = createMatcher();

    await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      { stalenessThresholdDays: 30 },
      () => NOW,
    ).runCycle();

    expect(markStaleMatches).toHaveBeenCalledWith(30);
  });

  it('recovers only old orphaned or terminal verification work on every owned cycle', async () => {
    const { syncService } = createSync();
    const { matchService } = createMatcher();
    const recoverStalledVerifications = vi.fn().mockResolvedValue(2);

    const result = await new ThreatWatchCycleService(
      createDb([]) as never,
      syncService,
      matchService,
      { verificationRecoveryMinutes: 45 },
      () => NOW,
      {
        verificationService: { recoverStalledVerifications },
      },
    ).runCycle();

    expect(recoverStalledVerifications).toHaveBeenCalledWith({ olderThanMinutes: 45 });
    expect(result.verificationsRecovered).toBe(2);
  });
});
