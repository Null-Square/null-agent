import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession, newId } from '../../helpers/agentSessionDb';
import { CheckpointRepository } from '@/domains/agent-brain/adapters/persistence/CheckpointRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('CheckpointRepository (integration)', () => {
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

  itMaybe('creates, lists, and deletes checkpoints', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repo = new CheckpointRepository(harness.db as any);

    const checkpointId = newId();
    await repo.create({
      id: checkpointId,
      sessionId,
      metadata: { filesCount: 2 },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });

    const list = await repo.listBySession(sessionId);
    const found = await repo.findById(checkpointId);

    expect(list).toHaveLength(1);
    expect(found?.id).toBe(checkpointId);

    await repo.delete(checkpointId);
    const remaining = await repo.listBySession(sessionId);
    expect(remaining).toHaveLength(0);
  });
});



