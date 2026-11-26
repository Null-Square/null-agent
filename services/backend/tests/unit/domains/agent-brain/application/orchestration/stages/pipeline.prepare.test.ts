import { vi, describe, it, expect, beforeEach } from 'vitest';

const createStateMachine = (processing = false) => {
  let current = processing;
  return {
    isProcessing: () => current,
    startProcessing: vi.fn(() => {
      current = true;
      return true;
    }),
    stopProcessing: vi.fn(() => {
      current = false;
      return true;
    }),
    awaitUser: vi.fn(() => {
      current = false;
      return true;
    }),
    resumeProcessing: vi.fn(() => {
      current = true;
      return true;
    }),
    canStartProcessing: () => !current,
    getState: () => current ? 'processing' : 'idle',
  };
};
import { DefaultStages } from '@/domains/agent-brain/application/orchestration/stages';
import type { SessionState, Message } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'uuid-1'),
}));

const Prepare = DefaultStages.Prepare;

type SessionOverrides = Partial<SessionState> & { isProcessing?: boolean };

const createSession = (overrides: SessionOverrides = {}): SessionState => ({
  id: 'session-1',
  userId: 'user-1',
  // isProcessing removed - using stateMachine
  mode: 'interactive',
  messages: [],
  plan: [],
  memory: createEmptyMemory(),
  flags: {},
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 0,
  pendingApproval: undefined,
  checkpoints: {},
  workspaceDir: '/tmp/session-workspace',
  stateMachine: (overrides.stateMachine ??
    (createStateMachine(Boolean(overrides.isProcessing)) as unknown as SessionState['stateMachine'])),
  ...overrides,
});

const createSessionStore = (session?: SessionState) => ({
  get: vi.fn(() => session),
  getOrHydrate: vi.fn(async () => session),
  setAsync: vi.fn(async (_id: string, next: SessionState) => {
    if (session) Object.assign(session, next);
  }),
  startTurnAsync: vi.fn(),
  appendMessageAsync: vi.fn(async (_id: string, message: Message) => {
    session?.messages.push(message);
  }),
});

describe('DefaultPrepareStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits an error and throws when session is missing', async () => {
    const stage = new Prepare();
    const sessionStore = createSessionStore(undefined);
    const events = { emit: vi.fn() };

    await expect(
      stage.run({
        sessionId: 'missing',
        userInput: 'hi',
        sessionStore: sessionStore as any,
        policyResolver: { resolve: vi.fn() } as any,
        events: events as any,
        streamFactory: vi.fn(() => ({ message: vi.fn() })) as any,
      }),
    ).rejects.toThrow('session_not_found');

    expect(events.emit).toHaveBeenCalledWith(
      'missing',
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
      }),
    );
  });

  it('refreshes policy, snapshots tool policy, and appends a user message', async () => {
    const stage = new Prepare();
    const session = createSession({ profileKey: 'old', toolPolicy: { tools: ['a'] } as any });
    const sessionStore = createSessionStore(session);
    const events = { emit: vi.fn() };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };
    const stream = { message: vi.fn() };
    const policyResolver = {
      resolve: vi.fn(async (state: SessionState) => ({
        ...state,
        flags: { ...state.flags, brain_policy: { id: 'bp' } },
      })),
    };

    const result = await stage.run({
      sessionId: session.id,
      userInput: 'hello',
      profileKey: ' new ',
      extraContext: 'ctx',
      sessionStore: sessionStore as any,
      policyResolver: policyResolver as any,
      events: events as any,
      traceRecorder: recorder as any,
      streamFactory: vi.fn(() => stream) as any,
    });

    expect(policyResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ profileKey: 'new' }),
      'new',
    );
    expect(session.flags?.policy_base?.toolPolicy).toEqual(session.toolPolicy);
    expect(session.extraContext).toBe('ctx');
    expect(sessionStore.appendMessageAsync).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ id: 'uuid-1', role: 'user', content: 'hello' }),
    );
    expect(stream.message).toHaveBeenCalled();
    expect(result.userMessage?.id).toBe('uuid-1');
    expect(session.turn).toBe(1);
    // PrepareStage calls startProcessing - verify via spy
    expect(session.stateMachine?.startProcessing).toHaveBeenCalled();
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({ event: 'user.message' }),
    );
  });

  it('appends internal kickoff messages without streaming them to the user transcript', async () => {
    const stage = new Prepare();
    const session = createSession();
    const sessionStore = createSessionStore(session);
    const stream = { message: vi.fn() };

    const result = await stage.run({
      sessionId: session.id,
      userInput: 'internal kickoff',
      messageMetadata: { visibility: 'internal', source: 'planner_kickoff' },
      sessionStore: sessionStore as any,
      policyResolver: { resolve: vi.fn(async (state: SessionState) => state) } as any,
      events: { emit: vi.fn() } as any,
      streamFactory: vi.fn(() => stream) as any,
    });

    expect(sessionStore.appendMessageAsync).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        content: 'internal kickoff',
        metadata: { visibility: 'internal', source: 'planner_kickoff' },
      }),
    );
    expect(stream.message).not.toHaveBeenCalled();
    expect(result.userMessage?.metadata).toEqual({
      visibility: 'internal',
      source: 'planner_kickoff',
    });
  });

  it('does not append a message when user input is blank', async () => {
    const stage = new Prepare();
    const session = createSession();
    const sessionStore = createSessionStore(session);
    const stream = { message: vi.fn() };

    const result = await stage.run({
      sessionId: session.id,
      userInput: '   ',
      sessionStore: sessionStore as any,
      policyResolver: { resolve: vi.fn(async (state: SessionState) => state) } as any,
      events: { emit: vi.fn() } as any,
      streamFactory: vi.fn(() => stream) as any,
    });

    expect(sessionStore.appendMessageAsync).not.toHaveBeenCalled();
    expect(stream.message).not.toHaveBeenCalled();
    expect(result.userMessage).toBeUndefined();
  });

  it('rethrows policy.default_missing errors', async () => {
    const stage = new Prepare();
    const session = createSession();
    const sessionStore = createSessionStore(session);
    const policyResolver = {
      resolve: vi.fn(async () => {
        throw new Error('policy.default_missing');
      }),
    };

    await expect(
      stage.run({
        sessionId: session.id,
        userInput: 'hi',
        sessionStore: sessionStore as any,
        policyResolver: policyResolver as any,
        events: { emit: vi.fn() } as any,
        streamFactory: vi.fn(() => ({ message: vi.fn() })) as any,
      }),
    ).rejects.toThrow('policy.default_missing');
  });
});



