import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { asc, eq } from 'drizzle-orm';

import { setupTestDb } from '../../helpers/testDb';
import {
  agentSessions,
  organizations,
  runEvents,
  runPhaseReplans,
  runPhases,
  runs,
  scopes,
  users,
} from '@/db/schema';
import { RunService } from '@/domains/security-ops/runs/RunService';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type Harness = NonNullable<Awaited<ReturnType<typeof setupTestDb>>>;

const uniqueSlug = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const mission = (overrides: Record<string, unknown>) => ({
  id: 'mission-1',
  phase: 'enumeration',
  question: 'Which reachable API routes expose interesting behavior?',
  why_ready_now: 'Recon identified a reachable API host.',
  required_evidence: ['route inventory'],
  expected_artifact: 'API route inventory',
  stop_condition: 'Routes are inventoried or blocked.',
  assigned_skills: ['api-enumeration'],
  ...overrides,
});

const createFixture = async (harness: Harness) => {
  const db = harness.db as any;
  const userId = randomUUID();
  const plannerSessionId = randomUUID();
  const executorSessionId = randomUUID();

  await db.insert(users).values({
    id: userId,
    email: `${uniqueSlug('phase-lifecycle')}@example.com`,
    password_hash: 'test',
  });

  const [org] = await db
    .insert(organizations)
    .values({
      name: 'Phase Lifecycle Org',
      slug: uniqueSlug('phase-lifecycle-org'),
    })
    .returning({ id: organizations.id });

  const [scope] = await db
    .insert(scopes)
    .values({
      organizationId: org.id,
      name: 'Primary Scope',
      executionNetwork: 'external',
    })
    .returning({ id: scopes.id });

  await db.insert(agentSessions).values([
    {
      id: plannerSessionId,
      userId,
      mode: 'automated',
      agentType: 'planner',
      workspaceDir: `/tmp/${plannerSessionId}`,
      scopeId: scope.id,
    },
    {
      id: executorSessionId,
      userId,
      mode: 'automated',
      agentType: 'executor',
      workspaceDir: `/tmp/${executorSessionId}`,
      scopeId: scope.id,
    },
  ]);

  const [run] = await db
    .insert(runs)
    .values({
      organizationId: org.id,
      scopeId: scope.id,
      userId,
      sessionId: executorSessionId,
      plannerSessionId,
      executorSessionId,
      goal: 'Assess API authorization boundaries',
      plan: '# API Authorization Boundary Assessment',
      status: 'running',
      trigger: 'manual',
    })
    .returning();

  return {
    userId,
    organizationId: org.id,
    scopeId: scope.id,
    plannerSessionId,
    executorSessionId,
    run,
  };
};

