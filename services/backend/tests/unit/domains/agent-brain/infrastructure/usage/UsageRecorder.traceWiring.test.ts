import { describe, expect, it, vi } from 'vitest';
import { UsageRecorder } from '@/domains/agent-brain/infrastructure/usage/UsageRecorder';
import type { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry/SessionTraceRecorder';

/**
 * D6 — production run r1 wrote 140 durable usage rows and zero `model.attempt.*` or
 * `usage.recorded` trace events.
 *
 * `UsageRecorder` had the emission code and `TurnRunner` passed `undefined` into the seventh
 * constructor parameter. The class was correct; the composition was not, which is why no
 * component test caught it. The recorder now arrives at `beginAttempt` and is bound to the
 * attempt, which is the lifetime it actually has.
 */
const makeSession = () => ({
  id: 'session-1',
  turn: 1,
  userId: 'user-1',
  flags: {},
  totalCost: 0,
  totalTokens: 0,
});

const makeRecorder = (overrides: { withConstructorTrace?: SessionTraceRecorder } = {}) => {
  const session = makeSession();
  const sessionStore = {
    get: vi.fn().mockReturnValue(session),
    set: vi.fn(),
  };
  const usageStore = {
    billingMode: 'free' as const,
    beginAttempt: vi.fn().mockResolvedValue({
      id: 'attempt-1',
      attemptOrdinal: 1,
      provider: 'deepseek',
      modelName: 'deepseek-v4-pro',
    }),
    failAttempt: vi.fn().mockResolvedValue(undefined),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  };

  const recorder = new UsageRecorder(
    sessionStore as never,
    undefined,
    usageStore as never,
    'deepseek-v4-pro',
    undefined,
    undefined,
    overrides.withConstructorTrace,
  );

  return { recorder, sessionStore, usageStore };
};

const makeTrace = () => {
  const written: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const trace = {
    write: vi.fn(async (_sessionId: string, _turn: number, entry: { event: string; payload?: unknown }) => {
      written.push({ event: entry.event, payload: (entry.payload ?? {}) as Record<string, unknown> });
    }),
  } as unknown as SessionTraceRecorder;
  return { trace, written };
};

const beginArgs = {
  turn: 1,
  provider: 'deepseek',
  modelName: 'deepseek-v4-pro',
  modelRequestId: 'request-1',
  attemptOrdinal: 1,
} as never;

describe('provider attempt accounting reaches the trace', () => {
  it('writes model.attempt.started through the recorder handed to beginAttempt', async () => {
    const { recorder } = makeRecorder();
    const { trace, written } = makeTrace();

    await recorder.beginAttempt('session-1', beginArgs, trace);

    expect(written.map((entry) => entry.event)).toContain('model.attempt.started');
    expect(written[0]?.payload).toMatchObject({
      attemptId: 'attempt-1',
      provider: 'deepseek',
      status: 'started',
      requestId: 'request-1',
    });
  });

  it('settles the attempt on the same trace without being handed it again', async () => {
    // The failure path has no recorder argument. Binding at beginAttempt is what makes the
    // settle event land in the same session trace as the start event.
    const { recorder } = makeRecorder();
    const { trace, written } = makeTrace();

    await recorder.beginAttempt('session-1', beginArgs, trace);
    await recorder.failAttempt({
      attemptId: 'attempt-1',
      status: 'failed',
      errorClass: 'provider_error',
    } as never);

    expect(written.map((entry) => entry.event)).toEqual([
      'model.attempt.started',
      'model.attempt.settled',
    ]);
    expect(written[1]?.payload).toMatchObject({ status: 'failed', attemptOrdinal: 1 });
  });

  it('writes nothing when no recorder reaches the attempt, and still records durably', async () => {
    // The exact production shape before the fix: durable rows, silent trace.
    const { recorder, usageStore } = makeRecorder();

    await recorder.beginAttempt('session-1', beginArgs);
    await recorder.failAttempt({ attemptId: 'attempt-1', status: 'failed' } as never);

    expect(usageStore.beginAttempt).toHaveBeenCalledTimes(1);
    expect(usageStore.failAttempt).toHaveBeenCalledTimes(1);
  });

  it('prefers the recorder bound to the attempt over one captured at construction', async () => {
    // A long-lived recorder must never win over the one that belongs to this turn, or a
    // trace event lands in the wrong session's file.
    const stale = makeTrace();
    const current = makeTrace();
    const { recorder } = makeRecorder({ withConstructorTrace: stale.trace });

    await recorder.beginAttempt('session-1', beginArgs, current.trace);
    await recorder.failAttempt({ attemptId: 'attempt-1', status: 'cancelled' } as never);

    expect(current.written).toHaveLength(2);
    expect(stale.written).toHaveLength(0);
  });

  it('falls back to a construction-time recorder when the attempt is given none', async () => {
    // The Behavior Lab owns one recorder for the life of a scenario and relies on this.
    const fallback = makeTrace();
    const { recorder } = makeRecorder({ withConstructorTrace: fallback.trace });

    await recorder.beginAttempt('session-1', beginArgs);

    expect(fallback.written.map((entry) => entry.event)).toContain('model.attempt.started');
  });
});
