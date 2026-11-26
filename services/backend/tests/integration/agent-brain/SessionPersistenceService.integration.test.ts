import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession } from '../../helpers/agentSessionDb';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  SessionRepository,
  MessageRepository,
  ArtifactRepository,
  CheckpointRepository,
} from '@/domains/agent-brain/adapters/persistence';
import { SessionPersistenceService } from '@/domains/agent-brain/infrastructure/persistence/SessionPersistenceService';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('SessionPersistenceService (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;
  const workspaceDirs: string[] = [];

  const makeWorkspaceDir = (id: string) => {
    const dir = path.join(os.tmpdir(), `ns-session-${id}`);
    workspaceDirs.push(dir);
    return dir;
  };

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
    for (const dir of workspaceDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness.truncateAll();
    await harness.pool.query('TRUNCATE TABLE agent_artifacts, agent_checkpoints RESTART IDENTITY CASCADE;');
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('hydrates recent sessions with limits and builds usage metadata', async () => {
    if (!harness) return;
    const now = new Date();
    const recentId = randomUUID();
    const oldId = randomUUID();

    const recentWorkspace = makeWorkspaceDir(recentId);
    const oldWorkspace = makeWorkspaceDir(oldId);

    await insertAgentSession(harness.db, {
      id: recentId,
      workspaceDir: recentWorkspace,
      lastActiveAt: now,
      metadata: {
        flags: {
          token_usage_totals: {
            promptTokens: 5,
            completionTokens: 3,
            totalTokens: 8,
            credits: 1.25,
          },
        },
      },
    });

    await insertAgentSession(harness.db, {
      id: oldId,
      workspaceDir: oldWorkspace,
      lastActiveAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
    });

    const messageRepo = new MessageRepository(harness.db as any);
    await messageRepo.appendMany([
      {
        id: randomUUID(),
        sessionId: recentId,
        role: 'user',
        content: 'm1',
        createdAt: new Date(now.getTime() - 3000),
        metadata: {},
      },
      {
        id: randomUUID(),
        sessionId: recentId,
        role: 'assistant',
        content: 'm2',
        createdAt: new Date(now.getTime() - 2000),
        metadata: {},
      },
      {
        id: randomUUID(),
        sessionId: recentId,
        role: 'assistant',
        content: 'm3',
        createdAt: new Date(now.getTime() - 1000),
        metadata: {},
      },
    ]);

    const artifactRepo = new ArtifactRepository(harness.db as any);
    await artifactRepo.bulkInsert([
      {
        id: randomUUID(),
        sessionId: recentId,
        filePath: 'a.txt',
        originalName: 'a.txt',
        fileType: 'text/plain',
        sizeBytes: 10,
        createdAt: now,
      },
      {
        id: randomUUID(),
        sessionId: recentId,
        filePath: 'b.txt',
        originalName: 'b.txt',
        fileType: 'text/plain',
        sizeBytes: 20,
        createdAt: now,
      },
    ]);

    const checkpointRepo = new CheckpointRepository(harness.db as any);
    await checkpointRepo.create({
      id: randomUUID(),
      sessionId: recentId,
      parentId: null,
      metadata: { id: 'cp-1', ts: now.toISOString(), filesCount: 1, sizeBytes: 5 },
      createdAt: now,
    });
    await checkpointRepo.create({
      id: randomUUID(),
      sessionId: recentId,
      parentId: null,
      metadata: { id: 'cp-2', ts: now.toISOString(), filesCount: 2, sizeBytes: 8 },
      createdAt: now,
    });

    const persistence = new SessionPersistenceService({
      sessions: new SessionRepository(harness.db as any),
      messages: messageRepo,
      artifacts: artifactRepo,
      checkpoints: checkpointRepo,
    });

    const sessions = await persistence.hydrateAll({
      maxSessions: 1,
      maxMessages: 2,
      maxArtifacts: 1,
      maxCheckpoints: 1,
      recentMs: 24 * 60 * 60 * 1000,
    });

    expect(sessions).toHaveLength(1);
    const hydrated = sessions[0];
    expect(hydrated.id).toBe(recentId);
    expect(hydrated.messages.map((m) => m.content)).toEqual(['m2', 'm3']);
    expect(hydrated.artifacts?.length).toBe(1);
    expect(Object.keys(hydrated.checkpoints)).toHaveLength(1);
    expect(hydrated.usage?.totalTokens).toBe(8);
    expect(hydrated.usage?.credits).toBeCloseTo(1.25);
    expect(fs.existsSync(recentWorkspace)).toBe(true);
  });

  itMaybe('returns undefined when hydrating a missing session', async () => {
    if (!harness) return;
    const persistence = new SessionPersistenceService({
      sessions: new SessionRepository(harness.db as any),
      messages: new MessageRepository(harness.db as any),
    });

    const session = await persistence.hydrateSession('missing-session');
    expect(session).toBeUndefined();
  });

  itMaybe('does not let mutable metadata persistence overwrite durable completion', async () => {
    if (!harness) return;
    const sessionId = randomUUID();
    const workspaceDir = makeWorkspaceDir(sessionId);
    await insertAgentSession(harness.db, {
      id: sessionId,
      mode: 'automated',
      workspaceDir,
      metadata: { version: 0 },
      completed: true,
    });

    const sessionRepo = new SessionRepository(harness.db as any);
    const persistence = new SessionPersistenceService({
      sessions: sessionRepo,
      messages: new MessageRepository(harness.db as any),
    });

    await persistence.persistMetadata({
      id: sessionId,
      version: 1,
      lastActive: Date.now(),
      flags: { session: { completed: false } },
      completed: false,
    } as any);

    const row = await sessionRepo.findById(sessionId);
    expect(row?.completed).toBe(true);
    expect((row?.metadata as any)?.flags?.session?.completed).toBeUndefined();

    const hydrated = await persistence.hydrateSession(sessionId);
    expect(hydrated?.completed).toBe(true);
  });
});



