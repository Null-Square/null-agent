import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
/**
 * ToolExecutionAdapter DB integration test.
 *
 * Ensures tool executions are persisted and deduped by (sessionId, toolCallId).
 * Requires TEST_DATABASE_URL. Skips otherwise.
 */

import { v4 as uuidv4 } from 'uuid';
import { setupTestDb } from '../../helpers/testDb';
import { ToolExecutionAdapter } from '@/domains/agent-brain/adapters/ToolExecutionAdapter';
import { agentSessions } from '@/db/schema';

const dbUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = dbUrl ? describe : describe.skip;

maybeDescribe('ToolExecutionAdapter DB', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  let adapter: ToolExecutionAdapter;
  let sessionId: string;

  beforeAll(async () => {
    harness = await setupTestDb();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    await harness?.truncateAll();
    adapter = new ToolExecutionAdapter(harness!.db as any);
    sessionId = uuidv4();
    await harness!.db.insert(agentSessions).values({
      id: sessionId,
      mode: 'automated',
      workspaceDir: `/tmp/${sessionId}`,
      metadata: {},
      plan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    });
  });

  it('creates, completes, and fetches by toolCallId', async () => {
    const toolCallId = uuidv4();
    const modelRequestId = uuidv4();
    const turnId = 'turn-1';

    const created = await adapter.create({
      sessionId,
      turnId,
      toolCallId,
      toolName: 'test_tool',
      modelRequestId,
      args: { a: 1 },
    });
    expect(created.toolCallId).toBe(toolCallId);
    expect(created.modelRequestId).toBe(modelRequestId);
    expect(created.status).toBe('claimed');

    await adapter.markStarted({ sessionId, toolCallId });
    await adapter.complete({
      sessionId,
      toolCallId,
      result: { ok: true },
      durationMs: 10,
    });

    const fetched = await adapter.findByToolCallId(sessionId, toolCallId);
    expect(fetched).toBeDefined();
    expect(fetched?.status).toBe('succeeded');
    expect(fetched?.modelRequestId).toBe(modelRequestId);
    expect((fetched?.result as any).ok).toBe(true);
  });

  it('returns the same record on findByToolCallId (caller dedup)', async () => {
    const toolCallId = uuidv4();
    await adapter.create({
      sessionId,
      turnId: 'turn-1',
      toolCallId,
      toolName: 'test_tool',
    });

    const found = await adapter.findByToolCallId(sessionId, toolCallId);
    expect(found).toBeDefined();
    expect(found?.toolCallId).toBe(toolCallId);
  });
});







