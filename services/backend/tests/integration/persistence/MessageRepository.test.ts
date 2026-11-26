import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession, newId } from '../../helpers/agentSessionDb';
import { MessageRepository } from '@/domains/agent-brain/adapters/persistence/MessageRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('MessageRepository (integration)', () => {
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

  itMaybe('appends messages and orders by createdAt', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repo = new MessageRepository(harness.db as any);

    const older = { id: newId(), createdAt: new Date('2025-01-01T00:00:00Z') };
    const newer = { id: newId(), createdAt: new Date('2025-01-01T00:00:10Z') };

    await repo.appendMany([
      {
        id: newer.id,
        sessionId,
        role: 'assistant',
        content: 'B',
        metadata: {},
        createdAt: newer.createdAt,
      },
      {
        id: older.id,
        sessionId,
        role: 'user',
        content: 'A',
        metadata: {},
        createdAt: older.createdAt,
      },
    ]);

    const rows = await repo.listBySession(sessionId);

    expect(rows.map((row) => row.content)).toEqual(['A', 'B']);
  });

  itMaybe('paginates forward and deletes by session', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repo = new MessageRepository(harness.db as any);

    const messages = [
      { id: newId(), createdAt: new Date('2025-01-01T00:00:00Z'), content: 'A' },
      { id: newId(), createdAt: new Date('2025-01-01T00:00:01Z'), content: 'B' },
      { id: newId(), createdAt: new Date('2025-01-01T00:00:02Z'), content: 'C' },
    ];

    await repo.appendMany(
      messages.map((message) => ({
        id: message.id,
        sessionId,
        role: 'user',
        content: message.content,
        metadata: {},
        createdAt: message.createdAt,
      })),
    );

    const page = await repo.listBySessionPaged(sessionId, { limit: 2 });

    expect(page.meta.hasMore).toBe(true);
    expect(page.data.map((row) => row.content)).toEqual(['A', 'B']);
    expect(page.meta.nextCursor).toBeDefined();

    await repo.deleteBySession(sessionId);
    const remaining = await repo.listBySession(sessionId);
    expect(remaining).toHaveLength(0);
  });
});



