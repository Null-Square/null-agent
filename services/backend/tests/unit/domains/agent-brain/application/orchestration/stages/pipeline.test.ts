import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockStateMachine = (processing: boolean) => ({
  isProcessing: () => processing,
  startProcessing: vi.fn(() => true),
  stopProcessing: vi.fn(() => true),
  canStartProcessing: () => !processing,
  getState: () => processing ? 'processing' : 'idle',
});
import { DefaultStages } from '@/domains/agent-brain/application/orchestration/stages';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const Prepare = DefaultStages.Prepare;

const createSession = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: 'session-1',
  userId: 'user-1',
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
  ...overrides,
});

const createSessionStore = (session?: SessionState) => ({
  get: vi.fn(() => session),
  getOrHydrate: vi.fn(async () => session),
  setAsync: vi.fn(async (_id: string, next: SessionState) => {
    if (session) Object.assign(session, next);
  }),
  startTurnAsync: vi.fn(),
  appendMessageAsync: vi.fn(),
});

const createStateMachine = () => ({
  canStartProcessing: vi.fn(() => true),
  startProcessing: vi.fn(),
  stopProcessing: vi.fn(),
  isProcessing: vi.fn(() => false),
  getState: vi.fn(() => 'idle'),
});

type SandboxHealthShape = {
  healthy: boolean;
  containerId: string;
  containerRunning: boolean;
  diskSpaceOk: boolean;
  lastCheckAt: number;
  errors: string[];
};

const buildHealth = (overrides: Partial<SandboxHealthShape> = {}): SandboxHealthShape => ({
  healthy: true,
  containerId: 'container-1',
  containerRunning: true,
  diskSpaceOk: true,
  lastCheckAt: Date.now(),
  errors: [],
  ...overrides,
});

describe('DefaultPrepareStage sandbox health check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips health check when checker is not provided', async () => {
    const stage = new Prepare();
    const session = createSession({ containerId: 'container-1' });
    const sessionStore = createSessionStore(session);
    const healthChecker = { check: vi.fn() };

    await stage.run({
      sessionId: session.id,
      userInput: '',
      sessionStore: sessionStore as any,
      policyResolver: { resolve: vi.fn(async (state: SessionState) => state) } as any,
      events: { emit: vi.fn() } as any,
      streamFactory: vi.fn(() => ({ message: vi.fn() })) as any,
    });

    expect(healthChecker.check).not.toHaveBeenCalled();
    expect(sessionStore.startTurnAsync).toHaveBeenCalled();
  });

  it('skips health check when session has no containerId', async () => {
    const stage = new Prepare();
    const session = createSession();
    const sessionStore = createSessionStore(session);
    const healthChecker = { check: vi.fn(async () => buildHealth()) };

    await stage.run({
      sessionId: session.id,
      userInput: '',
      sessionStore: sessionStore as any,
      policyResolver: { resolve: vi.fn(async (state: SessionState) => state) } as any,
      events: { emit: vi.fn() } as any,
      streamFactory: vi.fn(() => ({ message: vi.fn() })) as any,
      sandboxHealthChecker: healthChecker,
    });

    expect(healthChecker.check).not.toHaveBeenCalled();
    expect(sessionStore.startTurnAsync).toHaveBeenCalled();
  });

  it('continues when health check reports healthy', async () => {
    const stage = new Prepare();
    const session = createSession({ containerId: 'container-1' });
    const sessionStore = createSessionStore(session);
    const healthChecker = { check: vi.fn(async () => buildHealth()) };

    await stage.run({
      sessionId: session.id,
      userInput: '',
      sessionStore: sessionStore as any,
      policyResolver: { resolve: vi.fn(async (state: SessionState) => state) } as any,
      events: { emit: vi.fn() } as any,
      streamFactory: vi.fn(() => ({ message: vi.fn() })) as any,
      sandboxHealthChecker: healthChecker,
    });

    expect(healthChecker.check).toHaveBeenCalledWith('container-1');
    expect(sessionStore.startTurnAsync).toHaveBeenCalled();
  });

  it('clears a dead container binding without creating a pause authority', async () => {
    const stage = new Prepare();
    const stateMachine = createStateMachine();
    const session = createSession({
      containerId: 'container-1',
      stateMachine: stateMachine as any,
    });
    const sessionStore = createSessionStore(session);
    const healthChecker = { check: vi.fn(async () => buildHealth({ healthy: false, errors: ['dead'], containerRunning: false, diskSpaceOk: false })) };

    await expect(
      stage.run({
        sessionId: session.id,
        userInput: '',
        sessionStore: sessionStore as any,
        policyResolver: { resolve: vi.fn(async (state: SessionState) => state) } as any,
        events: { emit: vi.fn() } as any,
        streamFactory: vi.fn(() => ({ message: vi.fn() })) as any,
        sandboxHealthChecker: healthChecker,
      }),
    ).rejects.toThrow('sandbox_unhealthy');

    expect(stateMachine.stopProcessing).toHaveBeenCalledWith(
      'sandbox_unhealthy',
      session.turn,
      'pipeline.healthCheck',
    );
    expect((session.stateMachine?.isProcessing() ?? false)).toBe(false);
    expect(session.blockedReason).toBeUndefined();
    expect(session.containerId).toBeUndefined();
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ containerId: undefined }),
      'pipeline.healthCheck.container_reset',
    );
  });
});




