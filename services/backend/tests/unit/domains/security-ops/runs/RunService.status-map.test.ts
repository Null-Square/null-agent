import { describe, expect, it } from 'vitest';
import {
  buildScopeRunContext,
  buildRunUsageSummary,
  buildRunIdempotencyKey,
  collectTerminalPhaseSessionIds,
  decodeFindingLifecycleRunNote,
  deriveRunDisplayState,
  encodeFindingLifecycleRunNote,
  evaluateRunPrerequisites,
  mapSessionSnapshotToRunStatus,
  resolveRunUsageSessionRefs,
} from '@/domains/security-ops/runs/RunService';

describe('collectTerminalPhaseSessionIds (single source of truth: active phase owns run status)', () => {
  it('excludes sessions of terminalized phases so a stale earlier-phase pause cannot wedge the run', () => {
    // The exact gov.jo/Arab Bank shape: recon completed (its session left at system_paused),
    // enumeration completed, reporting pending (no session yet).
    const ids = collectTerminalPhaseSessionIds([
      { status: 'completed', sessionId: 'recon-session-paused' },
      { status: 'completed', sessionId: 'enumeration-session' },
      { status: 'pending', sessionId: null },
    ]);
    expect(ids.has('recon-session-paused')).toBe(true);
    expect(ids.has('enumeration-session')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('keeps active/pending/blocked phase sessions (they legitimately drive run state)', () => {
    const ids = collectTerminalPhaseSessionIds([
      { status: 'active', sessionId: 'active-phase-session' },
      { status: 'blocked', sessionId: 'blocked-phase-session' },
      { status: 'pending', sessionId: 'pending-phase-session' },
      { status: 'handoff_submitted', sessionId: 'handed-off-session' },
      { status: 'failed', sessionId: 'failed-session' },
    ]);
    expect(ids.has('active-phase-session')).toBe(false);
    expect(ids.has('blocked-phase-session')).toBe(false);
    expect(ids.has('pending-phase-session')).toBe(false);
    // handoff_submitted/failed phases are finished -> excluded.
    expect(ids.has('handed-off-session')).toBe(true);
    expect(ids.has('failed-session')).toBe(true);
  });
});

describe('mapSessionSnapshotToRunStatus', () => {
  it('marks completed sessions as completed', () => {
    const status = mapSessionSnapshotToRunStatus(
      { completed: true, blockedReason: null, isProcessing: false, lastActivityAt: new Date() },
      'running',
      new Date(),
    );
    expect(status).toBe('completed');
  });

  it('does not manufacture run cancellation from session stop metadata', () => {
    const status = mapSessionSnapshotToRunStatus(
      { completed: false, blockedReason: 'aborted_by_user', isProcessing: false, lastActivityAt: new Date() },
      'running',
      new Date(),
    );
    expect(status).toBeNull();
  });

  it('treats terminalized phase sessions as inert for run status', () => {
    const status = mapSessionSnapshotToRunStatus(
      { completed: false, blockedReason: 'phase_terminalized', isProcessing: false, lastActivityAt: new Date() },
      'running',
      new Date(),
    );
    expect(status).toBeNull();
  });

  it('keeps retry blocked states running and maps intentional pauses', () => {
    expect(
      mapSessionSnapshotToRunStatus(
        { completed: false, blockedReason: 'guard_retry:no_progress', isProcessing: false, lastActivityAt: new Date() },
        'running',
        new Date(),
      ),
    ).toBe('running');

    expect(
      mapSessionSnapshotToRunStatus(
        { completed: false, blockedReason: 'credits_exhausted', isProcessing: false, lastActivityAt: new Date() },
        'running',
        new Date(),
      ),
    ).toBe('credits_exhausted');

    expect(
      mapSessionSnapshotToRunStatus(
        { completed: false, blockedReason: 'system_paused', isProcessing: false, lastActivityAt: new Date() },
        'running',
        new Date(),
      ),
    ).toBe('system_paused');
  });

  it('keeps unknown blocked reasons non-terminal', () => {
    const status = mapSessionSnapshotToRunStatus(
      { completed: false, blockedReason: 'sandbox_unhealthy', isProcessing: false, lastActivityAt: new Date() },
      'running',
      new Date(),
    );
    expect(status).toBeNull();
  });

  it('maps pending approvals to awaiting_approval', () => {
    const status = mapSessionSnapshotToRunStatus(
      {
        completed: false,
        blockedReason: null,
        hasPendingApproval: true,
        isProcessing: false,
        lastActivityAt: new Date(),
      },
      'running',
      new Date(),
    );
    expect(status).toBe('awaiting_approval');
  });

  it('marks active processing sessions as running', () => {
    const status = mapSessionSnapshotToRunStatus(
      { completed: false, blockedReason: null, isProcessing: true, lastActivityAt: new Date() },
      'queued',
      null,
    );
    expect(status).toBe('running');
  });

  it('does not let stale manual or system pause markers mask active processing', () => {
    expect(
      mapSessionSnapshotToRunStatus(
        { completed: false, blockedReason: 'user_paused', isProcessing: true, lastActivityAt: new Date() },
        'user_paused',
        new Date(),
      ),
    ).toBe('running');

    expect(
      mapSessionSnapshotToRunStatus(
        { completed: false, blockedReason: 'system_paused', isProcessing: true, lastActivityAt: new Date() },
        'system_paused',
        new Date(),
      ),
    ).toBe('running');
  });

  it('does not infer business failure from inactivity', () => {
    const now = Date.now();
    const staleActivityAt = new Date(now - 61 * 60_000);
    const freshActivityAt = new Date(now - 30 * 60_000);

    expect(
      mapSessionSnapshotToRunStatus(
        { completed: false, blockedReason: null, isProcessing: false, lastActivityAt: staleActivityAt },
        'running',
        new Date(now - 61 * 60_000),
        now,
      ),
    ).toBeNull();

    expect(
      mapSessionSnapshotToRunStatus(
        { completed: false, blockedReason: null, isProcessing: false, lastActivityAt: freshActivityAt },
        'running',
        new Date(now - 30 * 60_000),
        now,
      ),
    ).toBeNull();
  });
});

describe('deriveRunDisplayState', () => {
  it('maps recoverable runtime statuses to paused/system for the UI', () => {
    expect(
      deriveRunDisplayState({
        goal: 'Assess API auth flow',
        status: 'system_paused',
      }),
    ).toMatchObject({
      status: 'paused',
      pauseReason: 'system',
      interactionType: 'none',
    });
  });
});

describe('buildRunIdempotencyKey', () => {
  it('is stable within the same timestamp bucket', () => {
    const now = new Date('2026-02-18T10:15:30.000Z');
    const keyA = buildRunIdempotencyKey({
      scopeId: 'scope-123',
      goal: 'Assess discovered assets for vulnerabilities',
      now,
      bucketMs: 60_000,
    });
    const keyB = buildRunIdempotencyKey({
      scopeId: 'scope-123',
      goal: 'Assess discovered assets for vulnerabilities',
      now: new Date('2026-02-18T10:15:59.000Z'),
      bucketMs: 60_000,
    });

    expect(keyA).toBe(keyB);
  });

  it('changes across timestamp buckets', () => {
    const keyA = buildRunIdempotencyKey({
      scopeId: 'scope-123',
      goal: 'Assess discovered assets for vulnerabilities',
      now: new Date('2026-02-18T10:15:59.000Z'),
      bucketMs: 60_000,
    });
    const keyB = buildRunIdempotencyKey({
      scopeId: 'scope-123',
      goal: 'Assess discovered assets for vulnerabilities',
      now: new Date('2026-02-18T10:16:00.000Z'),
      bucketMs: 60_000,
    });

    expect(keyA).not.toBe(keyB);
  });

  it('supports a stable identity for event deliveries that must deduplicate across time', () => {
    const common = {
      scopeId: 'scope-123',
      goal: 'pull-request-review:repository:42:head-sha',
      workflowDiscipline: 'code_review' as const,
      workflowIdentity: 'pull_request_review:repository:head-sha',
      stable: true,
    };
    const keyA = buildRunIdempotencyKey({
      ...common,
      now: new Date('2026-02-18T10:15:59.000Z'),
    });
    const keyB = buildRunIdempotencyKey({
      ...common,
      now: new Date('2026-03-18T10:15:59.000Z'),
    });

    expect(keyA).toBe(keyB);
  });

  it('changes when the selected model changes within the same bucket', () => {
    const now = new Date('2026-02-18T10:15:30.000Z');
    const keyA = buildRunIdempotencyKey({
      scopeId: 'scope-123',
      goal: 'Assess discovered assets for vulnerabilities',
      modelId: '11111111-1111-1111-1111-111111111111',
      now,
      bucketMs: 60_000,
    });
    const keyB = buildRunIdempotencyKey({
      scopeId: 'scope-123',
      goal: 'Assess discovered assets for vulnerabilities',
      modelId: '22222222-2222-2222-2222-222222222222',
      now,
      bucketMs: 60_000,
    });

    expect(keyA).not.toBe(keyB);
  });
});

describe('run usage aggregation', () => {
  it('resolves planner and executor session refs without double counting the current session', () => {
    expect(
      resolveRunUsageSessionRefs({
        sessionId: 'executor-session',
        plannerSessionId: 'planner-session',
        executorSessionId: 'executor-session',
      } as never),
    ).toEqual({
      plannerSessionId: 'planner-session',
      executorSessionId: 'executor-session',
      sessionIds: ['planner-session', 'executor-session'],
    });
  });

  it('falls back to the current session for pre-approval planner runs', () => {
    expect(
      resolveRunUsageSessionRefs({
        sessionId: 'planner-session',
        plannerSessionId: null,
        executorSessionId: null,
      } as never),
    ).toEqual({
      plannerSessionId: 'planner-session',
      executorSessionId: null,
      sessionIds: ['planner-session'],
    });
  });

  it('builds a merged usage summary across planner and executor sessions', () => {
    const usageSummary = buildRunUsageSummary(
      {
        sessionId: 'executor-session',
        plannerSessionId: 'planner-session',
        executorSessionId: 'executor-session',
      } as never,
      new Map([
        [
          'planner-session',
          {
            promptTokens: 100,
            cachedPromptTokens: 5,
            completionTokens: 50,
            totalTokens: 150,
            nativeCost: 0.2,
            overhead: 0.01,
            platformCost: 0.21,
            platformPrice: 0.25,
            creditEquivalent: 2.5,
            credits: 2.5,
            entries: 1,
          },
        ],
        [
          'executor-session',
          {
            promptTokens: 250,
            cachedPromptTokens: 10,
            completionTokens: 120,
            totalTokens: 370,
            nativeCost: 0.4,
            overhead: 0.02,
            platformCost: 0.42,
            platformPrice: 0.5,
            creditEquivalent: 5.75,
            credits: 5.75,
            entries: 2,
          },
        ],
      ]),
    );

    expect(usageSummary.planner?.credits).toBe(2.5);
    expect(usageSummary.executor?.credits).toBe(5.75);
    expect(usageSummary.total.promptTokens).toBe(350);
    expect(usageSummary.total.cachedPromptTokens).toBe(15);
    expect(usageSummary.total.completionTokens).toBe(170);
    expect(usageSummary.total.totalTokens).toBe(520);
    expect(usageSummary.total.nativeCost).toBeCloseTo(0.6, 8);
    expect(usageSummary.total.overhead).toBeCloseTo(0.03, 8);
    expect(usageSummary.total.platformCost).toBeCloseTo(0.63, 8);
    expect(usageSummary.total.platformPrice).toBeCloseTo(0.75, 8);
    expect(usageSummary.total.creditEquivalent).toBe(8.25);
    expect(usageSummary.total.credits).toBe(8.25);
    expect(usageSummary.total.entries).toBe(3);
  });

  it('includes related worker session ids in total usage without changing planner/executor refs', () => {
    const usageSummary = buildRunUsageSummary(
      {
        sessionId: 'executor-session',
        plannerSessionId: 'planner-session',
        executorSessionId: 'executor-session',
      } as never,
      new Map([
        [
          'planner-session',
          {
            promptTokens: 100,
            cachedPromptTokens: 5,
            completionTokens: 50,
            totalTokens: 150,
            nativeCost: 0.2,
            overhead: 0.01,
            platformCost: 0.21,
            platformPrice: 0.25,
            creditEquivalent: 2.5,
            credits: 2.5,
            entries: 1,
          },
        ],
        [
          'executor-session',
          {
            promptTokens: 250,
            cachedPromptTokens: 10,
            completionTokens: 120,
            totalTokens: 370,
            nativeCost: 0.4,
            overhead: 0.02,
            platformCost: 0.42,
            platformPrice: 0.5,
            creditEquivalent: 5.75,
            credits: 5.75,
            entries: 2,
          },
        ],
        [
          'worker-session',
          {
            promptTokens: 30,
            cachedPromptTokens: 0,
            completionTokens: 20,
            totalTokens: 50,
            nativeCost: 0.05,
            overhead: 0.005,
            platformCost: 0.055,
            platformPrice: 0.07,
            creditEquivalent: 0.8,
            credits: 0.8,
            entries: 1,
          },
        ],
      ]),
      ['worker-session'],
    );

    expect(usageSummary.planner?.sessionId).toBe('planner-session');
    expect(usageSummary.executor?.sessionId).toBe('executor-session');
    expect(usageSummary.total.totalTokens).toBe(570);
    expect(usageSummary.total.credits).toBe(9.05);
    expect(usageSummary.total.entries).toBe(4);
  });
});

describe('finding lifecycle note codec', () => {
  it('round-trips finding lifecycle run notes', () => {
    const note = encodeFindingLifecycleRunNote({ findingId: '123e4567-e89b-12d3-a456-426614174000' });
    expect(decodeFindingLifecycleRunNote(note)).toEqual({
      findingId: '123e4567-e89b-12d3-a456-426614174000',
    });
  });

  it('accepts legacy plain finding IDs and rejects malformed notes', () => {
    expect(decodeFindingLifecycleRunNote('123e4567-e89b-12d3-a456-426614174001')).toEqual({
      findingId: '123e4567-e89b-12d3-a456-426614174001',
    });
    expect(decodeFindingLifecycleRunNote('not-a-uuid')).toBeNull();
    expect(decodeFindingLifecycleRunNote('{"findingId":42}')).toBeNull();
  });
});

describe('evaluateRunPrerequisites', () => {
  it('hard-blocks discovery when scope has no verified targets', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Run external attack surface discovery',
      totalTargetsCount: 1,
      verifiedTargetsCount: 0,
      assetsCount: 0,
    });

    expect(result.blockMessage).toContain('verified');
    expect(result.warnings).toHaveLength(0);
  });

  it('hard-blocks all runs when the scope has no target configured', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Assess discovered assets for vulnerabilities',
      totalTargetsCount: 0,
      verifiedTargetsCount: 0,
      assetsCount: 0,
    });

    expect(result.blockMessage).toContain('Set the scope target');
    expect(result.warnings).toHaveLength(0);
  });

  it('allows discovery when at least one target is verified', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Run external attack surface discovery',
      totalTargetsCount: 1,
      verifiedTargetsCount: 1,
      assetsCount: 0,
    });

    expect(result.blockMessage).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it('hard-blocks runs when a legacy scope contains unrelated domain boundaries', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Run external attack surface discovery',
      totalTargetsCount: 2,
      verifiedTargetsCount: 2,
      assetsCount: 0,
      scopeTargets: [
        { type: 'domain', value: 'example.com' },
        { type: 'domain', value: 'other-company.com' },
      ],
    });

    expect(result.blockMessage).toContain('one domain boundary');
    expect(result.blockMessage).toContain('other-company.com');
    expect(result.warnings).toHaveLength(0);
  });

  it('blocks cloud runs against private or reserved targets', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Run internal network discovery',
      totalTargetsCount: 1,
      verifiedTargetsCount: 1,
      assetsCount: 0,
      executionTarget: 'cloud',
      cloudBlockedTargetValues: ['192.168.1.0/24'],
    });

    expect(result.blockMessage).toContain('private runner');
    expect(result.warnings).toHaveLength(0);
  });

  it('allows private-runner runs against private targets', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Run internal network discovery',
      totalTargetsCount: 1,
      verifiedTargetsCount: 1,
      assetsCount: 0,
      executionTarget: 'scope_runner',
      cloudBlockedTargetValues: ['192.168.1.0/24'],
    });

    expect(result.blockMessage).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it('does not block report-only cloud runs for private targets', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Generate report',
      totalTargetsCount: 1,
      verifiedTargetsCount: 1,
      assetsCount: 0,
      executionTarget: 'cloud',
      cloudBlockedTargetValues: ['192.168.1.0/24'],
      networkActivityRequired: false,
    });

    expect(result.blockMessage).toBeUndefined();
  });

  it('returns soft warning for vulnerability scan with zero assets', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Assess discovered assets for vulnerabilities',
      totalTargetsCount: 1,
      verifiedTargetsCount: 1,
      assetsCount: 0,
    });

    expect(result.blockMessage).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('scope_assets_missing');
  });

  it('does not warn vulnerability scan when assets exist', () => {
    const result = evaluateRunPrerequisites({
      goal: 'Assess discovered assets for vulnerabilities',
      totalTargetsCount: 1,
      verifiedTargetsCount: 1,
      assetsCount: 2,
    });

    expect(result.blockMessage).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });
});

