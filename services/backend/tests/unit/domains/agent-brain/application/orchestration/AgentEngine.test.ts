import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import type { SessionState } from '@/domains/agent-brain/domain/types';

// Use vi.hoisted() to create mocks that will be available to vi.mock factories
const mocks = vi.hoisted(() => {
  return {
    initializeMock: vi.fn(),
    cleanupMock: vi.fn(),
    provisionMock: vi.fn(),
    stopMock: vi.fn(),
    destroyMock: vi.fn(),
    getPolicyMock: vi.fn(),
  };
});

// Mock the modules BEFORE import - use factory functions that reference hoisted mocks
vi.mock('@/domains/agent-brain/application/orchestration/services/SessionLifecycleManager', () => {
  return {
    SessionLifecycleManager: class MockSessionLifecycleManager {
      initialize = mocks.initializeMock;
      cleanup = mocks.cleanupMock;
    },
  };
});

vi.mock('@/domains/agent-brain/application/orchestration/services/SandboxProvisioner', () => {
  return {
    SandboxProvisioner: class MockSandboxProvisioner {
      provision = mocks.provisionMock;
      stop = mocks.stopMock;
      destroy = mocks.destroyMock;
      getPolicy = mocks.getPolicyMock;
    },
  };
});

// Import AFTER mocks are set up
import { AgentEngine } from '@/domains/agent-brain/application/orchestration/AgentEngine';

const createEngine = () => {
  const events = {
    emit: vi.fn(),
    cleanup: vi.fn(),
    emitPlan: vi.fn(),
  };
  const sandbox = {
    provision: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    getPolicy: vi.fn(),
  };
  const sessions = {
    set: vi.fn(),
    updatePlan: vi.fn(),
  } as any;

  return {
    engine: new AgentEngine({ events, sandbox } as any, sessions),
    events,
    sandbox,
  };
};

describe('AgentEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes session then provisions sandbox', async () => {
    const { engine } = createEngine();
    const session = { id: 'session-1' } as SessionState;
    const preparation = { plan: [{ id: 'p1' }] } as any;

    await engine.initializeSession({ session, preparation, sandboxImage: 'img-1' });

    expect(mocks.initializeMock).toHaveBeenCalledWith(session, preparation, undefined);
    expect(mocks.provisionMock).toHaveBeenCalledWith(session, 'img-1', undefined);
    expect(mocks.initializeMock.mock.invocationCallOrder[0]).toBeLessThan(mocks.provisionMock.mock.invocationCallOrder[0]);
  });

  it('provisions sandbox directly when requested', async () => {
    const { engine } = createEngine();
    const session = { id: 'session-2' } as SessionState;
    mocks.provisionMock.mockResolvedValue({ profile: 'dev' });

    const result = await engine.provisionSandbox({ session, sandboxImage: 'custom-img' });

    expect(mocks.provisionMock).toHaveBeenCalledWith(session, 'custom-img', undefined);
    expect(result).toEqual({ profile: 'dev' });
  });

  it('cleans up sandbox and lifecycle even when destroy fails', async () => {
    const { engine } = createEngine();
    const session = { id: 'session-3' } as SessionState;
    mocks.destroyMock.mockRejectedValueOnce(new Error('boom'));

    await engine.cleanupSession(session.id, session);

    expect(mocks.destroyMock).toHaveBeenCalledWith(session);
    expect(mocks.cleanupMock).toHaveBeenCalledWith(session.id);
  });
});
