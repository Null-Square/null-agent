import { describe, it, expect, vi } from 'vitest';
import {
  TodoRead,
  TodoWrite,
  PlanSetStepStatus,
} from '@/domains/agent-brain/adapters/tools/builtins';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

const normalizeStepStatus = (value: unknown) => {
  if (!value || typeof value !== 'string') return 'pending';
  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  switch (normalized) {
    case 'running':
    case 'in_progress':
    case 'in-progress':
      return 'running';
    case 'completed':
    case 'done':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return 'pending';
  }
};

const createPlanRuntime = () => ({
  normalizeStepStatus: vi.fn(normalizeStepStatus),
  replacePlan: vi.fn(async (sessionId, items) => ({ sessionId, items })),
  replaceScratchTodos: vi.fn(async (sessionId, items) => ({ sessionId, items })),
  transitionPlanStep: vi.fn(),
  resetProvenanceBuffer: vi.fn(),
  clearProvenanceBuffer: vi.fn(),
  getCurrentPlan: vi.fn(() => []),
  getScratchTodos: vi.fn(() => []),
});

const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir: '/tmp/workspace',
    sandbox: {} as any,
    sessionStore: {
      get: vi.fn(() => ({ id: 'session-1', flags: {}, turn: 0 })),
      setAsync: vi.fn(async () => undefined),
    } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
    flags: {},
    planRuntime: createPlanRuntime() as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  }) as ToolContext;

