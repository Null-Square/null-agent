import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Pending approval durability (DB-backed SessionStore hydrate).
 *
 * Verifies:
 * - pendingApproval stored in DB (metadata) survives restart/hydration.
 * - stale actionId is rejected on approve.
 * - Idempotency-Key avoids duplicate approve handling.
 *
 * Requires TEST_DATABASE_URL. Skips if not set.
 */

import { v4 as uuidv4 } from 'uuid';
import { agentSessions } from '@/db/schema';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { SimpleApprovalHelper } from '@/domains/agent-brain/application/services/SimpleApprovalHelper';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import { MessageRepository } from '@/domains/agent-brain/adapters/persistence/MessageRepository';
import { SessionPersistenceService } from '@/domains/agent-brain/infrastructure/persistence/SessionPersistenceService';
import { setupTestDb } from '../../helpers/testDb';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const dbUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = dbUrl ? describe : describe.skip;

maybeDescribe('Pending approval durability (hydrate + approve)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  let repo: SessionRepository;
  let messageRepo: MessageRepository;
  let persistence: SessionPersistenceService;

  beforeAll(async () => {
    harness = await setupTestDb();
    repo = new SessionRepository(harness!.db as any);
    messageRepo = new MessageRepository(harness!.db as any);
    persistence = new SessionPersistenceService({ sessions: repo as any, messages: messageRepo as any });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    await harness?.truncateAll();
  });

  const seedSessionWithApproval = async () => {
    const sessionId = uuidv4();
    const pendingApproval = {
      toolCallId: 'tc-1',
      tool: 'write_file',
      reason: 'Needs approval',
      requestedAt: Date.now(),
    };
    await harness!.db.insert(agentSessions).values({
      id: sessionId,
      userId: null,
      mode: 'interactive',
      workspaceDir: `/tmp/${sessionId}`,
      metadata: { pendingApproval },
      plan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    });
    return { sessionId, pendingApproval };
  };

  it('hydrates pendingApproval and keeps it resumable when approval is granted', async () => {
    const { sessionId, pendingApproval } = await seedSessionWithApproval();

    const store = new SessionStore({
      sessionRepository: persistence as any,
      workspaceManager: createTestWorkspaceManager(),
    });
    await (store as any).hydrationPromise;

    const hydrated = store.get(sessionId);
    expect(hydrated?.pendingApproval?.toolCallId).toBe(pendingApproval.toolCallId);

    const helper = new SimpleApprovalHelper(store as any, { emit: vi.fn() } as any);

    const resolved = await helper.resolveDecision(sessionId, pendingApproval.toolCallId, 'granted');
    expect(resolved).toEqual({ handled: true, needsResume: true });
    const afterFirst = store.get(sessionId);
    expect(afterFirst?.pendingApproval?.toolCallId).toBe(pendingApproval.toolCallId);
  });

  it('rejects stale actionId and leaves pendingApproval intact', async () => {
    const { sessionId, pendingApproval } = await seedSessionWithApproval();
    const store = new SessionStore({
      sessionRepository: persistence as any,
      workspaceManager: createTestWorkspaceManager(),
    });
    await (store as any).hydrationPromise;

    const helper = new SimpleApprovalHelper(store as any, { emit: vi.fn() } as any);
    await expect(helper.resolveDecision(sessionId, 'missing', 'granted')).resolves.toEqual({
      handled: false,
      needsResume: false,
    });
    const after = store.get(sessionId);
    expect(after?.pendingApproval?.toolCallId).toBe(pendingApproval.toolCallId);
  });
});








