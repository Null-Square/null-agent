import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycleService } from '@/domains/agent-brain/application/services/SessionLifecycleService';
import type { SessionFlags, SessionState } from '@/domains/agent-brain/domain/types';
import type { SessionStateMachine } from '@/domains/agent-brain/domain/state';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const buildSession = (
  overrides: Partial<SessionState> = {},
): SessionState & { stateMachine: SessionStateMachine } => {
  const mockStateMachine = {
    isProcessing: vi.fn(() => true),
    stopProcessing: vi.fn(),
    startProcessing: vi.fn(),
    canStartProcessing: vi.fn(() => false),
    getState: vi.fn(() => 'processing'),
  } as unknown as SessionStateMachine;

  return {
    id: 'session-1',
    userId: 'user-1',
    mode: 'automated',
    profileKey: 'profile-1',
    turn: 3,
    flags: {} as SessionFlags,
    stateMachine: mockStateMachine,
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    workspaceDir: 'workspace',
    pendingApproval: undefined,
    checkpoints: {},
    createdAt: Date.now(),
    lastActive: Date.now(),
    ...overrides,
  };
};

describe('SessionLifecycleService.transitionToBlocked', () => {
  it('applies blocked transitions in explicit order', async () => {
    const session = buildSession();
    const calls: string[] = [];
    const sessionStore = {
      get: vi.fn(() => session),
      setAsync: vi.fn(async (_sessionId: string, nextSession: SessionState, note?: string) => {
        calls.push(`store:${note}`);
        expect(nextSession.blockedReason).toBe('system_paused');
        expect(nextSession.blockedMeta).toMatchObject({
          code: 'retry_exhausted',
          errorCode: 'llm_timeout',
          recoverable: true,
          turn: 9,
        });
      }),
    };
    const sessionRepository = {
      setBlockedReason: vi.fn(async () => {
        calls.push('repo');
        return true;
      }),
    };
    const notificationPort = {
      notify: vi.fn(async () => {
        calls.push('notify');
      }),
    };
    const recorder = {
      write: vi.fn(async () => {
        calls.push('trace');
      }),
    };
    const events = {
      emit: vi.fn(() => {
        calls.push('event');
      }),
    };
    const service = SessionLifecycleService.forOrchestration({
      sessionStore,
      sessionRepository,
      notificationPort,
      events,
    });

    await service.transitionToBlocked({
      sessionId: session.id,
      session,
      classification: {
        blockedReason: 'system_paused',
        recoverable: true,
        code: 'retry_exhausted',
        errorCode: 'llm_timeout',
        message: 'Request timed out.',
        userMessage: 'The provider timed out.',
        retryable: true,
        retryAfterMs: 1000,
        turnNumber: 9,
      },
      recorder: recorder as any,
    });

    expect(session.stateMachine.stopProcessing).toHaveBeenCalledWith(
      'system_paused',
      session.turn,
      'SessionLifecycleService',
    );
    expect(session.flags).not.toHaveProperty('resume_checkpoint');
    expect(sessionRepository.setBlockedReason).toHaveBeenCalledWith(
      session.id,
      'system_paused',
      expect.objectContaining({
        reason: 'system_paused',
        recoverable: true,
        turn: 9,
      }),
    );
    expect(recorder.write).toHaveBeenNthCalledWith(
      1,
      session.id,
      session.turn,
      expect.objectContaining({
        event: 'session.status_changed',
        payload: expect.objectContaining({
          from: 'running',
          to: 'paused',
          reason: 'recoverable_error_blocked',
          blocked_reason: 'system_paused',
        }),
      }),
    );
    expect(recorder.write).toHaveBeenNthCalledWith(
      2,
      session.id,
      9,
      expect.objectContaining({
        event: 'turn.error.recoverable_paused',
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        type: 'session.status',
        data: expect.objectContaining({
          status: 'paused',
          pause_reason: 'system',
          blocked_reason: 'system_paused',
        }),
      }),
    );
    expect(notificationPort.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'session_error',
        title: 'Session Needs Attention',
      }),
    );
    expect(calls).toEqual([
      'store:process.error.recoverable_paused',
      'event',
      'trace',
      'repo',
      'trace',
      'notify',
    ]);
  });

  it('does not stop processing again when the session is already idle', async () => {
    const session = buildSession();
    session.stateMachine.getState = vi.fn(() => 'idle') as any;
    const sessionStore = {
      get: vi.fn(() => session),
      setAsync: vi.fn(async () => undefined),
    };
    const service = SessionLifecycleService.forOrchestration({
      sessionStore,
    });

    await service.transitionToBlocked({
      sessionId: session.id,
      session,
      classification: {
        blockedReason: 'system_paused',
        recoverable: true,
        code: 'retry_exhausted',
        errorCode: 'llm_timeout',
        message: 'Request timed out.',
        userMessage: 'The provider timed out.',
        retryable: true,
        retryAfterMs: 1000,
        turnNumber: 9,
      },
    });

    expect(session.stateMachine.stopProcessing).not.toHaveBeenCalled();
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      session.id,
      session,
      'process.error.recoverable_paused',
    );
  });
});
