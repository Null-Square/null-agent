import { describe, expect, it, vi } from 'vitest';

import { ExposureVerificationService } from '@/domains/security-ops/exposure/ExposureVerificationService';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const matchRow = (over: Record<string, unknown> = {}) => ({
  state: 'notified',
  scopeId: 'scope-1',
  verificationRunId: null,
  assetValue: 'shop.example.com',
  componentKey: 'pkg:wordpress-plugin/elementor',
  componentDisplayName: 'Elementor',
  resolvedVersion: '3.21.4',
  advisoryCanonicalId: 'CVE-2026-4834',
  ...over,
});

/** Each entry is one queued `select(...).limit()` result, i.e. a row array. */
const createDb = (rows: unknown[][]) => {
  const updateCalls: Array<Record<string, unknown>> = [];
  const insertCalls: Array<Record<string, unknown>> = [];
  const queue = [...rows];

  const selectChain: Record<string, unknown> = {};
  selectChain.from = vi.fn(() => selectChain);
  selectChain.innerJoin = vi.fn(() => selectChain);
  // Recovery joins `runs` so a still-running verification is not written off on
  // age alone.
  selectChain.leftJoin = vi.fn(() => selectChain);
  selectChain.where = vi.fn(() => selectChain);
  selectChain.limit = vi.fn(() => Promise.resolve(queue.shift() ?? []));

  return {
    db: {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => ({
        set: vi.fn((values: unknown) => ({
          // `where` is both awaitable and chainable: the claim-first start uses
          // `.returning()` to learn whether it won the race, while other updates
          // simply await the statement.
          where: vi.fn((where: unknown) => {
            updateCalls.push({ values, where });
            const settled = Promise.resolve([{ id: 'match-1' }]);
            return Object.assign(settled, {
              returning: vi.fn(() => Promise.resolve([{ id: 'match-1' }])),
            });
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertCalls.push({ values });
          return Promise.resolve();
        }),
      })),
    },
    updateCalls,
    insertCalls,
  };
};

const createDeps = () => {
  const enforceVerificationAdmission = vi.fn().mockResolvedValue(undefined);
  const startVerificationRun = vi.fn().mockResolvedValue({ runId: 'run-1' });
  return { enforceVerificationAdmission, startVerificationRun };
};

describe('ExposureVerificationService.buildGoal', () => {
  const goal = ExposureVerificationService.buildGoal({
    advisoryId: 'CVE-2026-4834',
    assetValue: 'shop.example.com',
    componentDisplayName: 'Elementor',
    observedVersion: '3.21.4',
  });

  it('names exactly one advisory and one asset', () => {
    expect(goal).toContain('CVE-2026-4834');
    expect(goal).toContain('shop.example.com');
    expect(goal).toContain('Elementor 3.21.4');
  });

  it('forbids wandering into a general pentest', () => {
    // A verification that becomes a full pentest destroys the cost argument
    // that makes one-click verification viable at all.
    expect(goal).toMatch(/Do not test any other/u);
  });

  it('warns against trusting a version string alone', () => {
    expect(goal).toMatch(/backport/iu);
  });

  it('states that failure to reproduce is not proof of safety', () => {
    expect(goal).toMatch(/not proof of safety/u);
  });
});

describe('ExposureVerificationService.startVerification', () => {
  it('enforces admission before spending anything', async () => {
    // StartRunService applies no access control; a new entry point inherits
    // nothing, so forgetting this would let anyone spend an org's credits.
    const { db } = createDb([[matchRow()]]);
    const deps = createDeps();

    await new ExposureVerificationService(db as never, deps, () => NOW).startVerification({
      organizationId: 'org-1',
      userId: 'user-1',
      matchId: 'match-1',
    });

    expect(deps.enforceVerificationAdmission).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
    });
    expect(deps.startVerificationRun).toHaveBeenCalled();
  });

  it('passes the match identity through to the run', async () => {
    const { db } = createDb([[matchRow()]]);
    const deps = createDeps();

    const executionSelection = {
      routeId: 'codex-subscription',
      catalogueRevision: 'catalogue-1',
      modelId: 'gpt-5.6-sol',
      controls: { effort: 'high' },
    };
    await new ExposureVerificationService(db as never, deps, () => NOW).startVerification({
      organizationId: 'org-1',
      userId: 'user-1',
      matchId: 'match-1',
      executionSelection,
    });

    expect(deps.startVerificationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'scope-1',
        vars: expect.objectContaining({
          exposureMatchId: 'match-1',
          advisoryId: 'CVE-2026-4834',
          observedVersion: '3.21.4',
        }),
        executionSelection,
      }),
    );
  });

  it('claims the match before spending, then records the run', async () => {
    // The claim is a conditional update: two concurrent requests cannot both
    // pass it, so only one can start a paid run.
    const { db, updateCalls, insertCalls } = createDb([[matchRow()]]);
    const deps = createDeps();

    await new ExposureVerificationService(db as never, deps, () => NOW).startVerification({
      organizationId: 'org-1',
      userId: 'user-1',
      matchId: 'match-1',
    });

    expect(updateCalls[0]?.values).toMatchObject({ state: 'verifying' });
    expect(updateCalls[1]?.values).toMatchObject({ verificationRunId: 'run-1' });
    expect(insertCalls[0]?.values).toMatchObject({ fromState: 'notified', toState: 'verifying' });
  });

  it('returns the in-flight run instead of starting a second', async () => {
    // A double-click or a retry must not spend twice.
    const { db } = createDb([[matchRow({ state: 'verifying', verificationRunId: 'run-existing' })]]);
    const deps = createDeps();

    const result = await new ExposureVerificationService(db as never, deps, () => NOW).startVerification(
      { organizationId: 'org-1', userId: 'user-1', matchId: 'match-1' },
    );

    expect(result).toMatchObject({ runId: 'run-existing', alreadyRunning: true });
    expect(deps.startVerificationRun).not.toHaveBeenCalled();
    expect(deps.enforceVerificationAdmission).not.toHaveBeenCalled();
  });

  it('refuses to verify a dismissed or resolved match', async () => {
    for (const state of ['dismissed', 'resolved']) {
      const { db } = createDb([[matchRow({ state })]]);
      const deps = createDeps();

      await expect(
        new ExposureVerificationService(db as never, deps, () => NOW).startVerification({
          organizationId: 'org-1',
          userId: 'user-1',
          matchId: 'match-1',
        }),
      ).rejects.toThrow(/Cannot verify/u);
      expect(deps.startVerificationRun).not.toHaveBeenCalled();
    }
  });

  it('releases the claim when the run fails to start', async () => {
    // Otherwise the match is stranded in `verifying` with no run behind it until
    // the recovery pass eventually writes it off.
    const { db, updateCalls } = createDb([[matchRow()]]);
    const deps = createDeps();
    deps.startVerificationRun.mockRejectedValue(new Error('no capacity'));

    await expect(
      new ExposureVerificationService(db as never, deps, () => NOW).startVerification({
        organizationId: 'org-1',
        userId: 'user-1',
        matchId: 'match-1',
      }),
    ).rejects.toThrow(/no capacity/u);

    expect(updateCalls.at(-1)?.values).toMatchObject({ state: 'notified' });
  });

  it('rejects a match belonging to another organization', async () => {
    const { db } = createDb([[]]);
    const deps = createDeps();

    await expect(
      new ExposureVerificationService(db as never, deps, () => NOW).startVerification({
        organizationId: 'org-other',
        userId: 'user-1',
        matchId: 'match-1',
      }),
    ).rejects.toThrow(/not found/iu);
  });
});

