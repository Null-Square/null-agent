import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession, newId } from '../../helpers/agentSessionDb';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('SessionRepository (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let repo: SessionRepository;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
        return;
      }
      repo = new SessionRepository(harness.db as any);
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

  itMaybe('honors optimistic updates based on metadata.version', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db, {
      metadata: { version: 2 },
      title: 'old',
    });

    await expect(repo.update(sessionId, { title: 'nope' }, { expectedVersion: 1 })).rejects.toMatchObject({
      code: 'session.conflict',
      status: 409,
    });

    await repo.update(sessionId, { title: 'new' }, { expectedVersion: 2 });
    const updated = await repo.findById(sessionId);
    expect(updated?.title).toBe('new');
  });

  itMaybe('sets and clears blocked reason with metadata', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);

    const set = await repo.setBlockedReason(sessionId, 'credits_exhausted', { resetAt: 123 });
    expect(set).toBe(true);

    const row = await repo.findById(sessionId);
    expect(row?.blockedReason).toBe('credits_exhausted');
    expect((row?.metadata as any)?.blockedMeta).toEqual({ resetAt: 123 });

    const wrongClear = await repo.clearBlockedReason(sessionId, 'awaiting_user');
    expect(wrongClear).toBe(false);

    const stillBlocked = await repo.findById(sessionId);
    expect(stillBlocked?.blockedReason).toBe('credits_exhausted');

    const cleared = await repo.clearBlockedReason(sessionId, 'credits_exhausted');
    expect(cleared).toBe(true);

    const clearedRow = await repo.findById(sessionId);
    expect(clearedRow?.blockedReason ?? null).toBeNull();
  });

  itMaybe('allows only one worker to claim a due journal continuation', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db, {
      mode: 'automated',
      nextAttemptAt: new Date(Date.now() - 1_000),
    });
    const secondRepo = new SessionRepository(harness.db as any);
    const expiresAt = new Date(Date.now() + 60_000);

    const claims = await Promise.all([
      repo.claimDueRecovery({ claimToken: 'worker-a', expiresAt }),
      secondRepo.claimDueRecovery({ claimToken: 'worker-b', expiresAt }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.session.id).toBe(sessionId);
  });

  itMaybe('rejects durable state writes from a stale execution owner', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db, { mode: 'automated' });
    await expect(repo.acquireExecutionClaim({
      sessionId,
      claimToken: 'current-owner',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toBe(true);

    await expect(repo.setBlockedReason(
      sessionId,
      'error',
      { code: 'stale' },
      'stale-owner',
    )).resolves.toBe(false);
    await expect(repo.setCompleted(sessionId, true, 'stale-owner')).resolves.toBe(false);

    const row = await repo.findById(sessionId);
    expect(row?.blockedReason).toBeNull();
    expect(row?.completed).toBe(false);
  });

  itMaybe('allows takeover only after an execution claim expires', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db, { mode: 'automated' });
    await expect(repo.acquireExecutionClaim({
      sessionId,
      claimToken: 'expired-owner',
      expiresAt: new Date(Date.now() - 1_000),
    })).resolves.toBe(true);

    await expect(repo.acquireExecutionClaim({
      sessionId,
      claimToken: 'new-owner',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toBe(true);
    await expect(repo.renewExecutionClaim({
      sessionId,
      claimToken: 'expired-owner',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toBe(false);
    await expect(repo.ownsExecutionClaim(sessionId, 'new-owner')).resolves.toBe(true);
  });

  itMaybe('treats metadata-completed sessions as terminal runtime snapshots', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db, {
      mode: 'automated',
      completed: false,
      blockedReason: 'system_paused',
      metadata: {
        flags: { session: { completed: true } },
        blockedMeta: { code: 'worker_interrupted' },
      },
    });

    const snapshot = await repo.getRuntimeSnapshot(sessionId);

    expect(snapshot?.completed).toBe(true);
    expect(snapshot?.blockedReason).toBeNull();
    expect(snapshot?.blockedMeta).toEqual({ code: 'worker_interrupted' });
  });

  itMaybe('updates title and completion status', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db, { title: 'old' });

    const renamed = await repo.updateTitle(sessionId, 'new title');
    expect(renamed).toBe(true);

    const marked = await repo.setCompleted(sessionId, true);
    expect(marked).toBe(true);

    const completed = await repo.getCompleted(sessionId);
    expect(completed).toBe(true);

    const row = await repo.findById(sessionId);
    expect(row?.title).toBe('new title');
    expect(row?.completed).toBe(true);
  });

  itMaybe('counts and lists sessions per user', async () => {
    if (!harness) return;
    const userId = newId();
    await insertAgentSession(harness.db, { userId, lastActiveAt: new Date('2025-01-01T00:00:00Z') });
    await insertAgentSession(harness.db, { userId, lastActiveAt: new Date('2025-01-02T00:00:00Z') });
    await insertAgentSession(harness.db, { userId: newId() });

    const count = await repo.countByUserId(userId);
    expect(count).toBe(2);

    const rows = await repo.listByUser(userId, { limit: 1, offset: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
  });
});



