import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExposureNotifier } from '@/domains/security-ops/exposure/ExposureNotifier';

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/domains/platform/settings/threatWatchSettings', () => ({
  getThreatWatchSettings: () => Promise.resolve(settings.current),
}));

/**
 * The rules that protect the right to interrupt a customer.
 *
 * Every assertion here is about restraint rather than delivery. Sending is the
 * easy part; the reason this feature is worth anything is that it stays quiet
 * unless it has something worth saying, and a regression in that direction
 * would not fail any other test.
 */
const candidate = (overrides: Record<string, unknown> = {}) => ({
  matchId: 'match-1',
  organizationId: 'org-1',
  matchConfidence: 'exact_version',
  evidenceTier: 'observed_exact',
  evidenceSource: 'connected_site',
  inventoryObservedAt: new Date(),
  firstSeenAt: new Date(),
  priorityScore: 90,
  advisoryId: 'CVE-2024-1234',
  severity: 'critical',
  kevListed: false,
  componentName: 'nginx',
  componentVersion: '1.18.0',
  assetValue: 'shop.example.com',
  assetId: 'asset-1',
  versionConflict: false,
  backportRisk: false,
  ...overrides,
});

/**
 * Minimal stand-in for the query builder.
 *
 * `rows` feeds the candidate select; `members` feeds the recipient lookup;
 * `counts` feeds the daily-cap count. Selects are answered in call order, which
 * mirrors the order the notifier issues them.
 */
const createDb = (options: {
  rows: unknown[];
  members?: unknown[];
  notifiedToday?: number;
  claim?: boolean;
}) => {
  const updates: Array<Record<string, unknown>> = [];
  let selectCall = 0;

  const db = {
    select: vi.fn(() => {
      selectCall += 1;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve(options.rows));
      // The candidate query ends in `.limit`; the count and member queries end
      // at `.where`, so `where` has to be awaitable too.
      chain.where = vi.fn(() => {
        const settled =
          selectCall % 2 === 0
            ? Promise.resolve([{ count: options.notifiedToday ?? 0 }])
            : Promise.resolve(options.members ?? [{ userId: 'user-1' }]);
        return Object.assign(settled, chain);
      });
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(() => {
          updates.push({ values });
          return {
            returning: vi.fn(() =>
              Promise.resolve(options.claim === false ? [] : [{ id: 'match-1' }]),
            ),
          };
        }),
      })),
    })),
  };

  return { db: db as never, updates };
};

