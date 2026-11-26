import { describe, expect, it, vi } from 'vitest';

import { ExposureLeadInjector } from '@/domains/security-ops/exposure/ExposureLeadInjector';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const candidate = (over: Record<string, unknown> = {}) => ({
  matchId: 'match-1',
  assetId: 'asset-1',
  advisoryId: 'CVE-2026-4834',
  severity: 'critical',
  kevListed: false,
  priorityScore: 82,
  componentKey: 'pkg:wordpress-plugin/elementor',
  componentName: 'Elementor',
  componentVersion: '3.21.4',
  assetValue: 'shop.example.com',
  ...over,
});

/**
 * `select` serves two different queries here — the candidate scan and the
 * per-candidate dedupe check — so results are queued in call order.
 */
const createDb = (selectResults: unknown[][]) => {
  const queue = [...selectResults];
  const inserts: Array<{ values: unknown }> = [];
  const updates: Array<{ values: unknown }> = [];

  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(queue.shift() ?? []));

  return {
    db: {
      select: vi.fn(() => chain),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          inserts.push({ values });
          return {
            returning: vi.fn(() => Promise.resolve([{ id: 'note-1' }])),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: unknown) => ({
          where: vi.fn(() => {
            updates.push({ values });
            return Promise.resolve();
          }),
        })),
      })),
    },
    inserts,
    updates,
  };
};

const inject = (db: unknown, options = {}) =>
  new ExposureLeadInjector(db as never, options, () => NOW).injectForRun({
    organizationId: 'org-1',
    scopeId: 'scope-1',
    userId: 'user-1',
    runId: 'run-1',
  });

describe('ExposureLeadInjector.injectForRun', () => {
  it('renders a lead for an eligible match', async () => {
    const { db, inserts, updates } = createDb([[candidate()], []]);

    const injected = await inject(db);

    expect(injected).toEqual([
      { matchId: 'match-1', noteId: 'note-1', advisoryId: 'CVE-2026-4834' },
    ]);

    const note = inserts[0]?.values as Record<string, any>;
    expect(note.ntype).toBe('validation.lead');
    // Written under the run's owner, because lead closure is checked against the
    // owning user — a lead written by a background job could not be closed.
    expect(note.userId).toBe('user-1');
    expect(note.dedupeKey).toBe('exposure:match-1');
    expect(note.data.exposureMatchId).toBe('match-1');
    expect(note.data.hypothesis).toMatch(/not proof of safety/u);
  });

  it('moves the match to verifying so it is not queued twice', async () => {
    const { db, updates } = createDb([[candidate()], []]);
    await inject(db);
    expect(updates[0]?.values).toMatchObject({ state: 'verifying' });
  });

  it('does not re-ask a match already rendered for an earlier run', async () => {
    const { db, inserts } = createDb([[candidate()], [{ id: 'existing-note' }]]);
    const injected = await inject(db);

    expect(injected).toEqual([]);
    expect(inserts).toHaveLength(0);
  });

  it('caps how many leads one run receives', async () => {
    // Run start loads up to 25 open scope leads; flooding it with Threat Watch
    // work would crowd out the leads the planner actually raised.
    const { db } = createDb([[], []]);
    const injector = new ExposureLeadInjector(db as never, { maxPerRun: 3 }, () => NOW);

    await injector.injectForRun({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      userId: 'user-1',
      runId: 'run-1',
    });

    const chain = (db.select as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(chain.limit).toHaveBeenCalledWith(3);
  });

  it('returns nothing when no match is eligible', async () => {
    const { db, inserts } = createDb([[]]);
    await expect(inject(db)).resolves.toEqual([]);
    expect(inserts).toHaveLength(0);
  });
});

describe('ExposureLeadInjector.applyLeadOutcome', () => {
  const applyOutcome = async (outcome: Parameters<ExposureLeadInjector['applyLeadOutcome']>[0]['outcome']) => {
    const { db, updates } = createDb([]);
    const result = await new ExposureLeadInjector(db as never, {}, () => NOW).applyLeadOutcome({
      organizationId: 'org-1',
      exposureMatchId: 'match-1',
      outcome,
    });
    return { result, updates };
  };

  it('maps a validated lead to a confirmed exposure', async () => {
    const { result, updates } = await applyOutcome('validated');
    expect(result.state).toBe('confirmed');
    expect(updates[0]?.values).toMatchObject({ state: 'confirmed', verifiedAt: NOW });
  });

  it('maps a false positive to not_reproduced, not to "safe"', async () => {
    const { result } = await applyOutcome('false_positive');
    expect(result.state).toBe('not_reproduced');
  });

  it('returns a blocked or deferred lead to the queue', async () => {
    // The run could not answer the question, which is different from having
    // answered it in the negative.
    expect((await applyOutcome('blocked')).result.state).toBe('notified');
    expect((await applyOutcome('deferred')).result.state).toBe('notified');
  });

  it('resolves a superseded lead', async () => {
    expect((await applyOutcome('superseded')).result.state).toBe('resolved');
  });
});
