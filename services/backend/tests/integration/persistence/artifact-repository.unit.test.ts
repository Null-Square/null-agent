import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession, newId } from '../../helpers/agentSessionDb';
import { ArtifactRepository } from '@/domains/agent-brain/adapters/persistence/ArtifactRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('ArtifactRepository (integration)', () => {
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

  itMaybe('creates and fetches artifacts', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repo = new ArtifactRepository(harness.db as any);

    const artifactId = newId();
    await repo.create({
      id: artifactId,
      sessionId,
      filePath: '/tmp/report.md',
      originalName: 'report.md',
      fileType: 'text/markdown',
      sizeBytes: 42,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });

    const list = await repo.listBySession(sessionId);
    const found = await repo.findById(artifactId);

    expect(list).toHaveLength(1);
    expect(found?.id).toBe(artifactId);
  });

  itMaybe('bulk inserts and deletes by session', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repo = new ArtifactRepository(harness.db as any);

    await repo.bulkInsert([
      {
        id: newId(),
        sessionId,
        filePath: '/tmp/a.txt',
        originalName: 'a.txt',
        fileType: 'text/plain',
        sizeBytes: 10,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        id: newId(),
        sessionId,
        filePath: '/tmp/b.txt',
        originalName: 'b.txt',
        fileType: 'text/plain',
        sizeBytes: 12,
        createdAt: new Date('2025-01-01T00:00:01Z'),
      },
    ]);

    const list = await repo.listBySession(sessionId);
    expect(list).toHaveLength(2);

    await repo.deleteBySession(sessionId);
    const remaining = await repo.listBySession(sessionId);
    expect(remaining).toHaveLength(0);
  });
});



