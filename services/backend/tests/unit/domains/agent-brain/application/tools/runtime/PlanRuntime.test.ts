import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { PlanRuntime } from '@/domains/agent-brain/application/tools';
import type { PlanItem } from '@/domains/agent-brain/domain/types';

const makeSession = (): {
  id: string;
  plan: PlanItem[];
  messages: unknown[];
  flags: Record<string, unknown>;
  workspaceDir: string;
  createdAt: number;
  lastActive: number;
  turn: number;
  currentPlanStepId?: string;
} => ({
  id: 's1',
  plan: [
    { id: 'step-1', title: 'Do it', status: 'pending' },
    { id: 'step-2', title: 'Next', status: 'pending' },
  ],
  messages: [],
  flags: {},
  workspaceDir: '/tmp/s1',
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 0,
  currentPlanStepId: undefined as string | undefined,
});

const createSessionStore = (session = makeSession()) => {
  return {
    get: vi.fn(() => session),
    setAsync: vi.fn(async (_id: string, updated: any) => Object.assign(session, updated)),
    updatePlanAsync: vi.fn(async (_id: string, plan: any[]) => {
      session.plan = plan;
    }),
    updatePlanStepAsync: vi.fn(async (_id: string, stepId: string, updated: any) => {
      session.plan = session.plan.map((p) => (p.id === stepId ? updated : p));
    }),
    updateCurrentPlanStepIdAsync: vi.fn(async (_id: string, stepId?: string) => {
      session.currentPlanStepId = stepId;
    }),
  };
};

const createDeps = (sessionStore = createSessionStore()) => ({
  sessionStore: sessionStore as any,
  streamBroker: { emit: vi.fn() } as any,
});