describe('Plan builtins', () => {
  it('normalizes todo input and replaces scratch todos without touching the approved plan', async () => {
    const ctx = makeContext();

    const result = await TodoWrite.run(
      {
        todos: [
          { content: ' First task ', status: 'pending', notes: 'notes' },
          { content: '   ' },
        ],
      },
      ctx,
    );

    const items = (ctx.planRuntime.replaceScratchTodos as any).mock.calls[0][1];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: 'first_task_0',
      content: 'First task',
      status: 'pending',
      notes: 'notes',
    });
    expect(ctx.planRuntime.replacePlan).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('updates plan step status and clears provenance for completed steps', async () => {
    const planRuntime = createPlanRuntime();
    planRuntime.transitionPlanStep = vi.fn(async () => ({ id: 'step-1', status: 'completed' }));
    const ctx = makeContext({ planRuntime: planRuntime as any });

    const result = await PlanSetStepStatus.run(
      { stepId: 'step-1', status: 'completed', notes: 'done' },
      ctx,
    );

    expect(ctx.planRuntime.transitionPlanStep).toHaveBeenCalledWith(
      'session-1',
      'step-1',
      'completed',
      {
        notes: 'done',
        blockedReason: undefined,
        checkpointId: undefined,
      },
      { turnNumber: undefined },
    );
    expect(ctx.planRuntime.clearProvenanceBuffer).toHaveBeenCalledWith('session-1');
    expect(result.ok).toBe(true);
  });

  it('rejects broad-surface completion when canonical service inventory is missing', async () => {
    const planRuntime = createPlanRuntime();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        securityops: {
          inventoryProgress: {
            lastCoverageStatus: 'completed',
            ingestedParsers: ['subfinder'],
            lastIngestError: 'ENOENT: missing scanner artifact',
          },
        },
      },
      plan: [
        {
          id: 'task-1',
          status: 'running',
          mission: {
            assignedSkills: ['broad-surface-scan'],
          },
        },
      ],
    };
    const ctx = makeContext({
      planRuntime: planRuntime as any,
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async () => undefined),
      } as any,
    });

    const result = await PlanSetStepStatus.run({ stepId: 'task-1', status: 'completed' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({
      error: expect.stringContaining('canonical service inventory'),
    });
    expect(planRuntime.transitionPlanStep).not.toHaveBeenCalled();
  });

  it('allows broad-surface completion after coverage and canonical service inventory exist', async () => {
    const planRuntime = createPlanRuntime();
    planRuntime.transitionPlanStep = vi.fn(async () => ({ id: 'task-1', status: 'completed' }));
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        securityops: {
          inventoryProgress: {
            lastCoverageStatus: 'completed',
            ingestedParsers: ['httpx'],
          },
        },
      },
      plan: [
        {
          id: 'task-1',
          status: 'running',
          mission: {
            assignedSkills: ['broad-surface-scan'],
          },
        },
      ],
    };
    const ctx = makeContext({
      planRuntime: planRuntime as any,
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async () => undefined),
      } as any,
    });

    const result = await PlanSetStepStatus.run({ stepId: 'task-1', status: 'completed' }, ctx);

    expect(result.ok).toBe(true);
    expect(planRuntime.transitionPlanStep).toHaveBeenCalledWith(
      'session-1',
      'task-1',
      'completed',
      {
        notes: undefined,
        blockedReason: undefined,
        checkpointId: undefined,
      },
      { turnNumber: undefined },
    );
  });

  it('allows broad-surface completion when durable coverage notes exist even if lastCoverageStatus is missing', async () => {
    const planRuntime = createPlanRuntime();
    planRuntime.transitionPlanStep = vi.fn(async () => ({ id: 'task-1', status: 'completed' }));
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        securityops: {
          inventoryProgress: {
            servicesTouched: 1,
            coverageNotes: 2,
            noteTypes: {
              'scan.coverage': 2,
            },
          },
        },
      },
      plan: [
        {
          id: 'task-1',
          status: 'running',
          mission: {
            assignedSkills: ['broad-surface-scan'],
          },
        },
      ],
    };
    const ctx = makeContext({
      planRuntime: planRuntime as any,
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async () => undefined),
      } as any,
    });

    const result = await PlanSetStepStatus.run({ stepId: 'task-1', status: 'completed' }, ctx);

    expect(result.ok).toBe(true);
    expect(planRuntime.transitionPlanStep).toHaveBeenCalledWith(
      'session-1',
      'task-1',
      'completed',
      {
        notes: undefined,
        blockedReason: undefined,
        checkpointId: undefined,
      },
      { turnNumber: undefined },
    );
  });

  it('rejects broad-surface completion when a parser failed and was not successfully retried', async () => {
    const planRuntime = createPlanRuntime();
    const session = {
      id: 'session-1',
      turn: 0,
      flags: {
        securityops: {
          inventoryProgress: {
            lastCoverageStatus: 'completed',
            servicesCreated: 2,
            failedIngestParsers: ['httpx'],
            lastIngestError: 'ENOENT: missing scanner artifact',
          },
        },
      },
      plan: [
        {
          id: 'task-1',
          status: 'running',
          mission: {
            assignedSkills: ['broad-surface-scan'],
          },
        },
      ],
    };
    const ctx = makeContext({
      planRuntime: planRuntime as any,
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async () => undefined),
      } as any,
    });

    const result = await PlanSetStepStatus.run({ stepId: 'task-1', status: 'completed' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({
      error: expect.stringContaining('successful ingest_scan_artifact retry for failed parser(s): httpx'),
    });
    expect(planRuntime.transitionPlanStep).not.toHaveBeenCalled();
  });

  it('returns a methodology briefing when starting a mission with unread assigned skills', async () => {
    const planRuntime = createPlanRuntime();
    planRuntime.transitionPlanStep = vi.fn(async () => ({
      id: 'task-2',
      title: 'Analyze JavaScript',
      status: 'running',
      mission: {
        question: 'Do JavaScript bundles expose secrets?',
        whyReadyNow: 'The homepage is reachable.',
        requiredEvidence: ['JS bundle list'],
        expectedArtifact: 'JS analysis report',
        stopCondition: 'All reachable JS bundles are reviewed.',
        assignedSkills: ['js-surface-analysis'],
      },
    }));
    const trace = { write: vi.fn().mockResolvedValue(undefined) };
    const session = { id: 'session-1', flags: {}, turn: 3 };
    const ctx = makeContext({
      planRuntime: planRuntime as any,
      trace: trace as any,
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async (_sessionId: string, updated: any) => Object.assign(session, updated)),
      } as any,
    });

    const result = await PlanSetStepStatus.run({ stepId: 'task-2', status: 'running' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        stepId: 'task-2',
        status: 'running',
        title: 'Analyze JavaScript',
        methodologyRequired: expect.objectContaining({
        stepId: 'task-2',
        unreadSkills: ['js-surface-analysis'],
          paths: ['/workspace/.skills/js-surface-analysis/methodology.md'],
        }),
      }),
    );
    expect(trace.write).toHaveBeenCalledWith(
      'session-1',
      4,
      expect.objectContaining({
        event: 'plan.step.briefing',
        severity: 'warn',
        payload: expect.objectContaining({
          stepId: 'task-2',
          unreadSkills: ['js-surface-analysis'],
        }),
      }),
    );
    expect(ctx.sessionStore.setAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        flags: expect.objectContaining({
          activeMethodologyRequirement: {
            stepId: 'task-2',
            skills: ['js-surface-analysis'],
            paths: ['/workspace/.skills/js-surface-analysis/methodology.md'],
          },
        }),
      }),
      'plan_set_step_status.active_methodology_requirement',
    );
  });

  it('returns error when stepId is missing', async () => {
    const ctx = makeContext();

    const result = await PlanSetStepStatus.run({ stepId: ' ', status: 'pending' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ error: 'stepId is required' });
  });

  it('reads scratch todo state', async () => {
    const planRuntime = createPlanRuntime();
    (planRuntime as any).getScratchTodos = vi.fn(() => [
      { id: 'todo', content: 'scratch', status: 'pending' },
    ]);
    const ctx = makeContext({ planRuntime: planRuntime as any });

    const result = await TodoRead.run({}, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ todos: [{ id: 'todo', content: 'scratch', status: 'pending' }] });
  });
});