describe('ExposureVerificationService.submitVerification', () => {
  const submit = async (outcome: 'confirmed' | 'not_reproduced' | 'inconclusive') => {
    const { db, updateCalls } = createDb([[matchRow({ state: 'verifying' })]]);
    const service = new ExposureVerificationService(db as never, createDeps(), () => NOW);
    const result = await service.submitVerification({
      organizationId: 'org-1',
      matchId: 'match-1',
      outcome,
      method: 'Attempted the documented vector',
    });
    return { result, updateCalls };
  };

  it('maps each outcome to its state', async () => {
    expect((await submit('confirmed')).result.state).toBe('confirmed');
    expect((await submit('not_reproduced')).result.state).toBe('not_reproduced');
    expect((await submit('inconclusive')).result.state).toBe('inconclusive');
  });

  it('links the finding when one was created', async () => {
    const { db, updateCalls } = createDb([[matchRow({ state: 'verifying' })]]);
    await new ExposureVerificationService(db as never, createDeps(), () => NOW).submitVerification({
      organizationId: 'org-1',
      matchId: 'match-1',
      outcome: 'confirmed',
      method: 'Reproduced',
      riskId: 'risk-1',
    });

    expect(updateCalls[0]?.values).toMatchObject({ state: 'confirmed', riskId: 'risk-1' });
  });

  it('refuses a submission for a match that is not awaiting one', async () => {
    // Otherwise a late result could overwrite a customer's own dismissal.
    const { db } = createDb([[matchRow({ state: 'dismissed' })]]);

    await expect(
      new ExposureVerificationService(db as never, createDeps(), () => NOW).submitVerification({
        organizationId: 'org-1',
        matchId: 'match-1',
        outcome: 'confirmed',
        method: 'Reproduced',
      }),
    ).rejects.toThrow(/not awaiting verification/u);
  });
});

describe('ExposureVerificationService.recoverStalledVerifications', () => {
  it('returns stranded matches to the queue as inconclusive', async () => {
    // A crashed or cancelled run would otherwise leave a match in `verifying`
    // permanently: invisible, never re-verifiable, never alertable.
    const { db, updateCalls } = createDb([
      [{ id: 'match-1', organizationId: 'org-1' }, { id: 'match-2', organizationId: 'org-1' }],
    ]);

    const recovered = await new ExposureVerificationService(
      db as never,
      createDeps(),
      () => NOW,
    ).recoverStalledVerifications({ olderThanMinutes: 60 });

    expect(recovered).toBe(2);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.values).toMatchObject({ state: 'inconclusive' });
  });

  it('does nothing when no verification is stalled', async () => {
    const { db, updateCalls } = createDb([[]]);

    const recovered = await new ExposureVerificationService(
      db as never,
      createDeps(),
      () => NOW,
    ).recoverStalledVerifications({ olderThanMinutes: 60 });

    expect(recovered).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });
});
