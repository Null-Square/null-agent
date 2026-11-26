import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Automated completion guard contract tests (no runtime code changes).
 *
 * Validates AutomationGuardHandler behavior for:
 * - Report present + no pending steps -> completion mode switch allowed
 * - Report missing -> suppress done and emit warning
 */

import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { AutomationGuardHandler } from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

describe('AutomationGuardHandler completion contract', () => {
  let store: SessionStore;
  let handler: AutomationGuardHandler;
  const turnStream = { raw: vi.fn(), done: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  it('allows completion when report exists and no pending steps', async () => {
    const session = await store.create({ userId: 'u-auto', mode: 'automated', modelName: 'test-model' });
    const automationPolicy = {
      evaluateGuard: vi.fn().mockReturnValue({
        active: false,
      }),
    } as any;
    handler = new AutomationGuardHandler({ sessionStore: store as any, automationPolicy });

    const result = await handler.handle({
      sessionId: session.id,
      turnNumber: 1,
      session: store.get(session.id)!,
      pendingPlanSteps: [],
      hasReport: true,
      toolCallCount: 0,
      turnStatus: 'completed',
      turnStream,
      recorder: undefined,
    });

    expect(result.suppressDone).toBe(false);
    expect(result.modeSwitchReason).toBe('automated.completed');
  });

  it('suppresses done and warns when report is missing', async () => {
    const session = await store.create({ userId: 'u-auto', mode: 'automated', modelName: 'test-model' });
    const automationPolicy = {
      evaluateGuard: vi.fn().mockReturnValue({
        active: true,
        suppressDone: true,
        exhausted: false,
        pendingStepIds: [],
        nextRetryCount: 1,
        reason: 'report_missing',
      }),
    } as any;
    handler = new AutomationGuardHandler({ sessionStore: store as any, automationPolicy });

    const result = await handler.handle({
      sessionId: session.id,
      turnNumber: 1,
      session: store.get(session.id)!,
      pendingPlanSteps: [],
      hasReport: false,
      toolCallCount: 0,
      turnStatus: 'completed',
      turnStream,
      recorder: undefined,
    });

    expect(result.suppressDone).toBe(true);
    expect(turnStream.raw).toHaveBeenCalledWith(
      'warning',
      expect.objectContaining({ code: 'automated_guard' }),
    );
  });
});






