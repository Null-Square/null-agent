import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Automated completion guard integration (plan/report + durable retry).
 *
 * Verifies:
 * - Pending plan steps with no tool calls trigger guard suppression + auto-retry.
 * - scheduleRetry persists one durable journal continuation.
 */

import { AutomationGuardHandler } from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import AutomationModePolicy from '@/domains/agent-brain/application/services/AutomationModePolicy';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';


describe('Automated completion guard (plan/report)', () => {
  const turnStream = { raw: vi.fn(), done: vi.fn() };

  it('suppresses done and schedules durable retry when plan steps remain', async () => {
    const sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await sessionStore.create({ userId: 'u1', mode: 'automated', modelName: 'test-model' });
    // Use stateMachine as source of truth for processing state
    session.stateMachine?.startProcessing('test', 1, 'test');
    await sessionStore.setAsync(session.id, session);

    const recordExecutionDeferredAsync = vi
      .spyOn(sessionStore, 'recordExecutionDeferredAsync')
      .mockResolvedValue(true);
    const sessionRepository = { setBlockedReason: vi.fn(async () => true) };
    const processMessage = vi.fn(async (_sessionId: string, _input: string, _profile?: string) => {});

    const guard = new AutomationGuardHandler({
      sessionStore: sessionStore as any,
      automationPolicy: new AutomationModePolicy({ requireReport: true }),
      sessionRepository: sessionRepository as any,
    });

    const result = await guard.handle({
      sessionId: session.id,
      turnNumber: 1,
      session: sessionStore.get(session.id)!,
      pendingPlanSteps: [{ id: 'step-1', title: 'Do thing' }],
      hasReport: false,
      toolCallCount: 0,
      turnStatus: 'completed',
      turnStream,
      recorder: undefined,
    });

    expect(result.suppressDone).toBe(true);
    expect(result.scheduleAutoRetry).toBe(true);
    expect(result.autoRetryReason).toBeDefined();

    // Drive scheduleRetry to persist retry/backoff and enqueue job
    await guard.scheduleRetry({
      sessionId: session.id,
      message: result.autoRetryMessage ?? 'retry',
      profile: result.autoRetryProfile,
      processMessage,
      reason: result.autoRetryReason,
      delayMs: 25,
    });

    expect(recordExecutionDeferredAsync).toHaveBeenCalledWith(
      session.id,
      result.autoRetryReason,
      expect.any(Date),
      expect.stringContaining('automation:'),
      undefined,
    );
  });
});
