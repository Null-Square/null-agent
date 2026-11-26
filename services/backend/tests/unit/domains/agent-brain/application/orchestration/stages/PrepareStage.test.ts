import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultPrepareStage } from '@/domains/agent-brain/application/orchestration/stages/PrepareStage';

describe('DefaultPrepareStage profile locks', () => {
  const createSession = () => ({
    id: 'session-1',
    profileKey: 'security-assistant',
    flags: {
      policy_lock: {
        profileKey: 'security-assistant',
      },
      brain_policy: {
        profile: 'security-assistant',
        source: 'explicit',
      },
    },
    stateMachine: {
      canStartProcessing: vi.fn(() => true),
      startProcessing: vi.fn(),
      isProcessing: vi.fn(() => false),
    },
    plan: [],
    turn: 0,
    messages: [],
  });

  const events = { emit: vi.fn() };
  const streamFactory = vi.fn(() => ({ message: vi.fn() }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores profile overrides for locked sessions', async () => {
    const session = createSession();
    const sessionStore = {
      getOrHydrate: vi.fn(async () => session),
      setAsync: vi.fn(async () => true),
      get: vi.fn(() => session),
      startTurnAsync: vi.fn(async () => undefined),
      appendMessageAsync: vi.fn(async () => undefined),
    };
    const policyResolver = {
      resolve: vi.fn(async (state) => state),
    };

    const stage = new DefaultPrepareStage();
    await stage.run({
      sessionId: 'session-1',
      userInput: '',
      profileKey: 'network-enabled',
      sessionStore: sessionStore as any,
      policyResolver: policyResolver as any,
      events: events as any,
      streamFactory: streamFactory as any,
    });

    expect(session.profileKey).toBe('security-assistant');
    expect(policyResolver.resolve).not.toHaveBeenCalled();
  });

  it('uses the existing already-processing path when turn ownership is not acquired', async () => {
    const session = createSession();
    const sessionStore = {
      getOrHydrate: vi.fn(async () => session),
      setAsync: vi.fn(async () => true),
      get: vi.fn(() => session),
      startTurnAsync: vi.fn(async () => false),
      appendMessageAsync: vi.fn(async () => undefined),
    };
    const stage = new DefaultPrepareStage();

    await expect(stage.run({
      sessionId: 'session-1',
      userInput: '',
      sessionStore: sessionStore as any,
      policyResolver: { resolve: vi.fn(async (state) => state) } as any,
      events: events as any,
      streamFactory: streamFactory as any,
    })).rejects.toThrow('session_already_processing');
    expect(sessionStore.appendMessageAsync).not.toHaveBeenCalled();
  });
});