describe('PlanRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('normalizes and replaces plan, clearing current step if not running', async () => {
    const session = makeSession();
    session.currentPlanStepId = 'step-1';
    const sessionStore = createSessionStore(session);
    const deps = createDeps(sessionStore);
    const runtime = new PlanRuntime(deps as any);

    const plan = await runtime.replacePlan('s1', [
      { id: 'New', title: 'New Step', status: 'running' as const },
    ]);

    expect(plan[0].status).toBe('running');
    expect(session.currentPlanStepId).toBeUndefined();
    expect(deps.streamBroker.emit).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'plan_update' }));
  });

  it('preserves existing step notes when todo replacement omits notes', async () => {
    const session = makeSession();
    session.plan[0].notes = 'blocked on auth wall';
    const runtime = new PlanRuntime(createDeps(createSessionStore(session)) as any);

    const plan = await runtime.replacePlan('s1', [
      { id: 'step-1', title: 'Do it', status: 'pending' as const },
      { id: 'step-2', title: 'Next', status: 'pending' as const },
    ]);

    expect(plan.find((step) => step.id === 'step-1')?.notes).toBe('blocked on auth wall');
  });

  it('preserves mission envelopes when todo replacement reuses the same step id', async () => {
    const session = makeSession();
    const mission = {
      question: 'Which exposed services are reachable?',
      whyReadyNow: 'The approved plan selected broad recon.',
      requiredEvidence: ['httpx output'],
      expectedArtifact: '/workspace/.artifacts/recon/httpx.jsonl',
      stopCondition: 'Primary web services are mapped.',
      assignedSkills: ['broad-surface-scan'],
    };
    session.plan[0].mission = mission;
    const runtime = new PlanRuntime(createDeps(createSessionStore(session)) as any);

    const plan = await runtime.replacePlan('s1', [
      { id: 'step-1', title: 'Do it with executor-local wording', status: 'running' as const },
      { id: 'step-2', title: 'Next', status: 'pending' as const },
    ]);

    expect(plan.find((step) => step.id === 'step-1')?.mission).toEqual(mission);
  });

  it('stores scratch todos separately from the approved plan', async () => {
    const session = makeSession() as ReturnType<typeof makeSession> & { scratchTodos?: unknown[] };
    const runtime = new PlanRuntime(createDeps(createSessionStore(session)) as any);

    const todos = await runtime.replaceScratchTodos('s1', [
      { id: 'todo-1', content: 'Executor local checklist', status: 'running' },
    ]);

    expect(todos).toEqual([
      { id: 'todo-1', content: 'Executor local checklist', status: 'running' },
    ]);
    expect(session.plan).toHaveLength(2);
    expect(session.scratchTodos).toEqual(todos);
    expect(runtime.getCurrentPlan('s1')).toHaveLength(2);
    expect(runtime.getScratchTodos('s1')).toEqual(todos);
  });

  it('updates plan step status and emits telemetry', async () => {
    const sessionStore = createSessionStore();
    const deps = createDeps(sessionStore);
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const runtime = new PlanRuntime({ ...deps, traceRecorder } as any);

    const updated = await runtime.transitionPlanStep('s1', 'step-1', 'running', {}, { turnNumber: 7 });

    expect(updated?.status).toBe('running');
    expect(sessionStore.updateCurrentPlanStepIdAsync).toHaveBeenCalledWith('s1', 'step-1');
    expect(deps.streamBroker.emit).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'plan_step_started', data: expect.objectContaining({ stepId: 'step-1' }) }),
    );
    expect(traceRecorder.write).toHaveBeenCalledWith(
      's1',
      7,
      expect.objectContaining({ event: 'plan.step.transition' }),
    );
  });

  it('returns undefined for invalid step id', async () => {
    const runtime = new PlanRuntime(createDeps() as any);
    const result = await runtime.transitionPlanStep('s1', 'missing', 'running');
    expect(result).toBeUndefined();
  });

  it('ensures active plan step picks running then pending', async () => {
    const session = makeSession();
    session.plan[0].status = 'running' as any;
    const runtime = new PlanRuntime(createDeps(createSessionStore(session)) as any);
    const running = await runtime.ensureActivePlanStep('s1');
    expect(running?.id).toBe('step-1');

    session.plan[0].status = 'completed' as any;
    const pending = await runtime.ensureActivePlanStep('s1');
    expect(pending?.id).toBe('step-2');
  });

  it('resumes a resumable blocked step before taking a new pending step', async () => {
    const session = makeSession();
    session.plan[0].status = 'blocked' as any;
    session.plan[0].blockedReason = 'Paused for resume: tool budget exhausted before step completion';
    const runtime = new PlanRuntime(createDeps(createSessionStore(session)) as any);

    const resumed = await runtime.ensureActivePlanStep('s1');

    expect(resumed?.id).toBe('step-1');
    expect(resumed?.status).toBe('running');
    expect(resumed?.blockedReason).toBeUndefined();
  });

  it('finalizes provenance snippet onto current step and clears buffer', async () => {
    const session = makeSession();
    session.currentPlanStepId = 'step-1';
    const sessionStore = createSessionStore(session);
    const runtime = new PlanRuntime(createDeps(sessionStore) as any);

    runtime.prepareProvenanceBuffer('s1');
    runtime.appendProvenanceSnippet('s1', 'partial ');
    runtime.appendProvenanceSnippet('s1', 'result');
    runtime.finalizePlanProvenance('s1', 'tool_x', { success: true });

    const updatedStep = session.plan.find((p) => p.id === 'step-1');
    expect((updatedStep as any)?.outputSnippet).toBe('partial result');
  });

  it('normalizes step statuses and handles unknown values', () => {
    const runtime = new PlanRuntime(createDeps() as any);

    expect(runtime.normalizeStepStatus('in_progress')).toBe('running');
    expect(runtime.normalizeStepStatus('DONE')).toBe('completed');
    expect(runtime.normalizeStepStatus('failed')).toBe('error');
    expect(runtime.normalizeStepStatus('')).toBe('pending');
  });

  it('records tool failure as blocked reason and clears provenance', async () => {
    const session = makeSession();
    session.currentPlanStepId = 'step-1';
    const sessionStore = createSessionStore(session);
    const runtime = new PlanRuntime(createDeps(sessionStore) as any);

    runtime.handleToolFailure('s1', new Error('boom'));
    await new Promise((resolve) => setImmediate(resolve));

    const updated = session.plan.find((p) => p.id === 'step-1');
    expect(updated?.blockedReason).toBe('boom');
  });

  it('ignores abort errors in handleToolFailure', async () => {
    const session = makeSession();
    session.currentPlanStepId = 'step-1';
    const sessionStore = createSessionStore(session);
    const runtime = new PlanRuntime(createDeps(sessionStore) as any);
    const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });

    runtime.handleToolFailure('s1', abortError);
    await new Promise((resolve) => setImmediate(resolve));

    const updated = session.plan.find((p) => p.id === 'step-1');
    expect(updated?.blockedReason).toBeUndefined();
  });

  it('finalizes provenance with artifact links and truncated snippet', async () => {
    const session = makeSession();
    session.currentPlanStepId = 'step-1';
    const sessionStore = createSessionStore(session);
    const runtime = new PlanRuntime(createDeps(sessionStore) as any);
    (runtime as any).snippetLimit = 8;

    runtime.prepareProvenanceBuffer('s1');
    runtime.appendProvenanceSnippet('s1', 'long snippet beyond limit');
    runtime.finalizePlanProvenance('s1', 'tool_x', {
      error: 'denied',
      denied: true,
      artifactPaths: ['a.txt', 'b.txt'],
      artifactLinks: ['b.txt', 'c.txt'],
    });

    await new Promise((resolve) => setImmediate(resolve));

    const updated = session.plan.find((p) => p.id === 'step-1');
    expect(updated?.outputSnippet).toContain('...');
    expect(updated?.blockedReason).toBe('denied');
    expect(updated?.artifactLinks).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('reconciles running and pending steps on budget exits', async () => {
    const session = makeSession();
    session.plan[0].status = 'running' as any;
    session.currentPlanStepId = 'step-1';
    const runtime = new PlanRuntime(createDeps(createSessionStore(session)) as any);

    const result = await runtime.reconcilePlanForExit('s1', {
      reason: 'max_tool_calls',
      checkpointId: 'cp-1',
      blockPending: true,
    });

    expect(result.changed).toBe(true);
    expect(session.currentPlanStepId).toBeUndefined();
    expect(session.plan).toEqual([
      expect.objectContaining({
        id: 'step-1',
        status: 'blocked',
        blockedReason: expect.stringContaining('tool budget exhausted'),
        checkpointId: 'cp-1',
      }),
      expect.objectContaining({
        id: 'step-2',
        status: 'blocked',
        blockedReason: expect.stringContaining('Deferred for resume'),
      }),
    ]);
  });
});







