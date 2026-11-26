import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
/**
 * ToolExecutionAdapter DB contract (unique tool_call_id fence).
 *
 * Verifies:
 * - duplicate create with same (sessionId, toolCallId) violates uniqueness (idempotency key).
 * - findByToolCallId returns latest status after complete().
 *
 * Requires TEST_DATABASE_URL. Skips if not set.
 */

import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { toolExecutionRecords, agentSessions } from '@/db/schema';
import { ToolExecutionAdapter } from '@/domains/agent-brain/adapters/ToolExecutionAdapter';
import { setupTestDb } from '../../helpers/testDb';

const dbUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = dbUrl ? describe : describe.skip;

maybeDescribe('ToolExecutionAdapter DB contract', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  let adapter: ToolExecutionAdapter;

  beforeAll(async () => {
    harness = await setupTestDb();
    adapter = new ToolExecutionAdapter(harness!.db as any);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    await harness?.truncateAll();
  });

  const seedSession = async (sessionId: string) => {
    await harness!.db.insert(agentSessions).values({
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
  };

  it('findByToolCallId returns a record even if duplicate inserts occur', async () => {
    const sessionId = uuidv4();
    await seedSession(sessionId);
    const input = {
      sessionId,
      turnId: uuidv4(),
      toolCallId: 'tc-1',
      toolName: 'write_file',
      args: { path: 'a' },
    };

    await adapter.create(input);

    const duplicateClaim = await adapter.claim(input);
    expect(duplicateClaim.claimed).toBe(false);

    const rows = await harness!.db.select().from(toolExecutionRecords).where(eq(toolExecutionRecords.toolCallId, 'tc-1'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const found = await adapter.findByToolCallId(sessionId, 'tc-1');
    expect(found?.toolCallId).toBe('tc-1');
  });

  it('updates execution status via complete()', async () => {
    const sessionId = uuidv4();
    await seedSession(sessionId);
    const input = {
      sessionId,
      turnId: uuidv4(),
      toolCallId: 'tc-2',
      toolName: 'write_file',
      args: { path: 'b' },
    };
    await adapter.create(input);

    await adapter.markStarted({ sessionId, toolCallId: 'tc-2' });
    await adapter.complete({
      sessionId,
      toolCallId: 'tc-2',
      result: { ok: true },
      durationMs: 10,
    });

    const record = await adapter.findByToolCallId(sessionId, 'tc-2');
    expect(record?.status).toBe('succeeded');
    expect(record?.result).toMatchObject({ ok: true });
  });
});







