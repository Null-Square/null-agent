import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnFailurePolicy } from '@/domains/agent-brain/application/orchestration/services/TurnFailurePolicy';
import { ErrorFactory } from '@/domains/agent-brain/domain/errors';
import { AppError } from '@/domains/agent-brain/domain/errors';
import type { SessionFlags, SessionState } from '@/domains/agent-brain/domain/types';
import type { SessionStateMachine } from '@/domains/agent-brain/domain/state';
import { ERROR_CODES } from '@null-ai/contracts';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';
import { SessionLifecycleService } from '@/domains/agent-brain/application/services/SessionLifecycleService';

const buildSession = (
  overrides: Partial<SessionState> = {}
): SessionState & { stateMachine: SessionStateMachine } => {
  const mockStateMachine = {
    isProcessing: vi.fn(() => true),  // Default to processing for tests
    stopProcessing: vi.fn(),
    startProcessing: vi.fn(),
    canStartProcessing: vi.fn(() => false),
    getState: vi.fn(() => 'processing'),
  } as unknown as SessionStateMachine;
  
  return {
    id: 'session-1',
    mode: 'automated',
    profileKey: 'profile-1',
    turn: 1,
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

const buildPolicy = (session: any) => {
  const sessionStore = {
    get: vi.fn(() => session),
    setAsync: vi.fn().mockResolvedValue(undefined),
  };
  const retryScheduler = {
    scheduleRetry: vi.fn().mockResolvedValue(undefined),
  };
  const sessionRepository = {
    setBlockedReason: vi.fn().mockResolvedValue(true),
  };
  const sessionLifecycle = SessionLifecycleService.forOrchestration({
    sessionStore: sessionStore as any,
    sessionRepository,
  });
  const policy = new TurnFailurePolicy({
    sessionStore: sessionStore as any,
    sessionLifecycle,
    retryScheduler: retryScheduler as any,
  });

  return { policy, sessionStore, retryScheduler, sessionRepository };
};

describe('TurnFailurePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules a retry for timeout errors in automated sessions', async () => {
    const session = buildSession();
    const { policy, sessionStore, retryScheduler } = buildPolicy(session);
    const err = new AppError(ERROR_CODES.LLM_TIMEOUT, 'Request timed out.', { retryAfterMs: 2500 });
    const turnStream = { raw: vi.fn() };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 3,
      turnStream,
      recorder: undefined,
      modelName: 'gpt-4',
      provider: 'openai',
      processMessage: vi.fn(),
    });

    expect(retryScheduler.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 2500,
        reason: `error_retry:${ERROR_CODES.LLM_TIMEOUT}`,
      }),
    );
    expect(turnStream.raw).toHaveBeenCalledWith(
      'warning',
      expect.objectContaining({ code: 'llm_retry' }),
    );
    expect(session.flags.error_retry?.retryCount).toBe(1);
    expect(session.flags.error_retry?.lastCode).toBe(ERROR_CODES.LLM_TIMEOUT);
    expect(session.flags.error_retry?.retryAfterMs).toBe(2500);
    expect(session.blockedReason).toBeUndefined();
    expect(sessionStore.setAsync).toHaveBeenCalledWith(session.id, session, 'process.error.retry');
  });

  it('schedules durable reconciliation for provider socket closes and records failover as deferred', async () => {
    const session = buildSession();
    const { policy, retryScheduler } = buildPolicy(session);
    const err = new AppError(ERROR_CODES.NETWORK_CONNECTION_FAILED, 'terminated: other side closed');
    const turnStream = { raw: vi.fn() };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 6,
      turnStream,
      recorder: recorder as any,
      modelName: 'deepseek-v4-pro',
      provider: 'deepseek',
      processMessage: vi.fn(),
    });

    expect(retryScheduler.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `error_retry:${ERROR_CODES.NETWORK_CONNECTION_FAILED}`,
      }),
    );
    expect(session.blockedReason).toBeUndefined();
    expect(session.flags.error_retry?.retryAfterMs).toBe(1000);
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      6,
      expect.objectContaining({
        event: 'turn.error.retry_scheduled',
        severity: 'warn',
        payload: expect.objectContaining({
          code: ERROR_CODES.NETWORK_CONNECTION_FAILED,
          modelName: 'deepseek-v4-pro',
          provider: 'deepseek',
          retryStrategy: 'durable_session_reconcile',
          providerFailover: expect.objectContaining({
            status: 'deferred',
          }),
        }),
      }),
    );
  });

  it('caps backoff without turning retry exhaustion into an absorbing session failure', async () => {
    const session = buildSession({
      flags: { error_retry: { retryCount: 5 } },
    });
    const { policy, retryScheduler, sessionRepository, sessionStore } = buildPolicy(session);
    const err = new AppError(ERROR_CODES.LLM_TIMEOUT, 'Request timed out.');
    const turnStream = { raw: vi.fn() };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 4,
      turnStream,
      recorder: undefined,
      modelName: 'gpt-4',
      provider: 'openai',
      processMessage: vi.fn(),
    });

    expect(retryScheduler.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 30_000 }),
    );
    expect(session.flags.error_retry?.retryCount).toBe(6);
    expect(session.blockedReason).toBeUndefined();
    expect(session.stateMachine.stopProcessing).not.toHaveBeenCalled();
    expect(sessionStore.setAsync).toHaveBeenCalledWith(session.id, session, 'process.error.retry');
    expect(sessionRepository.setBlockedReason).not.toHaveBeenCalled();
  });

  it('persists credit exhaustion as a waiting prerequisite and schedules a durable recheck', async () => {
    const session = buildSession({
      flags: { error_retry: { retryCount: 3 } },
    });
    const { policy, retryScheduler, sessionRepository } = buildPolicy(session);
    const err = new AppError(
      ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED,
      'Insufficient credits for model call preflight',
    );
    const turnStream = { raw: vi.fn() };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 3,
      turnStream,
      recorder: undefined,
      modelName: 'gpt-5.6-sol',
      provider: 'openai',
      processMessage: vi.fn(),
      executionClaimToken: 'claim-1',
    });

    expect(session.blockedReason).toBe('credits_exhausted');
    expect(session.flags).not.toHaveProperty('error_retry');
    expect(sessionRepository.setBlockedReason).toHaveBeenCalledWith(
      session.id,
      'credits_exhausted',
      expect.objectContaining({ recoverable: true }),
      'claim-1',
    );
    expect(retryScheduler.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 30_000,
        reason: 'credits_exhausted',
        executionClaimToken: 'claim-1',
      }),
    );
  });

  it('persists external subscription exhaustion as a recoverable prerequisite until provider reset', async () => {
    const session = buildSession({
      flags: { error_retry: { retryCount: 8, lastCode: ERROR_CODES.RESOURCE_LIMIT_REACHED } },
    });
    const { policy, retryScheduler, sessionRepository } = buildPolicy(session);
    const err = new AppError(
      ERROR_CODES.RESOURCE_LIMIT_REACHED,
      "Claude subscription quota is unavailable: You've hit your weekly limit",
      { retryAfterMs: 20 * 60_000, context: { backend: 'claude-agent-sdk' } },
    );
    const turnStream = { raw: vi.fn() };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 4,
      turnStream,
      recorder: undefined,
      modelName: 'claude-opus-4-8',
      provider: 'claude-agent-sdk',
      processMessage: vi.fn(),
      executionClaimToken: 'claim-2',
    });

    expect(session.blockedReason).toBe('provider_quota_exhausted');
    expect(session.flags?.error_retry).toMatchObject({
      retryCount: 9,
      lastCode: ERROR_CODES.RESOURCE_LIMIT_REACHED,
      retryAfterMs: 20 * 60_000,
    });
    expect(sessionRepository.setBlockedReason).toHaveBeenCalledWith(
      session.id,
      'provider_quota_exhausted',
      expect.objectContaining({
        recoverable: true,
        retryAfterMs: 20 * 60_000,
        errorCode: ERROR_CODES.RESOURCE_LIMIT_REACHED,
      }),
      'claim-2',
    );
    expect(retryScheduler.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 20 * 60_000,
        reason: 'provider_quota_exhausted',
        executionClaimToken: 'claim-2',
      }),
    );
    expect(turnStream.raw).toHaveBeenCalledWith(
      'warning',
      expect.objectContaining({ code: 'provider_quota_exhausted', retryable: true }),
    );
  });

  it('backs off unknown provider subscription resets without creating a second retry system', async () => {
    const session = buildSession({
      flags: { error_retry: { retryCount: 2, lastCode: ERROR_CODES.RESOURCE_LIMIT_REACHED } },
    });
    const { policy, retryScheduler } = buildPolicy(session);

    await policy.handleError({
      sessionId: session.id,
      error: new AppError(
        ERROR_CODES.RESOURCE_LIMIT_REACHED,
        'Claude subscription quota is unavailable',
        { context: { backend: 'claude-agent-sdk' } },
      ),
      sessionState: session,
      turnNumber: 5,
      turnStream: { raw: vi.fn() },
      recorder: undefined,
      modelName: 'claude-opus-4-8',
      provider: 'claude-agent-sdk',
      processMessage: vi.fn(),
    });

    expect(session.flags?.error_retry).toMatchObject({
      retryCount: 3,
      retryAfterMs: 20 * 60_000,
    });
    expect(retryScheduler.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 20 * 60_000,
        reason: 'provider_quota_exhausted',
      }),
    );
  });

  it('keeps an automated tool infrastructure interruption recoverable', async () => {
    const session = buildSession();
    const { policy, retryScheduler, sessionRepository, sessionStore } = buildPolicy(session);
    const err = ErrorFactory.tool.sandboxError('shell_run', 'docker unavailable');
    const turnStream = { raw: vi.fn() };
    const recorder = { write: vi.fn().mockResolvedValue(undefined) };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 2,
      turnStream,
      recorder: recorder as any,
      modelName: 'gpt-4',
      provider: 'openai',
      processMessage: vi.fn(),
    });

    expect(retryScheduler.scheduleRetry).toHaveBeenCalled();
    expect(session.blockedReason).toBeUndefined();
    expect(sessionStore.setAsync).toHaveBeenCalledWith(session.id, session, 'process.error.retry');
    expect(sessionRepository.setBlockedReason).not.toHaveBeenCalled();
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      2,
      expect.objectContaining({
        event: 'turn.error.retry_scheduled',
        severity: 'warn',
        payload: expect.objectContaining({
          code: ERROR_CODES.TOOL_SANDBOX_ERROR,
        }),
      }),
    );
  });

  it('blocks a deterministic automated content refusal for user action instead of replaying it forever', async () => {
    const session = buildSession();
    const { policy, retryScheduler, sessionRepository } = buildPolicy(session);
    const err = new AppError(
      ERROR_CODES.LLM_CONTENT_FILTER_TRIGGERED,
      'InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.',
    );
    const turnStream = { raw: vi.fn() };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 5,
      turnStream,
      recorder: undefined,
      modelName: 'qwen3.5-plus',
      provider: 'qwen',
      processMessage: vi.fn(),
    });

    expect(retryScheduler.scheduleRetry).not.toHaveBeenCalled();
    expect(session.blockedReason).toBe('awaiting_user');
    expect(sessionRepository.setBlockedReason).toHaveBeenCalledWith(
      session.id,
      'awaiting_user',
      expect.objectContaining({ recoverable: false, code: 'content_filter' }),
    );
  });

  it('rechecks automated non-llm prerequisites instead of terminally blocking history', async () => {
    const session = buildSession();
    const { policy, retryScheduler, sessionRepository } = buildPolicy(session);
    const err = ErrorFactory.resource.quotaExceeded('requests', 10);
    const turnStream = { raw: vi.fn() };

    await policy.handleError({
      sessionId: session.id,
      error: err,
      sessionState: session,
      turnNumber: 2,
      turnStream,
      recorder: undefined,
      modelName: 'gpt-4',
      provider: 'openai',
      processMessage: vi.fn(),
    });

    expect(retryScheduler.scheduleRetry).toHaveBeenCalled();
    expect(session.blockedReason).toBeUndefined();
    expect(sessionRepository.setBlockedReason).not.toHaveBeenCalled();
  });
});


