import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
import { PreTurnChecks } from '@/domains/agent-brain/application/orchestration/services/PreTurnChecks';
import { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';
import type { SessionState, SessionStatus } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const makeSession = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: 's-pre',
  status: 'running' as SessionStatus,
  userId: 'u1',
  workspaceDir: '/tmp',
  plan: [],
  messages: [],
  memory: createEmptyMemory(),
  flags: { securityops: { organizationId: 'org-pre' } },
  pendingApproval: undefined,
  checkpoints: {},
  lastActive: Date.now(),
  createdAt: Date.now(),
  turn: 1,
  ...overrides,
});

describe('PreTurnChecks contract (token/sandbox gating)', () => {
  let tokenGuard: TokenGuard;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenGuard = new TokenGuard({
      perSessionLimit: 1_000,
      perUserDailyLimit: 10_000,
      warningThresholdPct: 80,
    });
  });

  it('lets a turn proceed with no credit lookup: Null AI charges nothing', async () => {
    const checks = new PreTurnChecks({ tokenGuard });
    const session = makeSession();
    const recorder = { write: vi.fn() };

    const result = await checks.execute({
      sessionId: session.id,
      session,
      turnNumber: 1,
      recorder: recorder as any,
    });

    expect(result.proceed).toBe(true);
    expect(recorder.write).not.toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({ event: 'session.credits_exhausted' }),
    );
  });

  it('halts when token limit exceeded before turn starts and includes limit metadata', async () => {
    const localTokenGuard = new TokenGuard({
      perSessionLimit: 100_000,
      perUserDailyLimit: 500_000,
      warningThresholdPct: 80,
    });
    localTokenGuard.recordUsage({ sessionId: 's-pre', userId: 'u1', tokens: 101_000 });

    const checks = new PreTurnChecks({ tokenGuard: localTokenGuard });
    const session = makeSession();
    const recorder = { write: vi.fn() };

    const result = await checks.execute({
      sessionId: session.id,
      session,
      turnNumber: 1,
      recorder: recorder as any,
    });

    expect(result.proceed).toBe(false);
    expect(result.haltReason).toBe('token_limit_exceeded');
    expect(result.haltEventData).toEqual(expect.objectContaining({ limitType: 'session', limit: 100_000 }));
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({ event: 'session.session_token_limit_exceeded' }),
    );
  });

  it('returns warning (not halt) when sandbox health reports container not running', async () => {
    const sandboxHealthChecker = {
      check: vi.fn().mockResolvedValue({
        healthy: false,
        errors: ['Container is not running'],
        containerRunning: false,
        diskSpaceOk: true,
      }),
    };
    const checks = new PreTurnChecks({
      sandboxHealthChecker: sandboxHealthChecker as any,
      tokenGuard,
    });
    const session = makeSession({ containerId: 'c1' });
    const recorder = { write: vi.fn() };

    const result = await checks.execute({
      sessionId: session.id,
      session,
      turnNumber: 1,
      recorder: recorder as any,
    });

    expect(result.proceed).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'sandbox_unhealthy' })]));
    expect(recorder.write).toHaveBeenCalledWith(
      session.id,
      1,
      expect.objectContaining({ event: 'sandbox.health_check_failed' }),
    );
  });

  it('emits token warning when approaching session limit but allows turn to proceed', async () => {
    const localTokenGuard = new TokenGuard({
      perSessionLimit: 1_000,
      warningThresholdPct: 80,
    });
    localTokenGuard.recordUsage({ sessionId: 's-pre', userId: 'u1', tokens: 850 });

    const checks = new PreTurnChecks({ tokenGuard: localTokenGuard });
    const session = makeSession();

    const result = await checks.execute({
      sessionId: session.id,
      session,
      turnNumber: 1,
    });

    expect(result.proceed).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'tokens_high',
          data: expect.objectContaining({ usagePct: 85, limitType: 'session' }),
        }),
      ]),
    );
  });
});






