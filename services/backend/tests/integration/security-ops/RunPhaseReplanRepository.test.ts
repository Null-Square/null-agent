import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { setupTestDb } from '../../helpers/testDb';
import {
  organizations,
  runPhaseReplans,
  runPhases,
  runs,
  scopes,
  users,
} from '@/db/schema';
import { RunPhaseReplanRepository } from '@/domains/security-ops/runs/RunPhaseReplanRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type Harness = NonNullable<Awaited<ReturnType<typeof setupTestDb>>>;

const uniqueSlug = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createOpenReplan = async (harness: Harness) => {
  const db = harness.db as any;
  const userId = randomUUID();

  await db.insert(users).values({
    id: userId,
    email: `${uniqueSlug('replan-claim')}@example.com`,
    password_hash: 'test',
  });
  const [organization] = await db
    .insert(organizations)
    .values({ name: 'Replan Claim Org', slug: uniqueSlug('replan-claim-org') })
    .returning({ id: organizations.id });
  const [scope] = await db
    .insert(scopes)
    .values({
      organizationId: organization.id,
      name: 'Replan Claim Scope',
      executionNetwork: 'external',
    })
    .returning({ id: scopes.id });
  const [run] = await db
    .insert(runs)
    .values({
      organizationId: organization.id,
      scopeId: scope.id,
      userId,
      goal: 'Verify durable replan ownership',
      status: 'running',
      executionTarget: 'local',
      trigger: 'manual',
    })
    .returning({ id: runs.id });
  const [phase] = await db
    .insert(runPhases)
    .values({
      runId: run.id,
      ordinal: 1,
      phaseKey: 'enumeration',
      status: 'completed',
      phaseProfile: 'phase-enumeration',
      toolProfile: 'phase-enumeration',
      promptProfile: 'phase-enumeration',
    })
    .returning({ id: runPhases.id });

  const repository = new RunPhaseReplanRepository(harness.db as any);
  const opened = await repository.open({
    runId: run.id,
    phaseId: phase.id,
    requestedPhaseStatus: 'completed',
    reason: 'Planner must revise the remaining phases.',
  });
  if (!opened.row) throw new Error('Expected an open replan fixture.');
  await db
    .update(runPhaseReplans)
    .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(eq(runPhaseReplans.id, opened.row.id));

  return { repository, replanId: opened.row.id };
};

maybeDescribe('RunPhaseReplanRepository recovery claims', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) skip = true;
    } catch {
      skip = true;
    }
  });

  beforeEach(async () => {
    if (!skip) await harness?.truncateAll();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  const itMaybe = (name: string, run: (active: Harness) => Promise<void>) =>
    it(name, async () => {
      if (skip || !harness) return;
      await run(harness);
    });

  itMaybe('allows only one worker to claim one due replan', async (active) => {
    const { repository, replanId } = await createOpenReplan(active);
    const secondRepository = new RunPhaseReplanRepository(active.db as any);
    const expiresAt = new Date(Date.now() + 60_000);

    const claims = await Promise.all([
      repository.claimDue({ claimToken: 'worker-a', expiresAt }),
      secondRepository.claimDue({ claimToken: 'worker-b', expiresAt }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.id).toBe(replanId);

    const [stored] = await active.db
      .select()
      .from(runPhaseReplans)
      .where(eq(runPhaseReplans.id, replanId));
    expect(stored.dispatchAttempts).toBe(1);
    expect(['worker-a', 'worker-b']).toContain(stored.claimToken);
  });

  itMaybe('permits takeover after expiry and rejects the stale owner', async (active) => {
    const { repository, replanId } = await createOpenReplan(active);

    await expect(repository.claimDue({
      claimToken: 'expired-owner',
      expiresAt: new Date(Date.now() - 1_000),
    })).resolves.toMatchObject({ id: replanId });
    await expect(repository.claimDue({
      claimToken: 'new-owner',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toMatchObject({ id: replanId });

    await expect(repository.renewClaim({
      replanId,
      claimToken: 'expired-owner',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toBe(false);
    await expect(repository.scheduleClaimedRetry({
      replanId,
      claimToken: 'expired-owner',
      nextAttemptAt: new Date(Date.now() + 5_000),
      error: 'stale write',
    })).resolves.toBe(false);
    await expect(repository.renewClaim({
      replanId,
      claimToken: 'new-owner',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toBe(true);
  });

  itMaybe('keeps defer, retry, and failure writes fenced to the current owner', async (active) => {
    const { repository, replanId } = await createOpenReplan(active);
    const firstDueAt = new Date(Date.now() + 30_000);

    await repository.claimDue({
      claimToken: 'worker-a',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(repository.deferClaimWithoutAttempt({
      replanId,
      claimToken: 'worker-a',
      nextAttemptAt: firstDueAt,
    })).resolves.toBe(true);

    let [stored] = await active.db
      .select()
      .from(runPhaseReplans)
      .where(eq(runPhaseReplans.id, replanId));
    expect(stored.dispatchAttempts).toBe(0);
    expect(stored.claimToken).toBeNull();
    expect(stored.nextAttemptAt.toISOString()).toBe(firstDueAt.toISOString());
    await expect(repository.claimDue({
      claimToken: 'too-early',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toBeNull();

    await active.db
      .update(runPhaseReplans)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(runPhaseReplans.id, replanId));
    await repository.claimDue({
      claimToken: 'worker-b',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(repository.failClaimed({
      replanId,
      claimToken: 'worker-a',
      error: 'stale failure',
    })).resolves.toBe(false);
    await expect(repository.failClaimed({
      replanId,
      claimToken: 'worker-b',
      error: 'attempts exhausted',
    })).resolves.toBe(true);

    [stored] = await active.db
      .select()
      .from(runPhaseReplans)
      .where(eq(runPhaseReplans.id, replanId));
    expect(stored.status).toBe('failed');
    expect(stored.claimToken).toBeNull();
    expect(stored.closedAt).toBeTruthy();
  });
});
