import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession, newId } from '../../helpers/agentSessionDb';
import { SessionRetentionReaper } from '@/domains/agent-brain/application/services/SessionRetentionReaper';
import { SessionRetentionAdapter } from '@/domains/agent-brain/adapters/SessionRetentionAdapter';
import { agentSessions } from '@/db/schema';
import { eq } from 'drizzle-orm';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('SessionRetentionReaper (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
      }
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness.truncateAll();
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('deletes old sessions but preserves recent activity and retry schedules', async () => {
    if (!harness) return;
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    const deletable = await insertAgentSession(harness.db, {
      lastActiveAt: old,
      createdAt: old,
      updatedAt: old,
    });
    const activeRecent = await insertAgentSession(harness.db, {
      lastActiveAt: new Date(now.getTime() - 10_000),
    });
    const staleIdle = await insertAgentSession(harness.db, {
      lastActiveAt: old,
    });
    const scheduledRetry = await insertAgentSession(harness.db, {
      lastActiveAt: old,
      nextAttemptAt: new Date(now.getTime() + 60 * 60 * 1000),
    });

    const reaper = new SessionRetentionReaper(
      { retentionEnabled: true, maxAgeDays: 1, maxCountPerUser: 0 } as any,
      new SessionRetentionAdapter(harness.db),
    );

    const result = await reaper.runOnce();
    expect(result.deletedCount).toBe(2);

    const remaining = await harness.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.id, activeRecent));
    expect(remaining).toHaveLength(1);

    const retryStill = await harness.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.id, scheduledRetry));
    expect(retryStill).toHaveLength(1);

    const deletedRows = await harness.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.id, deletable));
    expect(deletedRows).toHaveLength(0);

    const staleRows = await harness.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.id, staleIdle));
    expect(staleRows).toHaveLength(0);
  });

  itMaybe('enforces max sessions per user by deleting the oldest', async () => {
    if (!harness) return;
    const userId = newId();
    const now = new Date();
    const session1 = await insertAgentSession(harness.db, {
      userId,
      lastActiveAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const session2 = await insertAgentSession(harness.db, {
      userId,
      lastActiveAt: new Date(now.getTime() - 30 * 60 * 1000),
    });
    const session3 = await insertAgentSession(harness.db, {
      userId,
      lastActiveAt: new Date(now.getTime() - 2 * 60 * 1000),
    });

    const reaper = new SessionRetentionReaper(
      { retentionEnabled: true, maxAgeDays: 0, maxCountPerUser: 2 } as any,
      new SessionRetentionAdapter(harness.db),
    );

    const result = await reaper.runOnce();
    expect(result.deletedCount).toBe(1);

    const remaining = await harness.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));
    const remainingIds = remaining.map((row) => row.id);
    expect(remainingIds).toContain(session2);
    expect(remainingIds).toContain(session3);
    expect(remainingIds).not.toContain(session1);
  });
});



