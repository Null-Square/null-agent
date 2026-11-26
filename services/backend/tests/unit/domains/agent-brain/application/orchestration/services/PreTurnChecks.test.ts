import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PreTurnChecks } from '@/domains/agent-brain/application/orchestration/services/PreTurnChecks';
import { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';

// Silence logger
vi.mock('@/shared/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const createTokenGuard = (overrides?: { exceeded: boolean; warning: boolean; message?: string }) => {
  const guard = new TokenGuard();
  vi.spyOn(guard, 'checkLimits').mockReturnValue({
    exceeded: overrides?.exceeded ?? false,
    warning: overrides?.warning ?? false,
    limitType: 'session',
    currentUsage: 0,
    limit: 100,
    usagePct: 0,
    message: overrides?.message,
  });
  return guard;
};

const baseSession = {
  id: 's1',
  userId: 'u1',
  plan: [],
  messages: [],
  flags: { securityops: { organizationId: 'org-1' } },
  status: 'running',
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 1,
  pendingApproval: undefined,
  checkpoints: {},
  planVersionHash: undefined,
  mode: 'interactive',
};

describe('PreTurnChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proceeds with no credit check or balance lookup: Null AI charges nothing', async () => {
    const checks = new PreTurnChecks({ tokenGuard: createTokenGuard() });
    const result = await checks.execute({
      sessionId: 's1',
      session: baseSession as any,
      turnNumber: 1,
    });
    expect(result.proceed).toBe(true);
    expect(result.warnings.some((w) => w.code.startsWith('credits'))).toBe(false);
  });

  it('halts when token limits exceeded', async () => {
    const tokenGuard = createTokenGuard({ exceeded: true, warning: false, message: 'limit exceeded' });
    const checks = new PreTurnChecks({ tokenGuard });

    const result = await checks.execute({
      sessionId: 's1',
      session: baseSession as any,
      turnNumber: 1,
    });

    expect(result.proceed).toBe(false);
    expect(result.haltReason).toBe('token_limit_exceeded');
    expect(result.haltEventData?.limit).toBe(100);
  });

  it('halts before token checks when work continuation is blocked', async () => {
    const tokenGuard = createTokenGuard();
    const checks = new PreTurnChecks({
      tokenGuard,
      workContinuationGuard: {
        canContinue: vi.fn().mockResolvedValue({
          ok: false,
          reason: 'aborted_by_user',
          boundary: 'pre_turn',
          source: 'durable_blocked_reason',
        }),
      } as any,
    });

    const result = await checks.execute({
      sessionId: 's1',
      session: baseSession as any,
      turnNumber: 1,
    });

    expect(result.proceed).toBe(false);
    expect(result.haltReason).toBe('work_blocked');
    expect(result.haltEventData).toMatchObject({
      reason: 'aborted_by_user',
      source: 'durable_blocked_reason',
    });
  });

  describe('scope target ownership', () => {
    const scopedSession = {
      ...baseSession,
      scopeId: 'scope-1',
      flags: { securityops: { organizationId: 'org-1', scopeId: 'scope-1' } },
    };

    // Regression guard for the authorization-model dispatch.
    //
    // Research Lab broke silently for five days because a security change to
    // this gate landed with no test covering a non-SecurityOps consumer. These
    // cases pin both sides of the dispatch so the next change to either has to
    // break a test rather than a lab.
    describe('authorization model dispatch', () => {
      const PINNED = '0a772789f158f6bf8dfaf51d47ba35ac48314490';

      const sourceReviewSession = (repository: Record<string, unknown> | undefined) => ({
        ...baseSession,
        scopeId: 'research-lab-project-id-not-a-uuid',
        flags: {
          securityops: {
            organizationId: 'research-lab',
            scopeId: 'research-lab-project-id-not-a-uuid',
            authorizationModel: 'pinned_source_review',
            ...(repository ? { repository } : {}),
          },
        },
      });

      it('never consults the ownership port for a pinned source review', async () => {
        const checkScope = vi.fn();
        const checks = new PreTurnChecks({
          scopeVerificationPort: { checkScope },
          tokenGuard: createTokenGuard(),
        });

        const result = await checks.execute({
          sessionId: 's1',
          session: sourceReviewSession({ visibility: 'public', commit: PINNED }) as any,
          turnNumber: 1,
        });

        expect(result.proceed).toBe(true);
        // The scope id is a Research Lab project id, not a scopes.id — sending it
        // to the port is what made the query throw and fail closed.
        expect(checkScope).not.toHaveBeenCalled();
      });

      it('blocks a source review that cannot evidence public visibility', async () => {
        const checks = new PreTurnChecks({
          scopeVerificationPort: { checkScope: vi.fn() },
          tokenGuard: createTokenGuard(),
        });

        const result = await checks.execute({
          sessionId: 's1',
          session: sourceReviewSession({ visibility: 'private', commit: PINNED }) as any,
          turnNumber: 1,
        });

        expect(result.proceed).toBe(false);
        expect(result.haltReason).toBe('source_review_unauthorized');
        expect(result.haltEventData).toMatchObject({
          reason: 'not_public',
          code: 'run.source_review_unauthorized',
        });
      });

      it('blocks a source review whose repository is missing entirely', async () => {
        const checks = new PreTurnChecks({
          scopeVerificationPort: { checkScope: vi.fn() },
          tokenGuard: createTokenGuard(),
        });

        const result = await checks.execute({
          sessionId: 's1',
          session: sourceReviewSession(undefined) as any,
          turnNumber: 1,
        });

        expect(result.proceed).toBe(false);
        expect(result.haltReason).toBe('source_review_unauthorized');
        expect(result.haltEventData).toMatchObject({ reason: 'no_repository' });
      });

      it('keeps every other consumer on target ownership', async () => {
        // Evaluation Lab and the SecurityOps product declare no model, so they
        // must still resolve through the port exactly as before.
        const checkScope = vi.fn().mockResolvedValue({ verified: true });
        const checks = new PreTurnChecks({
          scopeVerificationPort: { checkScope },
          tokenGuard: createTokenGuard(),
        });

        const result = await checks.execute({
          sessionId: 's1',
          session: scopedSession as any,
          turnNumber: 1,
        });

        expect(result.proceed).toBe(true);
        expect(checkScope).toHaveBeenCalledWith('scope-1');
      });

      it('treats an unrecognised model as target ownership', async () => {
        const checkScope = vi.fn().mockResolvedValue({ verified: true });
        const checks = new PreTurnChecks({
          scopeVerificationPort: { checkScope },
          tokenGuard: createTokenGuard(),
        });

        await checks.execute({
          sessionId: 's1',
          session: {
            ...baseSession,
            scopeId: 'scope-1',
            flags: {
              securityops: {
                scopeId: 'scope-1',
                // A typo must not become an authorization bypass.
                authorizationModel: 'pinned-source-review',
              },
            },
          } as any,
          turnNumber: 1,
        });

        expect(checkScope).toHaveBeenCalledWith('scope-1');
      });
    });

    it('halts a scope-bound turn before any model call when ownership is unverified', async () => {
      const checkScope = vi.fn().mockResolvedValue({
        verified: false,
        reason: 'unverified',
        message: 'Verify target ownership for this scope before using the assistant.',
      });
      const checks = new PreTurnChecks({
        scopeVerificationPort: { checkScope },
        tokenGuard: createTokenGuard(),
      });

      const result = await checks.execute({
        sessionId: 's1',
        session: scopedSession as any,
        turnNumber: 1,
      });

      expect(result.proceed).toBe(false);
      expect(result.haltReason).toBe('scope_unverified');
      expect(result.haltEventData).toMatchObject({
        scopeId: 'scope-1',
        reason: 'unverified',
        code: 'scope.target_unverified',
      });
      expect(checkScope).toHaveBeenCalledWith('scope-1');
    });

    it('fails closed when the ownership lookup rejects', async () => {
      const checks = new PreTurnChecks({
        scopeVerificationPort: { checkScope: vi.fn().mockRejectedValue(new Error('db down')) },
        tokenGuard: createTokenGuard(),
      });

      const result = await checks.execute({
        sessionId: 's1',
        session: scopedSession as any,
        turnNumber: 1,
      });

      expect(result.proceed).toBe(false);
      expect(result.haltReason).toBe('scope_unverified');
      expect(result.haltEventData).toMatchObject({ reason: 'lookup_failed' });
    });

    it('reads the scope id from securityops flags when the session field is unset', async () => {
      const checkScope = vi.fn().mockResolvedValue({ verified: true });
      const checks = new PreTurnChecks({
        scopeVerificationPort: { checkScope },
        tokenGuard: createTokenGuard(),
      });

      const result = await checks.execute({
        sessionId: 's1',
        session: { ...baseSession, flags: { securityops: { organizationId: 'org-1', scopeId: 'scope-2' } } } as any,
        turnNumber: 1,
      });

      expect(checkScope).toHaveBeenCalledWith('scope-2');
      expect(result.proceed).toBe(true);
    });

    it('proceeds when ownership is verified', async () => {
      const checks = new PreTurnChecks({
        scopeVerificationPort: { checkScope: vi.fn().mockResolvedValue({ verified: true }) },
        tokenGuard: createTokenGuard(),
      });

      const result = await checks.execute({
        sessionId: 's1',
        session: scopedSession as any,
        turnNumber: 1,
      });

      expect(result.proceed).toBe(true);
    });

    it('leaves sessions without a scope untouched', async () => {
      const checkScope = vi.fn();
      const checks = new PreTurnChecks({
        scopeVerificationPort: { checkScope },
        tokenGuard: createTokenGuard(),
      });

      const result = await checks.execute({
        sessionId: 's1',
        session: baseSession as any,
        turnNumber: 1,
      });

      expect(checkScope).not.toHaveBeenCalled();
      expect(result.proceed).toBe(true);
    });
  });

  it('adds sandbox warning when sandbox health fails', async () => {
    const sandboxHealthChecker = {
      check: vi.fn<() => any>().mockResolvedValue({
        healthy: false,
        errors: ['disk full'],
        containerRunning: true,
        diskSpaceOk: false,
      }),
      waitForHealthy: vi.fn<() => Promise<{ healthy: boolean; attempts: number }>>().mockResolvedValue({ healthy: true, attempts: 1 }),
      checkDiskSpace: vi.fn<() => Promise<{ ok: boolean; reason?: string; freeMb?: number }>>().mockResolvedValue({ ok: true }),
      sleep: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      deps: {
        execInContainer: vi.fn<() => Promise<{ stdout: string; exitCode: number }>>().mockResolvedValue({ stdout: '', exitCode: 0 }),
        inspectContainer: vi.fn<() => Promise<{ running: boolean; startedAt?: string } | null>>().mockResolvedValue({ running: true }),
      },
    };
    const tokenGuard = createTokenGuard();
    const checks = new PreTurnChecks({
      sandboxHealthChecker: sandboxHealthChecker as any,
      tokenGuard,
    });

    const result = await checks.execute({
      sessionId: 's1',
      session: { ...baseSession, containerId: 'c1' } as any,
      turnNumber: 1,
    });

    expect(result.proceed).toBe(true);
    expect(result.warnings.some((w) => w.code === 'sandbox_unhealthy')).toBe(true);
  });
});







