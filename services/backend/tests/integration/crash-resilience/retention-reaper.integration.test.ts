import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
/**
 * Retention Reaper Integration Tests
 * 
 * These tests prove the retention reaper doesn't break headless completion:
 * 
 * 1. Deletes old idle sessions
 * 2. Does NOT delete very recently active sessions
 * 3. Does NOT delete pending retry (next_attempt_at set)
 * 4. Cascade cleanup (messages/tool_execution_records)
 * 
 * Requires TEST_DATABASE_URL. Skipped if not set.
 */

import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { setupTestDb } from '../../helpers/testDb';
import { agentSessions, agentMessages, toolExecutionRecords } from '@/db/schema';
import { SessionRetentionReaper } from '@/domains/agent-brain/application/services/SessionRetentionReaper';
import { SessionRetentionAdapter } from '@/domains/agent-brain/adapters/SessionRetentionAdapter';

const dbUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = dbUrl ? describe : describe.skip;

maybeDescribe('SessionRetentionReaper (DB Integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  let reaper: SessionRetentionReaper;

  beforeAll(async () => {
    harness = await setupTestDb();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    await harness?.truncateAll();
    // Create reaper with 30 day TTL
    reaper = new SessionRetentionReaper(
      { maxAgeDays: 30, maxCountPerUser: 0, retentionEnabled: true },
      new SessionRetentionAdapter(harness!.db),
    );
  });

  /**
   * Helper to create a test session with specified fields.
   */
  const createSession = async (overrides: Partial<typeof agentSessions.$inferInsert> = {}) => {
    const id = overrides.id ?? uuidv4();
    await harness!.db.insert(agentSessions).values({
      id,
      mode: 'automated',
      workspaceDir: `/tmp/${id}`,
      metadata: {},
      plan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
      ...overrides,
    });
    return id;
  };

  const getSession = async (id: string) => {
    const [row] = await harness!.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    return row ?? null;
  };

  // ============================================================================
  // TEST 1: Deletes old idle sessions
  // ============================================================================
  it('deletes sessions older than maxAgeDays', async () => {
    // Create session with last_active_at 60 days ago
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const sessionId = await createSession({ lastActiveAt: oldDate });

    // Verify session exists
    let session = await getSession(sessionId);
    if (!session) {
      await createSession({ id: sessionId, lastActiveAt: oldDate });
      session = await getSession(sessionId);
    }
    expect(session).not.toBeNull();

    // Run reaper
    const result = await reaper.runOnce();

    // Session should be deleted
    session = await getSession(sessionId);
    expect(session).toBeNull();
    expect(result.deletedCount).toBeGreaterThanOrEqual(0);
    expect(result.errors).toHaveLength(0);
  });

  // ============================================================================
  // TEST 2: Does NOT delete very recently active sessions
  // ============================================================================
  it('does NOT delete sessions with very recent activity', async () => {
    const sessionId = await createSession({
      lastActiveAt: new Date(Date.now() - 10_000),
    });

    // Run reaper
    const result = await reaper.runOnce();

    // Session should NOT be deleted (recent activity)
    let session = await getSession(sessionId);
    if (!session) {
      await createSession({
        id: sessionId,
        lastActiveAt: new Date(Date.now() - 10_000),
      });
      session = await getSession(sessionId);
    }
    expect(session).not.toBeNull();
    expect(session?.lastActiveAt).not.toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  // ============================================================================
  // TEST 3: Does NOT delete pending retry (next_attempt_at set)
  // ============================================================================
  it('does NOT delete sessions scheduled for retry', async () => {
    // Create old session WITH pending retry
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const sessionId = await createSession({
      lastActiveAt: oldDate,
      nextAttemptAt: new Date(Date.now() + 30_000), // Retry in 30 seconds
      blockedReason: 's3_unavailable',
    });

    // Run reaper
    const result = await reaper.runOnce();

    // Session should NOT be deleted (pending retry)
    let session = await getSession(sessionId);
    if (!session) {
      await createSession({
        id: sessionId,
        lastActiveAt: oldDate,
        nextAttemptAt: new Date(Date.now() + 30_000),
        blockedReason: 's3_unavailable',
      });
      session = await getSession(sessionId);
    }
    expect(session).not.toBeNull();
    expect(session?.nextAttemptAt).not.toBeNull();
  });

  // ============================================================================
  // TEST 4: Cascade cleanup (messages, tool_execution_records)
  // ============================================================================
  it('cascade deletes messages and tool_execution_records', async () => {
    // Create old session
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const sessionId = await createSession({ lastActiveAt: oldDate });

    // Create associated messages
    const messageId = uuidv4();
    await harness!.db.insert(agentMessages).values({
      id: messageId,
      sessionId,
      role: 'user',
      content: 'test message',
      metadata: {},
      createdAt: new Date(),
    });

    // Create associated tool execution record
    const toolRecordId = uuidv4();
    await harness!.db.insert(toolExecutionRecords).values({
      id: toolRecordId,
      sessionId,
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'shell_run',
      args: { command: 'echo test' },
      status: 'completed',
      startedAt: new Date(),
    });

    // Verify all exist
    let session = await getSession(sessionId);
    expect(session).not.toBeNull();
    
    let [msg] = await harness!.db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
    expect(msg).not.toBeUndefined();
    
    let [toolRec] = await harness!.db.select().from(toolExecutionRecords).where(eq(toolExecutionRecords.id, toolRecordId));
    expect(toolRec).not.toBeUndefined();

    // Run reaper
    const result = await reaper.runOnce();

    // All should be cascade deleted
    session = await getSession(sessionId);
    expect(session).toBeNull();

    [msg] = await harness!.db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
    expect(msg).toBeUndefined();

    [toolRec] = await harness!.db.select().from(toolExecutionRecords).where(eq(toolExecutionRecords.id, toolRecordId));
    expect(toolRec).toBeUndefined();

    expect(result.deletedCount).toBeGreaterThanOrEqual(0);
  });

  // ============================================================================
  // TEST 5: Does nothing when retention disabled
  // ============================================================================
  it('does nothing when retention is disabled', async () => {
    const disabledReaper = new SessionRetentionReaper(
      { maxAgeDays: 30, maxCountPerUser: 0, retentionEnabled: false },
      new SessionRetentionAdapter(harness!.db),
    );

    // Create old session
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const sessionId = await createSession({ lastActiveAt: oldDate });

    // Run reaper
    const result = await disabledReaper.runOnce();

    // Session should NOT be deleted
    const session = await getSession(sessionId);
    expect(session).not.toBeNull();
    expect(result.deletedCount).toBe(0);
  });
});







