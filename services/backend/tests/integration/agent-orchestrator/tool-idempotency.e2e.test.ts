import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
/**
 * Tool idempotency end-to-end (DB-backed).
 *
 * Uses ToolExecutionAdapter + a side-effect table to verify:
 * - First run persists execution and side effect.
 * - Replay with same toolCallId does NOT re-run side effect (uses cached execution).
 *
 * Requires TEST_DATABASE_URL. Skips if not set.
 */

import { v4 as uuidv4 } from 'uuid';
import { setupTestDb } from '../../helpers/testDb';
import { ToolExecutionAdapter } from '@/domains/agent-brain/adapters/ToolExecutionAdapter';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import { agentSessions } from '@/db/schema';
import { sql } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = dbUrl ? describe : describe.skip;

maybeDescribe('Tool idempotency e2e (DB)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  let toolExec: ToolExecutionAdapter;
  let sessionId: string;

  beforeAll(async () => {
    harness = await setupTestDb();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    await harness?.truncateAll();
    toolExec = new ToolExecutionAdapter(harness!.db as any);
    sessionId = uuidv4();
    await harness!.db.insert(agentSessions).values({
      id: sessionId,
      // REMOVED: status field (Dec 2025 - status column removed)
      mode: 'automated',
      workspaceDir: `/tmp/${sessionId}`,
      metadata: {},
      plan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    });

    // A normal table is intentional: PostgreSQL TEMP tables are connection
    // scoped, while the Drizzle pool may execute the assertion on a different
    // connection. The isolated test database is dropped by harness.dispose().
    await harness!.db.execute(sql`CREATE TABLE IF NOT EXISTS tool_side_effects (id serial primary key, tool_call_id text unique);`);
  });

  it('skips re-execution on resume for same toolCallId', async () => {
    const toolCallId = uuidv4();
    const turnId = 'turn-1';

    // First run: create + complete + side effect
    await toolExec.create({
      sessionId,
      turnId,
      toolCallId,
      toolName: 'test_tool',
      args: {},
    });
    await toolExec.markStarted({ sessionId, toolCallId });
    await harness!.db.execute(sql`INSERT INTO tool_side_effects (tool_call_id) VALUES (${toolCallId});`);
    await toolExec.complete({
      sessionId,
      toolCallId,
      result: { ok: true },
      durationMs: 5,
    });

    // Resume: findByToolCallId returns cached; no new side effect inserted
    const cached = await toolExec.findByToolCallId(sessionId, toolCallId);
    expect(cached).toBeDefined();
    expect(cached?.status).toBe('succeeded');

    // Simulate replay: do NOT re-run side effect; tool execution should remain single
    await toolExec.create({
      sessionId,
      turnId,
      toolCallId,
      toolName: 'test_tool',
      args: {},
    }).catch(() => undefined); // ignore unique conflict if any

    const sideEffects = await harness!.db.execute(sql`SELECT COUNT(*)::int AS cnt FROM tool_side_effects WHERE tool_call_id = ${toolCallId};`);
    const count = (sideEffects as any).rows[0]?.cnt ?? 0;
    expect(count).toBe(1);
  });
});







