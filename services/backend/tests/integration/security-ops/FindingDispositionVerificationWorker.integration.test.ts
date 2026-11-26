import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentApiServices } from '@/app/services/agent/types';
import {
  agentSessions,
  assets,
  findingDispositionVerifications,
  findings,
  organizationMembers,
  organizations,
  runs,
  scopes,
  scopeTargets,
  users,
  type RunRow,
} from '@/db/schema';
import { FindingDispositionVerificationService } from '@/domains/security-ops/findings/FindingDispositionVerificationService';
import { FindingDispositionVerificationWorker } from '@/domains/security-ops/findings/FindingDispositionVerificationWorker';
import type {
  StartFindingDispositionVerificationRunParams,
  StartFindingDispositionVerificationRunResult,
} from '@/domains/security-ops/runs/StartRunService';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('FindingDispositionVerificationWorker integration', () => {
  let harness: NonNullable<Awaited<ReturnType<typeof setupTestDb>>>;

  beforeAll(async () => {
    const value = await setupTestDb();
    if (!value) throw new Error('TEST_DATABASE_URL is required');
    harness = value;
  });

  beforeEach(async () => {
    await harness.truncateAll();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  const seed = async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const scopeId = randomUUID();
    const assetId = randomUUID();
    const findingId = randomUUID();
    await harness.db.insert(users).values({
      id: userId,
      email: `finding-worker-${userId}@example.invalid`,
      password_hash: 'test',
    });
    await harness.db.insert(organizations).values({
      id: organizationId,
      name: 'Finding worker integration',
      slug: `finding-worker-${organizationId}`,
    });
    await harness.db.insert(organizationMembers).values({
      organizationId,
      userId,
      role: 'admin',
    });
    await harness.db.insert(scopes).values({
      id: scopeId,
      organizationId,
      name: 'Worker scope',
      executionNetwork: 'external',
      status: 'active',
    });
    await harness.db.insert(scopeTargets).values({
      scopeId,
      type: 'url',
      value: 'https://worker-target.example.invalid',
      verified: true,
      verificationMethod: 'manual_review',
      verifiedAt: new Date(),
    });
    await harness.db.insert(assets).values({
      id: assetId,
      organizationId,
      scopeId,
      userId,
      kind: 'domain',
      value: 'worker-target.example.invalid',
    });
    await harness.db.insert(findings).values({
      id: findingId,
      organizationId,
      scopeId,
      userId,
      assetId,
      title: 'Worker command injection fixture',
      severity: 'high',
      state: 'confirmed',
      summary: 'A command marker reached a shell.',
      pocDescription: 'Replay the harmless marker.',
      dedupeKey: `finding-worker-${findingId}`,
    });
    return { userId, organizationId, scopeId, findingId };
  };

  const findRunByLaunchKey = async (
    organizationId: string,
    launchKey: string,
  ): Promise<RunRow | null> => {
    const [run] = await harness.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.organizationId, organizationId),
          eq(runs.idempotencyKey, launchKey),
        ),
      )
      .limit(1);
    return run ?? null;
  };

  const createRun = async (
    params: StartFindingDispositionVerificationRunParams,
  ): Promise<RunRow> => {
    const sessionId = randomUUID();
    await harness.db.insert(agentSessions).values({
      id: sessionId,
      userId: params.userId,
      scopeId: params.scopeId,
      mode: 'automated',
      agentType: 'executor',
      workspaceDir: `/tmp/${sessionId}`,
    });
    const [run] = await harness.db
      .insert(runs)
      .values({
        organizationId: params.orgId,
        scopeId: params.scopeId,
        userId: params.userId,
        sessionId,
        executorSessionId: sessionId,
        goal: 'Verify finding disposition',
        workflowDiscipline: 'pentest',
        status: 'running',
        trigger: 'event',
        idempotencyKey: params.launchKey,
        startedAt: new Date(),
      })
      .returning();
    if (!run) throw new Error('Failed to seed worker Run');
    return run;
  };

  const buildWorkerDeps = (scopeConcurrencyLimit = 3) => {
    let launchCalls = 0;
    const startFindingDispositionVerificationRun = async (
      params: StartFindingDispositionVerificationRunParams,
    ): Promise<StartFindingDispositionVerificationRunResult> => {
      launchCalls += 1;
      const existing = await findRunByLaunchKey(params.orgId, params.launchKey);
      const run = existing ?? await createRun(params);
      await params.beforeKickoff?.({
        run,
        sessionId: run.sessionId!,
        phaseId: randomUUID(),
      });
      return {
        run,
        sessionId: run.sessionId!,
        phaseId: randomUUID(),
        policySlug: 'test',
        warnings: [],
        runner: null,
        runnerName: null,
        idempotentReplay: Boolean(existing),
      };
    };
    return {
      get launchCalls() {
        return launchCalls;
      },
      deps: {
        db: harness.db,
        startRunService: { startFindingDispositionVerificationRun },
        runService: {
          getScopeConcurrencyLimit: () => scopeConcurrencyLimit,
          getByIdempotencyKey: findRunByLaunchKey,
          cancel: async (organizationId: string, runId: string) => {
            await harness.db
              .update(runs)
              .set({ status: 'cancelled', completedAt: new Date() })
              .where(and(eq(runs.organizationId, organizationId), eq(runs.id, runId)));
          },
        },
        agentServices: {
          sessionStore: {
            abortCurrentTurnAsync: async () => undefined,
            getOrHydrate: async () => undefined,
            setAsync: async () => undefined,
            cleanupRunWorkspaceAsync: async () => ({
              cleaned: true,
              workspaceDirs: [],
              activeSessionIds: [],
              errors: 0,
            }),
          },
          agentEngine: {
            stopSandbox: async () => undefined,
          },
        } as unknown as AgentApiServices,
        sessionRepository: {
          listIdsByRunId: async () => [],
          setBlockedReason: async () => true,
        },
        random: () => 0.5,
      },
    };
  };

  it('allows two worker instances to contend without launching the same verification twice', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const requested = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved',
      requestKey: 'two-worker-contention',
    });
    const launcher = buildWorkerDeps(1);
    const workerA = new FindingDispositionVerificationWorker({
      ...launcher.deps,
      workerId: 'worker-a',
    });
    const workerB = new FindingDispositionVerificationWorker({
      ...launcher.deps,
      workerId: 'worker-b',
    });

    await Promise.all([workerA.sweep(1), workerB.sweep(1)]);

    const [verification] = await harness.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, requested.verification.id));
    const [runCount] = await harness.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(eq(runs.idempotencyKey, requested.verification.launchKey));
    expect(verification).toMatchObject({
      status: 'running',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(launcher.launchCalls).toBe(1);
    expect(runCount?.count).toBe(1);
  });

  it('repairs an expired launch lease by relinking the one existing idempotent Run', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const requested = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved',
      requestKey: 'expired-launch-repair',
    });
    const existingRun = await createRun({
      orgId: fixture.organizationId,
      userId: fixture.userId,
      scopeId: fixture.scopeId,
      verificationId: requested.verification.id,
      findingId: fixture.findingId,
      requestedState: 'resolved',
      snapshot: requested.verification.snapshot,
      launchKey: requested.verification.launchKey,
    });
    await harness.db
      .update(findingDispositionVerifications)
      .set({
        status: 'launching',
        leaseOwner: 'crashed-worker',
        leaseExpiresAt: new Date(Date.now() - 10_000),
        launchAttemptCount: 1,
        runId: null,
        sessionId: null,
      })
      .where(eq(findingDispositionVerifications.id, requested.verification.id));
    const launcher = buildWorkerDeps(1);
    const worker = new FindingDispositionVerificationWorker({
      ...launcher.deps,
      workerId: 'repair-worker',
    });

    const summary = await worker.sweep(1);

    const [verification] = await harness.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, requested.verification.id));
    const [runCount] = await harness.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(eq(runs.idempotencyKey, requested.verification.launchKey));
    expect(summary).toMatchObject({ repaired: 1, reconciled: 1 });
    expect(verification).toMatchObject({
      status: 'running',
      runId: existingRun.id,
      sessionId: existingRun.sessionId,
    });
    expect(launcher.launchCalls).toBe(1);
    expect(runCount?.count).toBe(1);
  });

  it('durably links a verification while its cloud Run waits without a session', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const requested = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved',
      requestKey: 'queued-cloud-link',
    });
    const launcher = buildWorkerDeps(3);
    launcher.deps.startRunService.startFindingDispositionVerificationRun = async (params) => {
      const [run] = await harness.db.insert(runs).values({
        organizationId: params.orgId,
        scopeId: params.scopeId,
        userId: params.userId,
        sessionId: null,
        executorSessionId: null,
        goal: 'Queued finding verification',
        workflowDiscipline: 'pentest',
        status: 'queued',
        trigger: 'event',
        executionTarget: 'cloud',
        idempotencyKey: params.launchKey,
        queuedAt: new Date(),
        eligibleAt: new Date(),
        capacityWaitReason: 'waiting_for_admission',
      }).returning();
      return {
        run,
        sessionId: null,
        phaseId: null,
        policySlug: 'cloud',
        warnings: [],
        runner: null,
        runnerName: null,
        idempotentReplay: false,
      };
    };
    const worker = new FindingDispositionVerificationWorker({
      ...launcher.deps,
      workerId: 'queued-cloud-worker',
    });

    const summary = await worker.sweep(1);

    const [verification] = await harness.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, requested.verification.id));
    expect(summary).toMatchObject({ waiting: 1, started: 0 });
    expect(verification).toMatchObject({
      status: 'running',
      waitReason: 'waiting_for_admission',
      sessionId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(verification.runId).not.toBeNull();
  });

  it('waits for scope capacity without consuming a launch attempt', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const requested = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved',
      requestKey: 'capacity-wait',
    });
    await createRun({
      orgId: fixture.organizationId,
      userId: fixture.userId,
      scopeId: fixture.scopeId,
      verificationId: randomUUID(),
      findingId: fixture.findingId,
      requestedState: 'resolved',
      snapshot: requested.verification.snapshot,
      launchKey: `unrelated-active-run:${randomUUID()}`,
    });
    const launcher = buildWorkerDeps(1);
    const worker = new FindingDispositionVerificationWorker({
      ...launcher.deps,
      workerId: 'capacity-worker',
    });

    const summary = await worker.sweep(1);

    const [verification] = await harness.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, requested.verification.id));
    expect(summary.claimed).toBe(0);
    expect(verification).toMatchObject({
      status: 'waiting',
      waitReason: 'scope_capacity',
      launchAttemptCount: 0,
    });
    expect(launcher.launchCalls).toBe(0);
  });

  it('fails before launch when the requester loses finding-triage permission', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const requested = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'dismissed',
      requestKey: 'permission-revoked',
    });
    await harness.db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, fixture.organizationId),
          eq(organizationMembers.userId, fixture.userId),
        ),
      );
    const launcher = buildWorkerDeps();
    const worker = new FindingDispositionVerificationWorker({
      ...launcher.deps,
      workerId: 'permission-worker',
    });

    await worker.sweep(1);

    const [verification] = await harness.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, requested.verification.id));
    expect(verification).toMatchObject({
      status: 'failed',
      failureCode: 'permission_revoked',
      runId: null,
    });
    expect(launcher.launchCalls).toBe(0);
  });
});
