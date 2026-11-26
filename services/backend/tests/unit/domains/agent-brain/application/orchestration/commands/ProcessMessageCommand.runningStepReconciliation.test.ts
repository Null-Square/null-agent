/**
 * EXE-7: Running plan step reconciliation at natural session completion.
 *
 * Verifies that ProcessMessageCommand auto-completes any plan step that is still
 * in 'running' state when the automation guard signals natural completion
 * (modeSwitchReason === 'automated.completed').
 *
 * This covers the case where the model finished its work but forgot to call
 * plan_set_step_status('completed') before writing run.digest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessMessageCommand } from '@/domains/agent-brain/application/orchestration/commands/ProcessMessageCommand';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import type { PlanItem } from '@/domains/agent-brain/domain/types';

// ─── Minimal mock factory helpers ────────────────────────────────────────────

const noop = async () => {};
const mockStream = () => ({ raw: vi.fn(), done: vi.fn() });
const mockRecorder = () => ({ write: vi.fn(async () => {}) });

function buildMinimalDeps(sessionStore: SessionStore, overrides: Record<string, unknown> = {}) {
  return {
    sessionStore,
    events: { emit: vi.fn() },
    traceRecorder: undefined,
    prepareStage: {
      run: vi.fn(async () => ({
        turnNumber: 1,
        turnStream: mockStream(),
        recorder: mockRecorder(),
        turnController: { signal: new AbortController().signal },
        sessionState: sessionStore.get('dummy') ?? {},
        initialPendingPlanStepIds: new Set<string>(),
      })),
    } as any,
    buildStage: {
      run: vi.fn(async () => ({
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: { estimatedTokens: 0, contextWindow: 8192, percentUsed: 0 },
        compactionResult: undefined,
        contextOverflow: undefined,
      })),
    } as any,
    reconcileStage: {
      run: vi.fn(async () => ({ pendingSteps: [] })),
    } as any,
    contextProvider: { getContext: vi.fn(async () => ({})) } as any,
    cacheCoordinator: { coordinate: vi.fn(async () => ({})) } as any,
    toolsRegistry: { getTools: vi.fn(() => []) } as any,
    policyResolver: { resolve: vi.fn(() => ({})) } as any,
    promptBuilder: { build: vi.fn(async () => ({})) } as any,
    turnExecutor: {
      runTurn: vi.fn(async () => ({
        status: 'completed',
        toolCallCount: 1,
        toolCallsRequested: 1,
        messagesLength: 5,
        doneEmitted: false,
      })),
      setModelName: vi.fn(),
      setModel: vi.fn(),
    } as any,
    preTurnChecks: {
      execute: vi.fn(async () => ({ proceed: true, warnings: [] })),
    } as any,
    turnErrorHandler: {
      handleAbort: vi.fn(async () => ({ status: 'abort', doneEmitted: false })),
      handleError: vi.fn(async () => ({ status: 'error', doneEmitted: false })),
    } as any,
    automationGuardHandler: {
      handle: vi.fn(async () => ({
        suppressDone: false,
        scheduleAutoRetry: false,
        exhausted: false,
        modeSwitchReason: 'automated.completed',
        modeSwitchPayload: { pendingSteps: 0 },
      })),
      applyModeSwitch: vi.fn(async () => {}),
      scheduleRetry: vi.fn(async () => {}),
      evaluateContinuation: vi.fn(async () => false),
    } as any,
    turnFailurePolicy: {
      handleError: vi.fn(async () => {}),
      clearRetryState: vi.fn(),
    } as any,
    artifactService: {
      flush: vi.fn(async () => ({ hasReport: true })),
      ensureReportForCompletion: vi.fn(async () => {}),
    } as any,
    sandboxHealthChecker: undefined,
    notificationPort: undefined,
    getProvider: vi.fn(async () => ({})) as any,
    getModelStream: vi.fn(async () => ({})) as any,
    maxToolCalls: 40,
    convertMessages: (msgs: unknown[]) => msgs as any,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      })),
    } as any,
    sessionRepository: undefined,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ProcessMessageCommand — reconcileRunningPlanSteps (EXE-7)', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  it('transitions running plan step to completed at natural session completion', async () => {
    const session = await sessionStore.create({
      userId: 'u1',
      mode: 'automated',
      modelName: 'test-model',
    });

    const runningStep: PlanItem = {
      id: 'step-recon',
      title: 'Recon app.example.com',
      status: 'running',
      startedAt: Date.now() - 5000,
    };
    await sessionStore.updatePlanAsync(session.id, [runningStep]);
    await sessionStore.updateCurrentPlanStepIdAsync(session.id, 'step-recon');

    const deps = buildMinimalDeps(sessionStore);

    // Make prepareSession return the real session's id
    (deps.prepareStage.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      turnNumber: 1,
      turnStream: mockStream(),
      recorder: mockRecorder(),
      turnController: { signal: new AbortController().signal },
      sessionState: session,
      initialPendingPlanStepIds: new Set<string>(),
    });

    const command = new ProcessMessageCommand(deps as any);
    await command.execute({ sessionId: session.id, userInput: '' });

    const updatedSession = sessionStore.get(session.id);
    const step = updatedSession?.plan?.find((s) => s.id === 'step-recon');
    expect(step?.status).toBe('completed');
    expect(step?.completedAt).toBeDefined();
    expect(updatedSession?.currentPlanStepId).toBeUndefined();
  });

  it('leaves already-completed steps unchanged', async () => {
    const session = await sessionStore.create({
      userId: 'u1',
      mode: 'automated',
      modelName: 'test-model',
    });

    const completedStep: PlanItem = {
      id: 'step-done',
      title: 'Already done',
      status: 'completed',
      completedAt: Date.now() - 1000,
    };
    await sessionStore.updatePlanAsync(session.id, [completedStep]);

    const deps = buildMinimalDeps(sessionStore);
    (deps.prepareStage.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      turnNumber: 1,
      turnStream: mockStream(),
      recorder: mockRecorder(),
      turnController: { signal: new AbortController().signal },
      sessionState: session,
      initialPendingPlanStepIds: new Set<string>(),
    });

    const command = new ProcessMessageCommand(deps as any);
    await command.execute({ sessionId: session.id, userInput: '' });

    const updatedSession = sessionStore.get(session.id);
    const step = updatedSession?.plan?.find((s) => s.id === 'step-done');
    expect(step?.status).toBe('completed'); // unchanged
  });

  it('does not auto-complete when guard does not signal natural completion', async () => {
    const session = await sessionStore.create({
      userId: 'u1',
      mode: 'automated',
      modelName: 'test-model',
    });

    const runningStep: PlanItem = {
      id: 'step-running',
      title: 'In flight',
      status: 'running',
      startedAt: Date.now() - 2000,
    };
    await sessionStore.updatePlanAsync(session.id, [runningStep]);
    await sessionStore.updateCurrentPlanStepIdAsync(session.id, 'step-running');

    const deps = buildMinimalDeps(sessionStore, {
      automationGuardHandler: {
        handle: vi.fn(async () => ({
          suppressDone: true,
          scheduleAutoRetry: true,
          exhausted: false,
          // No modeSwitchReason — guard fired, session will retry
        })),
        applyModeSwitch: vi.fn(async () => {}),
        scheduleRetry: vi.fn(async () => {}),
        evaluateContinuation: vi.fn(async () => true),
      },
    });

    (deps.prepareStage.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      turnNumber: 1,
      turnStream: mockStream(),
      recorder: mockRecorder(),
      turnController: { signal: new AbortController().signal },
      sessionState: session,
      initialPendingPlanStepIds: new Set<string>(),
    });

    const command = new ProcessMessageCommand(deps as any);
    await command.execute({ sessionId: session.id, userInput: '' });

    const updatedSession = sessionStore.get(session.id);
    const step = updatedSession?.plan?.find((s) => s.id === 'step-running');
    // Step should remain 'running' — guard is still retrying, not completed
    expect(step?.status).toBe('running');
    expect(updatedSession?.currentPlanStepId).toBe('step-running');
  });

  it('emits plan_step_updated stream event for each auto-completed step', async () => {
    const session = await sessionStore.create({
      userId: 'u1',
      mode: 'automated',
      modelName: 'test-model',
    });

    const steps: PlanItem[] = [
      { id: 'step-a', title: 'Task A', status: 'running', startedAt: Date.now() - 3000 },
      { id: 'step-b', title: 'Task B', status: 'completed', completedAt: Date.now() - 1000 },
    ];
    await sessionStore.updatePlanAsync(session.id, steps);

    const stream = mockStream();
    const deps = buildMinimalDeps(sessionStore);
    (deps.prepareStage.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      turnNumber: 1,
      turnStream: stream,
      recorder: mockRecorder(),
      turnController: { signal: new AbortController().signal },
      sessionState: session,
      initialPendingPlanStepIds: new Set<string>(),
    });

    const command = new ProcessMessageCommand(deps as any);
    await command.execute({ sessionId: session.id, userInput: '' });

    const planStepUpdatedCalls = stream.raw.mock.calls.filter(
      ([type]) => type === 'plan_step_updated',
    );
    expect(planStepUpdatedCalls).toHaveLength(1);
    expect(planStepUpdatedCalls[0][1]).toMatchObject({ stepId: 'step-a', status: 'completed' });
  });
});
