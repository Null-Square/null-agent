import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMessagingController } from '@/interfaces/http/controllers/ai-agent/controllers/SessionMessagingController';

/**
 * A session can outlive the target it was created against, so the follow-up
 * message path re-checks target ownership instead of trusting session creation.
 */
describe('SessionMessagingController.sendMessage scope ownership gate', () => {
  const processMessage = vi.fn();
  const check = vi.fn();
  const recordInputAndStartRequestedAsync = vi.fn();
  const findById = vi.fn();
  const deriveRuntimeState = vi.fn();
  const enforceRunObservabilityAccess = vi.fn();
  const getExecutionReadModel = vi.fn();
  const getBlockedReason = vi.fn();

  const buildController = (session: Record<string, unknown>) =>
    new SessionMessagingController({
      services: {
        sessionStore: {
          getOrHydrate: vi.fn().mockResolvedValue(session),
          recordInputAndStartRequestedAsync,
          getExecutionReadModel,
        },
        orchestrator: { processMessage },
        ports: { events: { emit: vi.fn() } },
        traceRecorder: undefined,
      },
      sessionRepository: { findById, getBlockedReason },
      messageRepository: {} as never,
      artifactRepository: {} as never,
      sessionService: {} as never,
      sessionSummaryService: {} as never,
      scopeVerificationGate: { check },
      accessControl: { enforceRunObservabilityAccess } as never,
      responseBuilder: { deriveRuntimeState } as never,
      artifactStorageRoot: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      options: {},
    } as never);

  const buildRes = () => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    return res;
  };

  const req = (sessionId = 'session-1') => ({
    params: { sessionId },
    body: { text: 'what is exposed?' },
    user: { id: 'user-1' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    check.mockResolvedValue({ verified: true });
    processMessage.mockResolvedValue(undefined);
    recordInputAndStartRequestedAsync.mockResolvedValue(true);
    findById.mockResolvedValue(null);
    deriveRuntimeState.mockReturnValue({
      status: 'paused',
      pauseReason: 'manual',
      interactionType: 'none',
    });
    getExecutionReadModel.mockResolvedValue({
      desiredExecution: 'running',
      condition: 'recovering',
    });
    getBlockedReason.mockResolvedValue(null);
    enforceRunObservabilityAccess.mockResolvedValue(undefined);
  });

  it('rejects with 403 and never reaches the orchestrator when ownership is unverified', async () => {
    check.mockResolvedValue({ verified: false, reason: 'unverified' });
    const controller = buildController({
      id: 'session-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      mode: 'interactive',
      flags: { securityops: { assistantMode: 'read_only_chat', scopeId: 'scope-1' } },
    });
    const res = buildRes();

    await controller.sendMessage(req() as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      accepted: false,
      code: 'scope.target_unverified',
      reason: 'unverified',
    });
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('rejects when the ownership lookup fails', async () => {
    check.mockResolvedValue({ verified: false, reason: 'lookup_failed' });
    const controller = buildController({
      id: 'session-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      mode: 'interactive',
      flags: { securityops: { scopeId: 'scope-1' } },
    });
    const res = buildRes();

    await controller.sendMessage(req() as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('accepts the message when ownership is verified', async () => {
    const controller = buildController({
      id: 'session-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      mode: 'interactive',
      flags: { securityops: { assistantMode: 'read_only_chat', scopeId: 'scope-1' } },
    });
    const res = buildRes();

    await controller.sendMessage(req() as never, res as never);

    expect(check).toHaveBeenCalledWith('scope-1');
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      accepted: true,
      scheduled: true,
      desiredExecution: 'running',
      condition: 'recovering',
    });
    expect(recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        role: 'user',
        content: 'what is exposed?',
        metadata: expect.objectContaining({ source: 'human' }),
      }),
      'message accepted',
      'user-1',
    );
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('leaves sessions without a scope untouched', async () => {
    const controller = buildController({
      id: 'session-1',
      userId: 'user-1',
      mode: 'interactive',
      flags: {},
    });
    const res = buildRes();

    await controller.sendMessage(req() as never, res as never);

    expect(check).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(202);
  });

  it('durably accepts a message and schedules Start for a cancelled workbench session', async () => {
    const session = {
      id: 'session-1',
      userId: 'user-1',
      mode: 'automated',
      blockedReason: 'aborted_by_user',
      flags: { securityops: { runId: 'run-1' } },
      version: 4,
    };
    findById.mockResolvedValue({
      blockedReason: 'aborted_by_user',
      completed: false,
      metadata: {},
    });
    const controller = buildController(session);
    const res = buildRes();

    await controller.sendMessage(req() as never, res as never);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      accepted: true,
      scheduled: true,
      desiredExecution: 'running',
      condition: 'recovering',
    });
    expect(recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        role: 'user',
        content: 'what is exposed?',
        id: expect.any(String),
      }),
      'workbench message accepted',
      'user-1',
    );
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('does not accept free-form input while a workbench turn is still running', async () => {
    getExecutionReadModel.mockResolvedValue({
      desiredExecution: 'running',
      condition: 'executing',
    });
    deriveRuntimeState.mockReturnValue({
      status: 'running',
      pauseReason: null,
      interactionType: 'none',
    });
    const controller = buildController({
      id: 'session-1',
      userId: 'user-1',
      mode: 'automated',
      flags: { securityops: { runId: 'run-1' } },
    });
    const res = buildRes();

    await controller.sendMessage(req() as never, res as never);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      accepted: false,
      desiredExecution: 'running',
      condition: 'executing',
      message: 'Stop the run before sending a workbench message.',
    });
    expect(recordInputAndStartRequestedAsync).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });
});
