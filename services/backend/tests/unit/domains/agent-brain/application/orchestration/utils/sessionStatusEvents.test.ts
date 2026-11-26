import { describe, expect, it, vi } from 'vitest';

import {
  deriveSessionStatusForEvent,
  emitSessionStatusEvent,
} from '@/domains/agent-brain/application/orchestration/utils/sessionStatusEvents';

describe('sessionStatusEvents', () => {
  it('emits a stream status event and best-effort trace status_changed event', () => {
    const emitter = { emit: vi.fn() };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const session: any = {
      id: 'session-1',
      turn: 4,
      version: 7,
      mode: 'automated',
      blockedReason: 'user_paused',
      pendingApproval: undefined,
      flags: {
        securityops: {
          runId: 'run-1',
          activePhaseId: 'phase-1',
        },
      },
      stateMachine: {
        isProcessing: vi.fn(() => false),
      },
    };

    emitSessionStatusEvent(
      emitter,
      session,
      deriveSessionStatusForEvent({ ...session, blockedReason: undefined }),
      'user_paused',
      recorder,
    );

    expect(emitter.emit).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'session.status',
        data: expect.objectContaining({
          status: 'paused',
          reason: 'user_paused',
        }),
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      'session-1',
      4,
      expect.objectContaining({
        event: 'session.status_changed',
        severity: 'info',
        payload: expect.objectContaining({
          reason: 'user_paused',
          source: 'user',
          runId: 'run-1',
          phaseId: 'phase-1',
        }),
      }),
    );
  });
});
