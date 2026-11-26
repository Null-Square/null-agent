import { vi, describe, it, expect } from 'vitest';
import { DefaultStages } from '@/domains/agent-brain/application/orchestration/stages';
import { StreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import type { SessionState } from '@/domains/agent-brain/domain/types';

const Reconcile = DefaultStages.Reconcile;

const makeSession = (
  plan: Array<{ id: string; title?: string; status: string; blockedReason?: string }>,
) =>
  ({
    id: 's1',
    plan,
  }) as SessionState;

const makeStream = () => {
  const events: any[] = [];
  const broker = new StreamBroker((event) => events.push(event), {
    event: vi.fn(),
  } as any);
  return { broker, events };
};

const makeArgs = (overrides: Record<string, any> = {}) => {
  const { broker, events } = makeStream();
  const recorder = { write: vi.fn<(sid: string, turn: number, payload: any) => Promise<void>>().mockResolvedValue() };
  const sessionStore = {
    get: vi.fn<() => SessionState | undefined>().mockReturnValue(makeSession([])),
  };

  return {
    sessionId: 's1',
    turnNumber: 2,
    initialPendingPlanStepIds: new Set<string>(['a', 'b']),
    turnStatus: 'completed' as const,
    stream: broker,
    recorder,
    sessionStore,
    events,
    ...overrides,
  } as any;
};

describe('DefaultReconcileStage', () => {
  it('returns empty when no initial pending steps', async () => {
    const stage = new Reconcile();
    const args = makeArgs({ initialPendingPlanStepIds: new Set() });
    const result = await stage.run(args);

    expect(result.pendingSteps).toHaveLength(0);
    expect(args.events).toHaveLength(0);
  });

  it('returns empty when turn did not complete', async () => {
    const stage = new Reconcile();
    const args = makeArgs({ turnStatus: 'aborted' as any });
    const result = await stage.run(args);

    expect(result.pendingSteps).toHaveLength(0);
    expect(args.events).toHaveLength(0);
  });

  it('preserves unfinished work when a model-call budget ends inside the phase', async () => {
    const stage = new Reconcile();
    const args = makeArgs({
      turnStatus: 'max_tool_calls',
      initialPendingPlanStepIds: new Set(),
      sessionStore: {
        get: vi.fn<() => SessionState | undefined>().mockReturnValue(
          makeSession([
            {
              id: 'active',
              title: 'Active checkpointed work',
              status: 'blocked',
              blockedReason: 'Paused for resume: tool budget exhausted before step completion',
            },
            { id: 'next', title: 'Next objective', status: 'pending' },
            { id: 'done', title: 'Finished objective', status: 'completed' },
            {
              id: 'genuinely-blocked',
              title: 'Needs user input',
              status: 'blocked',
              blockedReason: 'Blocked: waiting for user input',
            },
          ]),
        ),
      },
    });

    const result = await stage.run(args);

    expect(result.pendingSteps.map((step) => step.id)).toEqual(['active', 'next']);
    expect(args.events).toHaveLength(0);
    expect(args.recorder.write).not.toHaveBeenCalled();
  });

  it('returns empty when all initial pending steps are now completed', async () => {
    const stage = new Reconcile();
    const args = makeArgs({
      sessionStore: {
        get: vi.fn<() => SessionState | undefined>().mockReturnValue(
          makeSession([
            { id: 'a', title: 'one', status: 'completed' },
            { id: 'b', title: 'two', status: 'completed' },
          ]),
        ),
      },
    });

    const result = await stage.run(args);
    expect(result.pendingSteps).toHaveLength(0);
    expect(args.events).toHaveLength(0);
  });

  it('emits plan_warning and recorder entry when pending steps remain', async () => {
    const stage = new Reconcile();
    const pending = [
      { id: 'a', title: 'one', status: 'pending' },
      { id: 'b', title: 'two', status: 'pending' },
      { id: 'c', title: 'new', status: 'pending' }, // not in initial set, should be ignored
    ];
    const args = makeArgs({
      sessionStore: {
        get: vi.fn<() => SessionState | undefined>().mockReturnValue(makeSession(pending)),
      },
    });

    const result = await stage.run(args);

    expect(result.pendingSteps.map((p) => p.id)).toEqual(['a', 'b']); // only initial pending set
    const planWarning = args.events.find((e: any) => e.type === 'plan_warning');
    expect(planWarning).toBeDefined();
    expect(planWarning.data.pendingStepIds).toEqual(['a', 'b']);
    expect(args.recorder.write).toHaveBeenCalledWith(
      's1',
      2,
      expect.objectContaining({
        event: 'plan.assertion.pending',
        payload: expect.objectContaining({
          pendingStepIds: ['a', 'b'],
        }),
      }),
    );
  });
});