maybeDescribe('Run phase lifecycle integration', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
      }
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  const itMaybe = (name: string, fn: (harness: Harness) => Promise<void>) =>
    it(name, async () => {
      if (skip || !harness) return;
      await fn(harness);
    });

  itMaybe('preserves completed phase history and replaces only future phases on planner replan', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    await db.insert(runPhases).values([
      {
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: fixture.executorSessionId,
        stepIds: ['old-recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
        handoffOutRef: '.artifacts/phase-handoffs/recon.json',
        completedAt: new Date(),
      },
      {
        runId: fixture.run.id,
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'pending',
        sessionId: null,
        stepIds: ['old-enumeration'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
      },
    ]);

    await db
      .update(runs)
      .set({
        status: 'system_paused',
        title: 'API Authorization Boundary Assessment',
        sessionId: fixture.plannerSessionId,
        executorSessionId: null,
      })
      .where(eq(runs.id, fixture.run.id));

    await service.markPlanningComplete(
      fixture.run.id,
      '# Revised API Enumeration for app.example.com',
      ['api-enumeration', 'security-reporting'],
      fixture.plannerSessionId,
      {
        missions: [
          mission({ id: 'old-enumeration', phase: 'enumeration' }),
          mission({
            id: 'new-reporting',
            phase: 'reporting',
            question: 'What final report should be delivered?',
            assigned_skills: ['security-reporting'],
          }),
        ],
      },
    );

    // Resume/replan must preserve the established assessment title — it must not be
    // overwritten by the revised plan's H1 (regression: credit-resume leaked "Continue"
    // into the run title and the report name).
    const [replannedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id));
    expect(replannedRun.title).toBe('API Authorization Boundary Assessment');

    const phaseRows = await db
      .select()
      .from(runPhases)
      .where(eq(runPhases.runId, fixture.run.id))
      .orderBy(asc(runPhases.ordinal));

    expect(phaseRows).toHaveLength(3);
    expect(phaseRows[0]).toEqual(
      expect.objectContaining({
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: fixture.executorSessionId,
        stepIds: ['old-recon'],
      }),
    );
    expect(phaseRows.slice(1).map((row: any) => ({
      ordinal: row.ordinal,
      phaseKey: row.phaseKey,
      status: row.status,
      stepIds: row.stepIds,
    }))).toEqual([
      { ordinal: 2, phaseKey: 'enumeration', status: 'pending', stepIds: ['old-enumeration'] },
      { ordinal: 3, phaseKey: 'reporting', status: 'pending', stepIds: ['new-reporting'] },
    ]);

    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun).toEqual(
      expect.objectContaining({
        status: 'running',
        executorSessionId: null,
      }),
    );
  });

  itMaybe('auto-applies phase-driven planner revisions after phase history without a second approval gate', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    await db.insert(runPhases).values([
      {
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: fixture.executorSessionId,
        stepIds: ['old-recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
        handoffOutRef: '.artifacts/phase-handoffs/recon.json',
        completedAt: new Date(),
      },
      {
        runId: fixture.run.id,
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'pending',
        sessionId: null,
        stepIds: ['old-enumeration'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
      },
    ]);

    await db
      .update(runs)
      .set({
        status: 'running',
        sessionId: fixture.plannerSessionId,
        executorSessionId: null,
      })
      .where(eq(runs.id, fixture.run.id));

    await service.markPlanningComplete(
      fixture.run.id,
      '# Revised Validation-First Assessment for app.example.com',
      ['api-enumeration', 'idor', 'security-reporting'],
      fixture.plannerSessionId,
      {
        missions: [
          mission({ id: 'old-enumeration', phase: 'enumeration' }),
          mission({
            id: 'new-validation',
            phase: 'validation',
            question: 'Do parameterized API routes cross authorization boundaries?',
            assigned_skills: ['idor'],
          }),
          mission({
            id: 'new-reporting',
            phase: 'reporting',
            question: 'What final report should be delivered?',
            assigned_skills: ['security-reporting'],
          }),
        ],
      },
    );

    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun).toEqual(
      expect.objectContaining({
        status: 'running',
        executorSessionId: null,
      }),
    );

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, fixture.run.id));
    expect(events.some((event: any) => event.type === 'running' && event.note === 'planner_replan_applied')).toBe(true);

    await service.onSessionStatusChange(fixture.plannerSessionId, 'completed');
    const [afterPlannerCompletion] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(afterPlannerCompletion.status).toBe('running');

    const phaseRows = await db
      .select()
      .from(runPhases)
      .where(eq(runPhases.runId, fixture.run.id))
      .orderBy(asc(runPhases.ordinal));
    expect(phaseRows.map((row: any) => ({ ordinal: row.ordinal, phaseKey: row.phaseKey, stepIds: row.stepIds }))).toEqual([
      { ordinal: 1, phaseKey: 'recon', stepIds: ['old-recon'] },
      { ordinal: 2, phaseKey: 'enumeration', stepIds: ['old-enumeration'] },
      { ordinal: 3, phaseKey: 'validation', stepIds: ['new-validation'] },
      { ordinal: 4, phaseKey: 'reporting', stepIds: ['new-reporting'] },
    ]);

    const resumeCandidates = await service.listRunningRunsReadyForPhaseStart();
    expect(resumeCandidates.map((candidate) => candidate.id)).toContain(fixture.run.id);

    await db
      .update(runPhases)
      .set({ status: 'active', sessionId: fixture.executorSessionId })
      .where(eq(runPhases.id, phaseRows[1].id));
    const afterActivationCandidates = await service.listRunningRunsReadyForPhaseStart();
    expect(afterActivationCandidates.map((candidate) => candidate.id)).not.toContain(fixture.run.id);
  });

  itMaybe('does not let planner completion bypass first-plan approval into ready-phase resume', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const plannerOnlySessionId = randomUUID();

    await db.insert(agentSessions).values({
      id: plannerOnlySessionId,
      userId: fixture.userId,
      mode: 'automated',
      agentType: 'planner',
      workspaceDir: `/tmp/${plannerOnlySessionId}`,
      scopeId: fixture.scopeId,
    });

    await db
      .update(runs)
      .set({
        status: 'running',
        sessionId: plannerOnlySessionId,
        plannerSessionId: plannerOnlySessionId,
        executorSessionId: null,
        plan: '# API Authorization Boundary Assessment',
        launchPayload: {
          version: 1,
          kind: 'planner',
          params: { autoApproveOnPlanning: false },
        },
      })
      .where(eq(runs.id, fixture.run.id));

    await db.insert(runPhases).values({
      runId: fixture.run.id,
      ordinal: 1,
      phaseKey: 'recon',
      status: 'pending',
      sessionId: null,
      stepIds: ['first-recon'],
      assignedSkillSlugs: ['broad-surface-scan'],
      phaseProfile: 'phase-recon',
      toolProfile: 'phase-recon',
      promptProfile: 'phase-recon',
    });

    const service = new RunService(
      db,
      {} as never,
      {} as never,
      {
        sessionStatusPort: {
          async getRuntimeSnapshot(sessionId: string) {
            return sessionId === plannerOnlySessionId
              ? {
                  completed: true,
                  blockedReason: null,
                  hasPendingApproval: false,
                  lastActiveAt: new Date(),
                }
              : null;
          },
        },
      },
    );

    const reconciled = await service.reconcileBySessionId(plannerOnlySessionId);
    expect(reconciled?.status).toBe('awaiting_approval');

    const [storedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(storedRun.status).toBe('awaiting_approval');

    const resumeCandidates = await service.listRunningRunsReadyForPhaseStart();
    expect(resumeCandidates.map((candidate) => candidate.id)).not.toContain(fixture.run.id);

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, fixture.run.id));
    expect(events.some((event: any) => event.type === 'awaiting_approval')).toBe(true);
    expect(events.some((event: any) => event.type === 'running' && event.note === 'phase_session_started')).toBe(false);
  });

  itMaybe('auto-approves an unattended Watch plan from durable policy and exposes its first phase for recovery', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const plannerOnlySessionId = randomUUID();

    await db.insert(agentSessions).values({
      id: plannerOnlySessionId,
      userId: fixture.userId,
      mode: 'automated',
      agentType: 'planner',
      workspaceDir: `/tmp/${plannerOnlySessionId}`,
      scopeId: fixture.scopeId,
    });
    await db
      .update(runs)
      .set({
        status: 'running',
        sessionId: plannerOnlySessionId,
        plannerSessionId: plannerOnlySessionId,
        executorSessionId: null,
        plan: null,
        trigger: 'watch_scheduled',
        launchPayload: {
          version: 1,
          kind: 'planner',
          params: {
            autoApproveOnPlanning: true,
            securityOpsFlags: {
              websiteWatch: { assessmentKind: 'discovery' },
            },
          },
        },
      })
      .where(eq(runs.id, fixture.run.id));

    const service = new RunService(db, {} as never, {} as never);
    const updated = await service.markPlanningComplete(
      fixture.run.id,
      '# Website Watch Discovery for app.example.com',
      ['broad-surface-scan'],
      plannerOnlySessionId,
      { missions: [mission({ id: 'watch-recon', phase: 'recon' })] },
    );

    expect(updated.status).toBe('running');
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, fixture.run.id));
    expect(events.some((event: any) => event.type === 'running' && event.note === 'planner_completed')).toBe(true);
    expect(events.some((event: any) => {
      if (event.type !== 'plan_approved' || !event.note) return false;
      const note = JSON.parse(event.note);
      return note.source === 'auto'
        && note.actor === fixture.userId
        && note.reason === 'auto_approve_on_planning';
    })).toBe(true);

    const resumeCandidates = await service.listRunningRunsReadyForPhaseStart();
    expect(resumeCandidates.map((candidate) => candidate.id)).toContain(fixture.run.id);
  });

  itMaybe('detects applied phase replans from durable replan state', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    const [phase] = await db
      .insert(runPhases)
      .values({
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'enumeration',
        status: 'handoff_submitted',
        sessionId: fixture.executorSessionId,
        stepIds: ['enumeration'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
        handoffOutRef: '.artifacts/phase-handoffs/enumeration.json',
      })
      .returning();

    await service.requestPhaseReplan({
      orgId: fixture.organizationId,
      runId: fixture.run.id,
      phaseId: phase.id,
      phaseStatus: 'blocked',
      handoffRef: '.artifacts/phase-handoffs/enumeration.json',
      reason: 'environment changed',
    });

    await expect(service.hasAppliedPhaseReplan({ runId: fixture.run.id, phaseId: phase.id })).resolves.toBe(false);

    await service.markPlanningComplete(
      fixture.run.id,
      '# Revised Assessment for app.example.com',
      ['api-enumeration'],
      fixture.plannerSessionId,
      { missions: [mission({ id: 'new-enumeration', phase: 'enumeration' })] },
    );

    await expect(service.hasAppliedPhaseReplan({ runId: fixture.run.id, phaseId: phase.id })).resolves.toBe(true);
  });

  itMaybe('terminalizes a replan-requesting phase and moves the run back to planner ownership', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    const [phase] = await db
      .insert(runPhases)
      .values({
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'handoff_submitted',
        sessionId: fixture.executorSessionId,
        stepIds: ['recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
        handoffOutRef: '.artifacts/phase-handoffs/recon.json',
      })
      .returning();

    await service.requestPhaseReplan({
      orgId: fixture.organizationId,
      runId: fixture.run.id,
      phaseId: phase.id,
      phaseStatus: 'blocked',
      handoffRef: '.artifacts/phase-handoffs/recon.json',
      reason: 'The approved target is unreachable from this execution origin.',
    });

    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun).toEqual(
      expect.objectContaining({
        status: 'running',
        sessionId: fixture.plannerSessionId,
        executorSessionId: null,
      }),
    );

    const [updatedPhase] = await db.select().from(runPhases).where(eq(runPhases.id, phase.id)).limit(1);
    expect(updatedPhase).toEqual(
      expect.objectContaining({
        status: 'blocked',
        handoffOutRef: '.artifacts/phase-handoffs/recon.json',
      }),
    );

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, fixture.run.id));
    expect(events.some((event: any) => event.type === 'replan_pending' && event.note?.includes('phase_replan_requested'))).toBe(true);
    expect(events.some((event: any) => event.type === 'system_paused' && event.note?.includes('phase_replan_requested'))).toBe(false);

    const replans = await db.select().from(runPhaseReplans).where(eq(runPhaseReplans.phaseId, phase.id));
    expect(replans).toHaveLength(1);
    expect(replans[0]).toEqual(
      expect.objectContaining({
        runId: fixture.run.id,
        phaseId: phase.id,
        status: 'open',
        requestedPhaseStatus: 'blocked',
      }),
    );
  });

  itMaybe('does not duplicate an already-open phase replan request', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    const [phase] = await db
      .insert(runPhases)
      .values({
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'handoff_submitted',
        sessionId: fixture.executorSessionId,
        stepIds: ['recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
        handoffOutRef: '.artifacts/phase-handoffs/recon.json',
      })
      .returning();

    const request = {
      orgId: fixture.organizationId,
      runId: fixture.run.id,
      phaseId: phase.id,
      phaseStatus: 'blocked' as const,
      handoffRef: '.artifacts/phase-handoffs/recon.json',
      reason: 'The approved target is unreachable from this execution origin.',
    };
    await service.requestPhaseReplan(request);
    await service.requestPhaseReplan(request);

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, fixture.run.id));
    const pendingEvents = events.filter((event: any) => event.type === 'replan_pending');
    expect(pendingEvents).toHaveLength(1);

    const replans = await db.select().from(runPhaseReplans).where(eq(runPhaseReplans.phaseId, phase.id));
    expect(replans).toHaveLength(1);
    expect(replans[0].status).toBe('open');
  });

  itMaybe('enforces one open replan per phase at the database layer', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);

    const [phase] = await db
      .insert(runPhases)
      .values({
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'blocked',
        sessionId: fixture.executorSessionId,
        stepIds: ['recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
      })
      .returning();

    const values = {
      runId: fixture.run.id,
      phaseId: phase.id,
      status: 'open',
      requestedPhaseStatus: 'blocked',
      reason: 'constraint proof',
    };

    await db.insert(runPhaseReplans).values(values);
    await expect(db.insert(runPhaseReplans).values(values)).rejects.toThrow();
  });

  itMaybe('does not revive a cancelled run when a phase replan request arrives late', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    const [phase] = await db
      .insert(runPhases)
      .values({
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'handoff_submitted',
        sessionId: fixture.executorSessionId,
        stepIds: ['recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
        handoffOutRef: '.artifacts/phase-handoffs/recon.json',
      })
      .returning();
    await db
      .update(runs)
      .set({
        status: 'cancelled',
        sessionId: fixture.plannerSessionId,
        executorSessionId: null,
      })
      .where(eq(runs.id, fixture.run.id));

    await expect(
      service.requestPhaseReplan({
        orgId: fixture.organizationId,
        runId: fixture.run.id,
        phaseId: phase.id,
        phaseStatus: 'blocked',
        handoffRef: '.artifacts/phase-handoffs/recon.json',
        reason: 'Late replan after operator cancellation.',
      }),
    ).rejects.toThrow('terminal state "cancelled"');

    const [run] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(run.status).toBe('cancelled');
  });

  itMaybe('does not apply a planner replan to a cancelled run', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    await db.insert(runPhases).values({
      runId: fixture.run.id,
      ordinal: 1,
      phaseKey: 'recon',
      status: 'completed',
      sessionId: fixture.executorSessionId,
      stepIds: ['old-recon'],
      assignedSkillSlugs: ['broad-surface-scan'],
      phaseProfile: 'phase-recon',
      toolProfile: 'phase-recon',
      promptProfile: 'phase-recon',
    });
    await db
      .update(runs)
      .set({
        status: 'cancelled',
        sessionId: fixture.plannerSessionId,
        executorSessionId: null,
      })
      .where(eq(runs.id, fixture.run.id));

    await expect(
      service.markPlanningComplete(
        fixture.run.id,
        '# Revised Assessment for app.example.com',
        ['api-enumeration'],
        fixture.plannerSessionId,
        { missions: [mission({ id: 'new-enumeration', phase: 'enumeration' })] },
      ),
    ).rejects.toThrow('terminal state "cancelled"');

    const [run] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(run.status).toBe('cancelled');
  });

  itMaybe('marks active phase sessions failed when they complete without handoff', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    const [phase] = await db
      .insert(runPhases)
      .values({
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'enumeration',
        status: 'active',
        sessionId: fixture.executorSessionId,
        stepIds: ['enumeration'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
      })
      .returning();

    await service.onSessionStatusChange(fixture.executorSessionId, 'completed');

    const [updatedPhase] = await db.select().from(runPhases).where(eq(runPhases.id, phase.id)).limit(1);
    expect(updatedPhase).toEqual(
      expect.objectContaining({
        status: 'failed',
        lastError: 'Phase session completed without submit_phase_handoff',
      }),
    );

    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun.status).toBe('failed');
  });

  itMaybe('aborts unfinished phases when the operator cancels the run', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);
    const workerSessionId = randomUUID();

    await db.insert(runPhases).values([
      {
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: fixture.executorSessionId,
        stepIds: ['recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
        completedAt: new Date('2026-04-02T10:05:00.000Z'),
      },
      {
        runId: fixture.run.id,
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'active',
        sessionId: fixture.executorSessionId,
        stepIds: ['enumeration'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
        startedAt: new Date('2026-04-02T10:06:00.000Z'),
      },
      {
        runId: fixture.run.id,
        ordinal: 3,
        phaseKey: 'validation',
        status: 'pending',
        sessionId: null,
        stepIds: ['validation'],
        assignedSkillSlugs: ['validation'],
        phaseProfile: 'phase-validation',
        toolProfile: 'phase-validation',
        promptProfile: 'phase-validation',
      },
      {
        runId: fixture.run.id,
        ordinal: 4,
        phaseKey: 'reporting',
        status: 'handoff_submitted',
        sessionId: fixture.executorSessionId,
        stepIds: ['reporting'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-reporting',
        toolProfile: 'phase-reporting',
        promptProfile: 'phase-reporting',
      },
    ]);
    await db.insert(agentSessions).values({
      id: workerSessionId,
      userId: fixture.userId,
      mode: 'automated',
      agentType: 'executor',
      workspaceDir: `/tmp/${workerSessionId}`,
      scopeId: fixture.scopeId,
      metadata: {
        flags: {
          securityops: {
            runId: fixture.run.id,
            scopeId: fixture.scopeId,
            organizationId: fixture.organizationId,
          },
        },
        coordination: {
          role: 'worker',
          parentSessionId: fixture.executorSessionId,
        },
      },
    });

    await service.cancel(fixture.organizationId, fixture.run.id);

    const phaseRows = await db
      .select()
      .from(runPhases)
      .where(eq(runPhases.runId, fixture.run.id))
      .orderBy(asc(runPhases.ordinal));

    expect(phaseRows.map((row: any) => ({ ordinal: row.ordinal, status: row.status }))).toEqual([
      { ordinal: 1, status: 'completed' },
      { ordinal: 2, status: 'aborted' },
      { ordinal: 3, status: 'aborted' },
      { ordinal: 4, status: 'aborted' },
    ]);
    expect(phaseRows.slice(1).every((row: any) => row.completedAt instanceof Date)).toBe(true);
    expect(phaseRows.slice(1).every((row: any) => row.lastError === 'Run cancelled by operator before phase completion')).toBe(true);

    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun.status).toBe('cancelled');

    const blockedSessions = await db
      .select({
        id: agentSessions.id,
        blockedReason: agentSessions.blockedReason,
        metadata: agentSessions.metadata,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, workerSessionId));
    expect(blockedSessions[0]?.blockedReason).toBe('aborted_by_user');
    expect((blockedSessions[0]?.metadata as any)?.blockedMeta).toEqual(
      expect.objectContaining({
        reason: 'run_cancelled_by_operator',
        runId: fixture.run.id,
      }),
    );
  });

  itMaybe('leaves completed phase handoffs stable when the old session later terminates', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);

    const [phase] = await db
      .insert(runPhases)
      .values({
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: fixture.executorSessionId,
        stepIds: ['recon'],
        assignedSkillSlugs: ['broad-surface-scan'],
        phaseProfile: 'phase-recon',
        toolProfile: 'phase-recon',
        promptProfile: 'phase-recon',
        handoffOutRef: '.artifacts/phase-handoffs/recon.json',
      })
      .returning();

    await service.onSessionStatusChange(fixture.executorSessionId, 'completed');

    const [updatedPhase] = await db.select().from(runPhases).where(eq(runPhases.id, phase.id)).limit(1);
    expect(updatedPhase.status).toBe('completed');
    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun.status).toBe('running');
  });

  itMaybe('does not complete a primary run session while required phases remain open', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(db, {} as never, {} as never);
    const phaseSessionId = randomUUID();

    await db.insert(agentSessions).values({
      id: phaseSessionId,
      userId: fixture.userId,
      mode: 'automated',
      agentType: 'executor',
      workspaceDir: `/tmp/${phaseSessionId}`,
      scopeId: fixture.scopeId,
    });

    await db.insert(runPhases).values([
      {
        runId: fixture.run.id,
        ordinal: 1,
        phaseKey: 'evidence',
        status: 'completed',
        sessionId: phaseSessionId,
        stepIds: ['evidence'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-evidence',
        toolProfile: 'phase-evidence',
        promptProfile: 'phase-evidence',
        handoffOutRef: '.artifacts/phase-handoffs/evidence.json',
        completedAt: new Date(),
      },
      {
        runId: fixture.run.id,
        ordinal: 2,
        phaseKey: 'reporting',
        status: 'pending',
        sessionId: null,
        stepIds: ['reporting'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-reporting',
        toolProfile: 'phase-reporting',
        promptProfile: 'phase-reporting',
      },
    ]);

    await service.onSessionStatusChange(fixture.executorSessionId, 'completed');

    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun.status).toBe('running');
    expect(updatedRun.completedAt).toBeNull();

    const [reportingPhase] = await db
      .select()
      .from(runPhases)
      .where(eq(runPhases.runId, fixture.run.id))
      .orderBy(asc(runPhases.ordinal))
      .offset(1)
      .limit(1);
    expect(reportingPhase.status).toBe('pending');
  });

  itMaybe('reconciles completed report-only executor runs instead of returning to plan approval', async (harness) => {
    const db = harness.db as any;
    const fixture = await createFixture(harness);
    const service = new RunService(
      db,
      {} as never,
      {} as never,
      {
        sessionStatusPort: {
          getRuntimeSnapshot: async () => ({
            completed: true,
            blockedReason: null,
            hasPendingApproval: false,
            lastActiveAt: new Date(),
          }),
          listIdsByRunId: async () => [],
        },
      },
    );

    await db
      .update(runs)
      .set({
        plannerSessionId: null,
        status: 'running',
        title: 'HIPAA Security Rule Readiness Report',
      })
      .where(eq(runs.id, fixture.run.id));

    await db.insert(runPhases).values({
      runId: fixture.run.id,
      ordinal: 1,
      phaseKey: 'reporting',
      status: 'completed',
      sessionId: fixture.executorSessionId,
      stepIds: ['reporting'],
      assignedSkillSlugs: ['security-reporting'],
      phaseProfile: 'phase-reporting',
      toolProfile: 'phase-reporting',
      promptProfile: 'phase-reporting',
      completedAt: new Date(),
    });

    await service.reconcileBySessionId(fixture.executorSessionId);

    const [updatedRun] = await db.select().from(runs).where(eq(runs.id, fixture.run.id)).limit(1);
    expect(updatedRun.status).toBe('completed');
    expect(updatedRun.completedAt).toBeInstanceOf(Date);
  });
});