describe('buildScopeRunContext private-runner preflight', () => {
  const baseScope = {
    name: 'Internal',
    executionNetwork: 'internal',
    attachedRunner: {
      id: 'runner-1',
      name: 'Home Runner',
      status: 'online',
      type: 'private',
      metadata: {
        runnerNetworkAddresses: 'eth0:172.17.0.2/16,wlan0:192.168.1.20/24',
      },
    },
    mission: null,
    stealthPosture: 'coordinated',
    impactTolerance: 'non_destructive',
    rateLimitRps: null,
    blastWindow: null,
    roeDocument: null,
    complianceFrameworks: [],
    testingPosture: 'gray-box',
    testingPostureReason: 'test',
    whiteboxEnabled: false,
    connectedRepoCount: 0,
    connectedRepositories: [],
    accessMaterialCount: 0,
    accessMaterials: [],
  };

  it('warns private-runner sessions when no private CIDR is authorized', () => {
    const context = buildScopeRunContext({
      ...baseScope,
      targets: [{ type: 'domain', value: 'example.com', verified: true }],
    } as never, 'scope_runner');

    expect(context).toContain('PRIVATE RUNNER NETWORK PREFLIGHT');
    expect(context).toContain('No verified private CIDR targets are authorized');
    expect(context).toContain('eth0:172.17.0.2/16');
  });

  it('shows authorized private CIDRs and runner interfaces', () => {
    const context = buildScopeRunContext({
      ...baseScope,
      targets: [{ type: 'cidr', value: '192.168.1.0/24', verified: true }],
    } as never, 'scope_runner');

    expect(context).toContain('Authorized private CIDR targets');
    expect(context).toContain('192.168.1.0/24');
    expect(context).toContain('wlan0:192.168.1.20/24');
  });

  it('separates verified authority from unverified observations', () => {
    const context = buildScopeRunContext({
      ...baseScope,
      targets: [
        { type: 'domain', value: 'app.example.com', verified: true },
        { type: 'domain', value: 'observed.example.net', verified: false },
      ],
    } as never);

    expect(context).toContain('=== AUTHORITY BOUNDARY ===');
    expect(context).toContain('=== AUTHORIZED TARGETS ===\n  - app.example.com (domain)');
    expect(context).toContain('=== UNVERIFIED OBSERVATIONS (NOT AUTHORIZED) ===\n  - 1 target observation(s) omitted because they are not authorized.');
    expect(context).not.toContain('observed.example.net');
  });

  it('keeps reporting context free of runner, repository, and credential delivery', () => {
    const context = buildScopeRunContext({
      ...baseScope,
      targets: [{ type: 'domain', value: 'app.example.com', verified: true }],
      whiteboxEnabled: true,
      connectedRepoCount: 1,
      connectedRepositories: [{ id: 'repo-1', provider: 'github', fullName: 'org/private-app' }],
      accessMaterialCount: 1,
      accessMaterials: [{ id: 'access-1', label: 'Test account', kind: 'credentials' }],
    } as never, 'scope_runner', 'reporting');

    expect(context).toContain('=== AUTHORIZED TARGETS ===');
    expect(context).not.toContain('EXECUTION ENVIRONMENT');
    expect(context).not.toContain('PRIVATE RUNNER NETWORK PREFLIGHT');
    expect(context).not.toContain('CONNECTED REPOSITORIES');
    expect(context).not.toContain('SCOPE ACCESS MATERIAL');
  });
});
