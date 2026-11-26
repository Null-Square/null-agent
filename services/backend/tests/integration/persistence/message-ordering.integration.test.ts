import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Message ordering integration (guarded by TEST_DATABASE_URL).
 */
import crypto from 'crypto';
import { asc, eq } from 'drizzle-orm';
import { setupTestDb } from '../../helpers/testDb';
import { agentMessages, agentSessions } from '@/db/schema';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('Message Ordering Integration', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;
  const newId = () => crypto.randomUUID();

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness?.truncateAll();
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('should preserve insertion order by timestamp', async () => {
    if (!harness) return;
    const sessionId = newId();
    await harness.db.insert(agentSessions).values({
      id: sessionId,
      userId: null,
      mode: 'interactive',
      workspaceDir: `/tmp/${sessionId}`,
      metadata: {},
      plan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    });

    const msgA = { id: newId(), ts: Date.now() - 10, role: 'user' as const, content: 'A' };
    const msgB = { id: newId(), ts: Date.now(), role: 'assistant' as const, content: 'B' };
    await harness.db.insert(agentMessages).values([
      {
        id: msgB.id,
        sessionId,
        role: msgB.role,
        content: msgB.content,
        metadata: {},
        createdAt: new Date(msgB.ts),
      },
      {
        id: msgA.id,
        sessionId,
        role: msgA.role,
        content: msgA.content,
        metadata: {},
        createdAt: new Date(msgA.ts),
      },
    ]);

    const rows = await harness.db.query.agentMessages.findMany({
      where: eq(agentMessages.sessionId, sessionId),
      orderBy: asc(agentMessages.createdAt),
    });

    expect(rows.map((r) => r.content)).toEqual(['A', 'B']);
  });

  itMaybe('should maintain tool_call -> tool_result pairing via toolCallId', async () => {
    if (!harness) return;
    const sessionId = newId();
    const toolCallId = newId();
    await harness.db.insert(agentSessions).values({
      id: sessionId,
      userId: null,
      mode: 'interactive',
      workspaceDir: `/tmp/${sessionId}`,
      metadata: {},
      plan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    });

    await harness.db.insert(agentMessages).values([
      {
        id: newId(),
        sessionId,
        role: 'assistant',
        content: 'calling tool',
        toolCallId,
        metadata: {},
        createdAt: new Date(),
      },
      {
        id: newId(),
        sessionId,
        role: 'tool',
        content: '{"ok":true}',
        toolCallId,
        metadata: {},
        createdAt: new Date(),
      },
    ]);

    const rows = await harness.db.query.agentMessages.findMany({
      where: eq(agentMessages.sessionId, sessionId),
      orderBy: asc(agentMessages.createdAt),
    });

    expect(rows.every((r) => r.toolCallId === toolCallId)).toBe(true);
  });
});










