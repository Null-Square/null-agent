import { describe, expect, it, vi } from 'vitest';

import { ProcessMessageCommand } from '@/domains/agent-brain/application/orchestration/commands/ProcessMessageCommand';

describe('ProcessMessageCommand recovery integrity', () => {
  it('propagates failure to create the durable closeout wake-up', async () => {
    const persistenceError = new Error('journal unavailable');
    const session = {
      id: 'session-1',
      turn: 3,
      mode: 'automated',
      completed: false,
      flags: { securityops: { runId: 'run-1' } },
    };
    const command = new ProcessMessageCommand({
      sessionStore: {
        recordCloseoutRequestedAsync: vi.fn(async () => { throw persistenceError; }),
      },
      sessionRepository: {
        setBlockedReasonIfClear: vi.fn(async () => true),
      },
      log: { error: vi.fn() },
    } as never);

    await expect((command as any).persistSystemPauseForCloseout(
      session,
      'closeout is not ready',
      null,
    )).rejects.toBe(persistenceError);
    expect(session.completed).toBe(false);
    expect(session).not.toHaveProperty('blockedReason');
    expect(session.flags).toEqual({ securityops: { runId: 'run-1' } });
  });

  it('propagates failure to commit an accepted phase handoff completion', async () => {
    const session = {
      id: 'session-1',
      turn: 2,
      completed: false,
      flags: {
        securityops: {
          activePhaseKey: 'recon',
          phaseHandoffSubmitted: true,
          phaseHandoffStatus: 'completed',
        },
      },
    };
    const command = new ProcessMessageCommand({
      sessionStore: {
        get: vi.fn(() => session),
        recordSessionCompletedAsync: vi.fn(async () => false),
      },
      sessionRepository: {
        setCompleted: vi.fn(async () => false),
      },
      log: { warn: vi.fn() },
    } as never);

    await expect((command as any).markAcceptedPhaseSessionCompleted(session.id))
      .rejects.toThrow('durable_phase_session_completion_failed');
    expect(session.completed).toBe(false);
  });

  it('propagates closeout completion failure so the worker schedules backoff', async () => {
    const session = {
      id: 'session-1',
      turn: 4,
      completed: false,
      flags: {},
    };
    const setAsync = vi.fn();
    const command = new ProcessMessageCommand({
      sessionStore: {
        recordCloseoutCompletedAsync: vi.fn(async () => false),
        setAsync,
      },
      sessionRepository: {
        setCompleted: vi.fn(async () => false),
      },
      log: { warn: vi.fn() },
    } as never);

    await expect((command as any).completeSessionAfterCloseout(session, null))
      .rejects.toThrow('durable_closeout_completion_failed');
    expect(session.completed).toBe(false);
    expect(setAsync).not.toHaveBeenCalled();
  });
});
