import { describe, expect, it, vi } from 'vitest';
import {
  WorkContinuationGuard,
  workCancellationRegistry,
} from '@/domains/agent-brain/application/orchestration/services/WorkContinuationGuard';

const createStore = (session: any) => ({
  get: vi.fn((id: string) => (id === session.id ? session : undefined)),
});

describe('WorkContinuationGuard', () => {
  it('hydrates durable blocked_reason once at the pre-turn boundary', async () => {
    const session: any = {
      id: 'session-durable-blocked',
      flags: {},
    };
    const guard = new WorkContinuationGuard({
      sessionStore: createStore(session) as any,
      sessionRepository: {
        getBlockedReason: vi.fn().mockResolvedValue('aborted_by_user'),
      },
    });

    const decision = await guard.canContinue({
      sessionId: session.id,
      boundary: 'pre_turn',
      hydrateDurable: true,
    });

    expect(decision).toMatchObject({
      ok: false,
      reason: 'aborted_by_user',
      source: 'durable_blocked_reason',
    });
    expect(session.blockedReason).toBe('aborted_by_user');
  });

  it('uses the in-process cancellation marker without a durable lookup on hot boundaries', async () => {
    const runId = 'run-hot-marker';
    const session = {
      id: 'session-hot-marker',
      flags: { securityops: { runId } },
    };
    const getBlockedReason = vi.fn();
    workCancellationRegistry.markRunCancelled(runId);
    const guard = new WorkContinuationGuard({
      sessionStore: createStore(session) as any,
      sessionRepository: { getBlockedReason },
    });

    const decision = await guard.canContinue({
      sessionId: session.id,
      boundary: 'tool_call',
    });

    expect(decision).toMatchObject({
      ok: false,
      reason: 'aborted_by_user',
      source: 'cancellation_marker',
    });
    expect(getBlockedReason).not.toHaveBeenCalled();
  });

  it('lets a newer durable Start override an older run cancellation marker', async () => {
    const runId = 'run-started-after-cancel';
    const session = {
      id: 'session-started-after-cancel',
      flags: { securityops: { runId } },
    };
    workCancellationRegistry.markRunCancelled(runId);
    workCancellationRegistry.markSessionCancelled(session.id);
    workCancellationRegistry.markSessionStarted(session.id);
    const guard = new WorkContinuationGuard({
      sessionStore: createStore(session) as any,
      sessionRepository: { getBlockedReason: vi.fn().mockResolvedValue(null) },
    });

    await expect(guard.canContinue({
      sessionId: session.id,
      boundary: 'tool_call',
    })).resolves.toEqual({ ok: true });

    workCancellationRegistry.markSessionCancelled(session.id);
    await expect(guard.canContinue({
      sessionId: session.id,
      boundary: 'tool_call',
    })).resolves.toMatchObject({
      ok: false,
      source: 'cancellation_marker',
    });
  });

  it('treats an abort signal as a work stop before other checks', async () => {
    const session = {
      id: 'session-abort-signal',
      flags: {},
    };
    const controller = new AbortController();
    controller.abort();
    const guard = new WorkContinuationGuard({
      sessionStore: createStore(session) as any,
    });

    await expect(
      guard.canContinue({
        sessionId: session.id,
        boundary: 'model_call',
        abortSignal: controller.signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'aborted_by_user',
      source: 'abort_signal',
    });
  });
});
