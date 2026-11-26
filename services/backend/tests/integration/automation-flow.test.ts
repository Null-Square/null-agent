import { describe, it, expect, vi } from 'vitest';
import {
  AutomationGuardHandler,
  type GuardHandlingResult,
} from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import AutomationModePolicy from '@/domains/agent-brain/application/services/AutomationModePolicy';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { DefaultStages } from '@/domains/agent-brain/application/orchestration/stages';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const buildGuardResult = (overrides: Partial<GuardHandlingResult> = {}): GuardHandlingResult => ({
  suppressDone: false,
  scheduleAutoRetry: false,
  exhausted: false,
  ...overrides,
});

describe('Automation flow integration', () => {
  it('continues for pending steps, then stops when task completes', async () => {
    const sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await sessionStore.create({ mode: 'automated', modelName: 'test-model' });
    const handler = new AutomationGuardHandler({
      sessionStore: sessionStore as any,
      automationPolicy: new AutomationModePolicy(),
    });
    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);

    const continued = await handler.evaluateContinuation({
      sessionId: session.id,
      turnNumber: 1,
      turnStatus: 'completed',
      pendingPlanSteps: [{ id: 'step-1' }],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(continued).toBe(true);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    const stopped = await handler.evaluateContinuation({
      sessionId: session.id,
      turnNumber: 2,
      turnStatus: 'completed',
      pendingPlanSteps: [],
      hasReport: true,
      guardResult: buildGuardResult(),
      processMessage: vi.fn(),
    });

    expect(stopped).toBe(false);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('returns a slower retry after guard exhaustion without blocking the session', async () => {
    const sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await sessionStore.create({ mode: 'automated', modelName: 'test-model' });
    session.flags = {};
    session.coordination = { role: 'direct' };
    session.stateMachine?.startProcessing('test', session.turn ?? 0, 'automation-flow');
    await sessionStore.setAsync(session.id, session);

    const handler = new AutomationGuardHandler({
      sessionStore: sessionStore as any,
      automationPolicy: new AutomationModePolicy({ maxGuardRetries: 3 }),
    });
    const turnStream = { raw: vi.fn(), done: vi.fn() };

    let guardResult: GuardHandlingResult | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      guardResult = await handler.handle({
        sessionId: session.id,
        turnNumber: attempt + 1,
        session: sessionStore.get(session.id)!,
        pendingPlanSteps: [{ id: `step-${attempt}` }],
        hasReport: false,
        toolCallCount: 0,
        turnStatus: 'completed',
        turnStream,
        recorder: undefined,
      });
    }

    expect(guardResult?.exhausted).toBe(true);
    expect(guardResult?.scheduleAutoRetry).toBe(true);
    expect(guardResult?.autoRetryDelayMs).toBe(30_000);
    expect(sessionStore.get(session.id)?.blockedReason).toBeUndefined();

    const scheduleSpy = vi.spyOn(handler, 'scheduleRetry').mockResolvedValue(undefined);
    const continued = await handler.evaluateContinuation({
      sessionId: session.id,
      turnNumber: 5,
      turnStatus: 'completed',
      pendingPlanSteps: [{ id: 'step-final' }],
      hasReport: false,
      guardResult: guardResult as GuardHandlingResult,
      processMessage: vi.fn(),
    });

    // The caller schedules guardResult before asking the decision engine for a
    // second continuation. False here means "already handled", not terminal.
    expect(continued).toBe(false);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it('clears a stale sandbox binding so durable retry can recreate it', async () => {
    const sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await sessionStore.create({ mode: 'automated', modelName: 'test-model' });
    session.containerId = 'container-1';
    await sessionStore.setAsync(session.id, session);

    const stage = new DefaultStages.Prepare();
    const sandboxHealthChecker = {
      check: vi.fn(async () => ({
        healthy: false,
        containerId: session.containerId ?? 'container-1',
        containerRunning: false,
        diskSpaceOk: false,
        lastCheckAt: Date.now(),
        errors: ['container_dead'],
      })),
    };

    await expect(
      stage.run({
        sessionId: session.id,
        userInput: '',
        sessionStore: sessionStore as any,
        policyResolver: { resolve: vi.fn(async (state: any) => state) } as any,
        events: { emit: vi.fn() } as any,
        streamFactory: vi.fn(() => ({ message: vi.fn() })) as any,
        sandboxHealthChecker,
      }),
    ).rejects.toThrow('sandbox_unhealthy');

    expect(sessionStore.get(session.id)?.blockedReason).toBeUndefined();
    expect(sessionStore.get(session.id)?.containerId).toBeUndefined();
  });
});
