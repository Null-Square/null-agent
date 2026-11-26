import { describe, expect, it } from 'vitest';
import { SessionResolverService } from '@/domains/platform/sessions/SessionResolverService';

describe('SessionResolverService', () => {
  const service = new SessionResolverService();
  const nowMs = Date.parse('2026-04-18T12:00:00.000Z');

  it('derives running from recent activity when nothing else is blocking the session', () => {
    const derived = service.deriveRuntimeState({
      session: {
        lastActiveAt: new Date(nowMs - 15_000),
        blockedReason: null,
        completed: false,
      },
      nowMs,
    });

    expect(derived.status).toBe('running');
    expect(derived.isProcessing).toBe(true);
    expect(derived.blockedReason).toBeNull();
  });

  it('trusts an explicit idle live state over recent activity', () => {
    const derived = service.deriveRuntimeState({
      session: {
        lastActiveAt: new Date(nowMs - 5_000),
        blockedReason: null,
        completed: false,
      },
      liveSession: {
        stateMachine: {
          isProcessing: () => false,
        },
        lastActive: nowMs - 1_000,
      },
      nowMs,
    });

    expect(derived.status).toBe('idle');
    expect(derived.isProcessing).toBe(false);
  });

  it('does not treat recent activity as processing when blocked_reason is present', () => {
    const derived = service.deriveRuntimeState({
      session: {
        lastActiveAt: new Date(nowMs - 5_000),
        blockedReason: 'credits_exhausted',
        completed: false,
      },
      nowMs,
    });

    expect(derived.status).toBe('paused');
    expect(derived.pauseReason).toBe('credits');
    expect(derived.isProcessing).toBe(false);
    expect(derived.blockedReason).toBe('credits_exhausted');
  });

  it('prefers live processing over stale manual and system pause markers', () => {
    for (const blockedReason of ['user_paused', 'system_paused']) {
      const derived = service.deriveRuntimeState({
        session: {
          lastActiveAt: new Date(nowMs - 5_000),
          blockedReason,
          completed: false,
        },
        liveSession: {
          blockedReason,
          stateMachine: {
            isProcessing: () => true,
          },
        },
        nowMs,
      });

      expect(derived.status).toBe('running');
      expect(derived.pauseReason).toBeNull();
      expect(derived.isProcessing).toBe(true);
      expect(derived.blockedReason).toBeNull();
    }
  });

  it('prefers explicit processing over stale manual and system pause markers', () => {
    for (const blockedReason of ['user_paused', 'system_paused']) {
      const derived = service.deriveRuntimeState({
        session: {
          lastActiveAt: new Date(nowMs - 5_000),
          blockedReason,
          completed: false,
        },
        isProcessing: true,
        nowMs,
      });

      expect(derived.status).toBe('running');
      expect(derived.pauseReason).toBeNull();
      expect(derived.isProcessing).toBe(true);
      expect(derived.blockedReason).toBeNull();
    }
  });

  it('does not let recent activity alone override manual pause markers', () => {
    const derived = service.deriveRuntimeState({
      session: {
        lastActiveAt: new Date(nowMs - 5_000),
        blockedReason: 'user_paused',
        completed: false,
      },
      nowMs,
    });

    expect(derived.status).toBe('paused');
    expect(derived.pauseReason).toBe('manual');
    expect(derived.isProcessing).toBe(false);
    expect(derived.blockedReason).toBe('user_paused');
  });

  it('does not let live processing override hard operator or billing blocks', () => {
    const derived = service.deriveRuntimeState({
      session: {
        lastActiveAt: new Date(nowMs - 5_000),
        blockedReason: 'credits_exhausted',
        completed: false,
      },
      liveSession: {
        blockedReason: 'credits_exhausted',
        stateMachine: {
          isProcessing: () => true,
        },
      },
      nowMs,
    });

    expect(derived.status).toBe('paused');
    expect(derived.pauseReason).toBe('credits');
    expect(derived.isProcessing).toBe(false);
    expect(derived.blockedReason).toBe('credits_exhausted');
  });

  it('derives completed when the durable row says the session is complete', () => {
    const derived = service.deriveRuntimeState({
      session: {
        lastActiveAt: new Date(nowMs - 5_000),
        blockedReason: null,
        completed: true,
      },
      nowMs,
    });

    expect(derived.status).toBe('completed');
    expect(derived.completed).toBe(true);
  });

  it('derives idle when activity is stale and there is no other runtime marker', () => {
    const derived = service.deriveRuntimeState({
      session: {
        lastActiveAt: new Date(nowMs - 5 * 60_000),
        blockedReason: null,
        completed: false,
      },
      nowMs,
    });

    expect(derived.status).toBe('idle');
    expect(derived.isProcessing).toBe(false);
  });
});