describe('ExposureNotifier', () => {
  const emit = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    settings.current = {
      notificationsEnabled: true,
      notificationActivationAt: '2026-01-01T00:00:00.000Z',
      notificationEvidenceMaxAgeDays: 14,
      immediateNotifyMinPriority: 70,
      immediateNotifyOnKev: true,
      maxImmediateNotificationsPerDay: 5,
    };
  });

  it('sends nothing at all when notifications are disabled', async () => {
    // Shadow mode: matching runs, nobody is told. This is how precision gets
    // measured before any trust is spent.
    settings.current.notificationsEnabled = false;
    const { db } = createDb({ rows: [candidate()] });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.notified).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('fails closed until an operator establishes an activation baseline', async () => {
    settings.current.notificationActivationAt = null;
    const { db } = createDb({ rows: [candidate()] });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.considered).toBe(0);
    expect(result.notified).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    ['reported scanner evidence', { evidenceTier: 'reported_exact', evidenceSource: 'agent' }],
    ['a missing version', { componentVersion: null, matchConfidence: 'exact_version', evidenceTier: 'absent' }],
    ['conflicting versions', { versionConflict: true }],
    ['backport ambiguity', { backportRisk: true }],
    ['stale evidence', { inventoryObservedAt: new Date('2026-01-02T00:00:00.000Z') }],
    ['a pre-activation match', { firstSeenAt: new Date('2025-12-31T23:59:59.000Z') }],
  ])('does not interrupt on %s', async (_label, overrides) => {
    const { db } = createDb({ rows: [candidate(overrides)] });

    const result = await new ExposureNotifier(
      db,
      { emit },
      () => new Date('2026-08-30T12:00:00.000Z'),
    ).notifyNewExposures();

    expect(result.notified).toBe(0);
    expect(result.skippedIneligibleEvidence).toBe(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('notifies a high-priority exposure', async () => {
    const { db } = createDb({ rows: [candidate()] });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.notified).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('stays silent about a low-priority match', async () => {
    // "A CVE exists for your version" is not news. If this ever starts sending,
    // the product becomes the vulnerability feed the PRD refused to build.
    const { db } = createDb({ rows: [candidate({ priorityScore: 20 })] });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.notified).toBe(0);
    expect(result.skippedBelowThreshold).toBe(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('notifies a KEV-listed exposure even when its priority is low', async () => {
    // Once evidence is eligible, active exploitation is a categorically
    // different claim from a severity score and always earns an interrupt.
    const { db } = createDb({ rows: [candidate({ priorityScore: 5, kevListed: true })] });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.notified).toBe(1);
    expect(emit.mock.calls[0]?.[0]?.title).toMatch(/urgent potential exposure/iu);
    expect(emit.mock.calls[0]?.[0]?.title).toMatch(/exploited in the wild/iu);
  });

  it('honours the daily cap so a backfill cannot flood one organization', async () => {
    // The first real backfill against a busy inventory produces many matches at
    // once. Mailing all of them would spend the trust budget on day one.
    const { db } = createDb({ rows: [candidate()], notifiedToday: 5 });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.notified).toBe(0);
    expect(result.suppressedByCap).toBe(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not count a match claimed by another pass after the idempotent enqueue', async () => {
    // The in-app notifier dedupes by exposure. Both racing passes
    // may try the same stable event key, but only one durable event is created;
    // only the pass that stamps the match counts it against the daily cap.
    const { db } = createDb({ rows: [candidate()], claim: false });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.notified).toBe(0);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('leaves the match retryable when the notice cannot be written', async () => {
    const { db, updates } = createDb({ rows: [candidate()] });
    const failedEmit = vi.fn().mockRejectedValue(new Error('notifications unavailable'));

    await expect(
      new ExposureNotifier(db, { emit: failedEmit }).notifyNewExposures(),
    ).rejects.toThrow('notifications unavailable');

    expect(updates).toHaveLength(0);
  });

  it('records the notification so a later pass cannot repeat it', async () => {
    const { db, updates } = createDb({ rows: [candidate()] });

    await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(updates[0]?.values).toMatchObject({ state: 'notified' });
    expect((updates[0]?.values as { notifiedAt?: Date }).notifiedAt).toBeInstanceOf(Date);
  });

  it('never claims the exposure is confirmed', async () => {
    // The message describes a version match, not a compromise. Overstating it
    // here would be a lie we have not tested, and the verify step is the whole
    // differentiator.
    const { db } = createDb({ rows: [candidate()] });

    await new ExposureNotifier(db, { emit }).notifyNewExposures();

    const message = String(emit.mock.calls[0]?.[0]?.message);
    expect(message).toMatch(/has not been tested on your asset/iu);
    expect(message).toMatch(/focused verification/iu);
    expect(message).not.toMatch(/you are vulnerable/iu);
  });

  it('links straight to the exposure it is about', async () => {
    const { db } = createDb({ rows: [candidate()] });

    await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(emit.mock.calls[0]?.[0]?.link).toBe('/exposures/match-1');
  });

  it('sends nothing when the organization may not be notified', async () => {
    const { db, updates } = createDb({ rows: [candidate()] });

    const result = await new ExposureNotifier(db, {
      emit,
      canNotifyOrganization: vi.fn().mockResolvedValue(false),
    }).notifyNewExposures();

    expect(result.notified).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('sends nothing when the organization has no eligible recipient', async () => {
    const { db } = createDb({ rows: [candidate()], members: [] });

    const result = await new ExposureNotifier(db, { emit }).notifyNewExposures();

    expect(result.notified).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
