import { randomUUID } from 'crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setupTestDb } from '../../helpers/testDb';
import { ExposureVerificationService } from '@/domains/security-ops/exposure/ExposureVerificationService';
import { ExposureVerificationCompletion } from '@/domains/security-ops/exposure/ExposureVerificationCompletion';
import {
  advisories,
  assets,
  assetScopeMemberships,
  exposureMatchEvents,
  exposureMatches,
  findingEvidence,
  findings,
  inventoryComponents,
  organizations,
  runs,
  scopes,
  users,
} from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { SecurityOpsEvidenceResolver } from '@/domains/security-ops/tools/evidence/EvidenceResolver';
import { SecurityOpsToolService } from '@/domains/security-ops/tools/SecurityOpsToolService';
import { SubmitExposureVerification } from '@/domains/agent-brain/adapters/tools/builtins/securityops/exposure';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { SessionEventJournalRepository } from '@/domains/agent-brain/adapters/persistence/SessionEventJournalRepository';
import { MessageRepository } from '@/domains/agent-brain/adapters/persistence/MessageRepository';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import { SessionPersistenceService } from '@/domains/agent-brain/infrastructure/persistence/SessionPersistenceService';
import { checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

/**
 * The verification lifecycle, end to end, against a real database.
 *
 * This exists because the previous iteration passed every unit test while being
 * completely non-functional: the submit tool read the match id from
 * `session.flags.vars`, which `StartRunService` never populates. Fakes could not
 * catch it, because the fakes were built from the same wrong assumption.
 *
 * So this test binds the way production binds — through
 * `exposure_matches.verification_run_id` — and asserts the properties that
 * actually matter to a customer: exactly one validated finding carrying the CVE,
 * the match reaching `confirmed`, and a second submission being unable to change
 * a verdict that already landed.
 */
const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('Exposure verification lifecycle (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) skip = true;
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip || !harness) return;
      await fn();
    });

  const seed = async () => {
    const db = harness!.db as any;
    const userId = randomUUID();
    const slug = `verify-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await db.insert(users).values({ id: userId, email: `${slug}@example.com`, password_hash: 'x' });

    const [{ id: orgId }] = await db
      .insert(organizations)
      .values({ name: 'Verify Org', slug })
      .returning({ id: organizations.id });

    const scopeColumns = new Set(
      (
        await harness!.pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='scopes'`,
        )
      ).rows.map((row) => row.column_name),
    );

    const cols = ['organization_id', 'name'];
    const vals: Array<string | boolean> = [orgId, 'Prod'];
    if (scopeColumns.has('user_id')) { cols.push('user_id'); vals.push(userId); }
    if (scopeColumns.has('kind')) { cols.push('kind'); vals.push('domain'); }
    if (scopeColumns.has('safe_mode')) { cols.push('safe_mode'); vals.push(true); }
    if (scopeColumns.has('status')) { cols.push('status'); vals.push('active'); }

    const scopeId = (
      await harness!.pool.query<{ id: string }>(
        `INSERT INTO scopes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        vals,
      )
    ).rows[0]!.id;

    const [asset] = await db
      .insert(assets)
      .values({
        organizationId: orgId,
        scopeId,
        userId,
        kind: 'domain',
        value: `${slug}.example.com`,
      })
      .returning({ id: assets.id });

    const componentKey = `cpe:test:widget-${randomUUID().slice(0, 8)}`;
    const [component] = await db
      .insert(inventoryComponents)
      .values({
        organizationId: orgId,
        assetId: asset.id,
        ecosystem: 'cpe',
        componentKey,
        displayName: 'Widget',
        resolvedVersion: '1.0.0',
        resolvedVersionScheme: 'cpe',
      })
      .returning({ id: inventoryComponents.id });

    const canonicalId = `CVE-TEST-${randomUUID().slice(0, 8)}`;
    const [advisory] = await db
      .insert(advisories)
      .values({
        canonicalId,
        canonicalSource: 'nvd',
        cveId: canonicalId,
        title: 'Test advisory',
        lastModifiedAt: new Date(),
        state: 'active',
        severity: 'critical',
        cvssV31Score: 9.8,
        applicability: 'simple',
      })
      .returning({ id: advisories.id });

    const [match] = await db
      .insert(exposureMatches)
      .values({
        organizationId: orgId,
        assetId: asset.id,
        componentId: component.id,
        advisoryId: advisory.id,
        matchConfidence: 'exact_version',
        priorityScore: 90,
        state: 'notified',
        inventoryObservedAt: new Date(),
        dedupeKey: `${orgId}|${asset.id}|${componentKey}|${canonicalId}`,
      })
      .returning({ id: exposureMatches.id });

    return { db, orgId, userId, scopeId, assetId: asset.id as string, matchId: match.id as string, canonicalId };
  };

  /**
   * A real run row.
   *
   * `exposure_matches.verification_run_id` is a foreign key, so a synthetic id
   * cannot be stored — which the first version of this test discovered. Using a
   * real run is also closer to production, where the id always references one.
   */
  const seedRun = async (ctx: Awaited<ReturnType<typeof seed>>): Promise<string> => {
    const [run] = await ctx.db
      .insert(runs)
      .values({
        organizationId: ctx.orgId,
        scopeId: ctx.scopeId,
        userId: ctx.userId,
        goal: 'Verify a single advisory against a single asset',
        trigger: 'exposure_verification',
      })
      .returning({ id: runs.id });
    return run.id as string;
  };

  /**
   * A workspace with a real artifact in it.
   *
   * Earlier versions of this test passed `.artifacts/proof.txt` without ever
   * creating the file, which meant "a confirmed verdict requires evidence"
   * was only ever tested against a string the test itself invented. Writing a
   * real file makes the resolver do real work, so the test can distinguish
   * genuine evidence from a fabricated citation.
   */
  const seedWorkspace = async (): Promise<string> => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'exposure-verify-'));
    await mkdir(path.join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(
      path.join(workspaceDir, '.artifacts', 'proof.txt'),
      ['GET /wp-content/plugins/ HTTP/1.1', '', 'HTTP/1.1 200 OK', ''].join('\n'),
      'utf8',
    );
    return workspaceDir;
  };

  /** Resolves exactly as the exposure tool does: every path must be a real file. */
  const resolveEvidence = async (
    workspaceDir: string,
    evidence: Array<{ path: string; label?: string }>,
  ) => new SecurityOpsEvidenceResolver().resolveEvidenceRefs(workspaceDir, evidence);

  const startVerification = async (ctx: Awaited<ReturnType<typeof seed>>, runId: string) => {
    const service = new ExposureVerificationService(ctx.db, {
      enforceVerificationAdmission: vi.fn().mockResolvedValue(undefined),
      startVerificationRun: vi.fn().mockResolvedValue({ runId }),
    });
    return service.startVerification({
      organizationId: ctx.orgId,
      userId: ctx.userId,
      matchId: ctx.matchId,
    });
  };

  itMaybe('runs the full lifecycle: start, confirm, finding created', async () => {
    const ctx = await seed();
    const runId = await seedRun(ctx);

    const started = await startVerification(ctx, runId);
    expect(started).toMatchObject({ runId, alreadyRunning: false });

    // The binding that previously did not exist: the run must be able to find
    // its own exposure without anything being passed through the prompt.
    const workspaceDir = await seedWorkspace();
    const evidence = await resolveEvidence(workspaceDir, [
      { path: '.artifacts/proof.txt', label: 'HTTP exchange' },
    ]);
    expect(evidence).toHaveLength(1);

    const completion = new ExposureVerificationCompletion(ctx.db);
    const result = await completion.complete({
      organizationId: ctx.orgId,
      runId,
      userId: ctx.userId,
      sessionId: undefined,
      outcome: 'confirmed',
      method: 'Reproduced the documented vector with a negative control',
      evidence,
    });

    expect(result).toMatchObject({ exposureMatchId: ctx.matchId, state: 'confirmed' });
    expect(result.riskId).toBeTruthy();

    const [match] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.id, ctx.matchId));
    expect(match.state).toBe('confirmed');
    expect(match.riskId).toBe(result.riskId);

    const createdFindings = await ctx.db
      .select()
      .from(findings)
      .where(and(eq(findings.organizationId, ctx.orgId), eq(findings.assetId, match.assetId)));

    expect(createdFindings).toHaveLength(1);
    expect(createdFindings[0]).toMatchObject({
      sourceKind: 'advisory_verification',
      state: 'confirmed',
      cveId: ctx.canonicalId,
    });

    // The proof must be inspectable, not merely required. `finding_evidence` is
    // what the findings UI already reads, so persisting here is what makes the
    // validated claim auditable by the customer.
    const storedEvidence = await ctx.db
      .select()
      .from(findingEvidence)
      .where(eq(findingEvidence.findingId, result.riskId!));

    expect(storedEvidence).toHaveLength(1);
    expect(storedEvidence[0]).toMatchObject({
      path: '.artifacts/proof.txt',
      label: 'HTTP exchange',
      fileMissing: false,
    });
  });

  itMaybe('owns the promoted Risk by the verification run scope, not the asset origin scope', async () => {
    const ctx = await seed();
    const secondScopeId = randomUUID();
    await ctx.db.insert(scopes).values({
      id: secondScopeId,
      organizationId: ctx.orgId,
      name: 'Shared asset verification scope',
      executionNetwork: 'external',
      status: 'active',
    });
    await ctx.db.insert(assetScopeMemberships).values({
      organizationId: ctx.orgId,
      assetId: ctx.assetId,
      scopeId: secondScopeId,
    });
    const [run] = await ctx.db
      .insert(runs)
      .values({
        organizationId: ctx.orgId,
        scopeId: secondScopeId,
        userId: ctx.userId,
        goal: 'Verify the shared asset in its current scope',
        trigger: 'exposure_verification',
      })
      .returning({ id: runs.id });
    await startVerification(ctx, run.id);

    const workspaceDir = await seedWorkspace();
    const evidence = await resolveEvidence(workspaceDir, [
      { path: '.artifacts/proof.txt', label: 'Scoped verification proof' },
    ]);
    const result = await new ExposureVerificationCompletion(ctx.db).complete({
      organizationId: ctx.orgId,
      runId: run.id,
      userId: ctx.userId,
      outcome: 'confirmed',
      method: 'Reproduced inside the second scope',
      evidence,
    });

    const [risk] = await ctx.db
      .select({ scopeId: findings.scopeId, assetId: findings.assetId })
      .from(findings)
      .where(eq(findings.id, result.riskId!));
    expect(risk).toEqual({ scopeId: secondScopeId, assetId: ctx.assetId });
  });

  itMaybe('rejects fabricated evidence, so it cannot authorize a finding', async () => {
    // The failure the evidence rule exists to prevent: a model citing a path it
    // never created. The resolver drops an entry that is neither on disk nor
    // accompanied by an excerpt, which empties the list and leaves the
    // confirmation with nothing to stand on.
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);

    const workspaceDir = await seedWorkspace();
    await expect(
      new SecurityOpsToolService({ db: ctx.db }).submitExposureVerification({
        organizationId: ctx.orgId,
        runId,
        userId: ctx.userId,
        workspaceDir,
        outcome: 'confirmed',
        method: 'Cited a file that does not exist',
        evidence: [
          // A schema-bypassing caller cannot turn model-authored text into
          // durable proof by smuggling the note resolver's excerpt fallback.
          {
            path: '.artifacts/never-written.txt',
            label: 'Invented',
            excerpt: 'HTTP/1.1 200 OK',
          } as never,
        ],
      }),
    ).rejects.toThrow(/never-written|ENOENT/iu);

    const [match] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.id, ctx.matchId));
    expect(match.state).toBe('verifying');

    const createdFindings = await ctx.db
      .select()
      .from(findings)
      .where(eq(findings.organizationId, ctx.orgId));
    expect(createdFindings).toHaveLength(0);
  });

  itMaybe('runs the production terminal tool against real Postgres and leaves one coherent result', async () => {
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);
    const workspaceDir = await seedWorkspace();
    const sessionRepository = new SessionRepository(ctx.db as never);
    const sessionStore = new SessionStore({
      workspaceManager: createTestWorkspaceManager(),
      persistenceService: new SessionPersistenceService({
        sessions: sessionRepository,
        messages: new MessageRepository(ctx.db as never),
      }),
      sessionEventJournal: new SessionEventJournalRepository(ctx.db as never),
    });

    try {
      const session = await sessionStore.create({
        userId: ctx.userId,
        mode: 'automated',
        agentType: 'planner',
        modelName: 'frozen-verification-provider',
        promptProfile: 'exposure-verification',
        flags: {
          securityops: {
            organizationId: ctx.orgId,
            scopeId: ctx.scopeId,
            runId,
            runTrigger: 'exposure_verification',
            activePhaseKey: 'planning',
          },
        },
      });
      session.workspaceDir = workspaceDir;
      session.stateMachine?.startProcessing(
        'test.production_verification_fixture',
        1,
        'ExposureVerification.integration',
      );
      await sessionStore.setAsync(session.id, session, 'test.production_verification_fixture');

      const toolContext = {
        sessionId: session.id,
        turnNumber: 1,
        workspaceDir,
        sandbox: { destroySandbox: vi.fn(async () => undefined) },
        sessionStore,
        streamBroker: { emit: vi.fn() },
        trace: { write: vi.fn(async () => undefined) },
        approvals: { require: vi.fn(async () => undefined) },
        checkpoints: undefined,
        guards: {},
        policies: {
          requireApproval: false,
          allowlist: ['submit_exposure_verification'],
          denyPatterns: [],
          maxStdoutBytes: 65_536,
          timeoutMs: 120_000,
        },
        flags: session.flags ?? {},
        planRuntime: {},
        abortSignal: new AbortController().signal,
      } as any;

      // This object is the frozen provider output. No model is called, but the
      // exact production tool, run binding, evidence resolver, transaction, and
      // terminal layer are exercised.
      const result = await SubmitExposureVerification.run({
        outcome: 'confirmed',
        method: 'Documented vector reproduced; paired negative control did not reproduce',
        reason: 'Frozen provider acceptance fixture',
        confidence: 0.97,
        evidence: [{ path: '.artifacts/proof.txt', label: 'HTTP exchange and negative control' }],
      }, toolContext);

      expect(result).toMatchObject({
        ok: true,
        data: {
          success: true,
          exposureMatchId: ctx.matchId,
          state: 'confirmed',
          terminal: true,
          nextAction: 'stop',
        },
      });

      const terminalSession = sessionStore.get(session.id)!;
      expect(terminalSession.completed).toBe(true);
      expect(checkSessionTerminal(terminalSession)).toMatchObject({
        isTerminal: true,
        kind: 'exposure_verification_submitted',
      });

      const [match] = await ctx.db
        .select()
        .from(exposureMatches)
        .where(eq(exposureMatches.id, ctx.matchId));
      expect(match).toMatchObject({ state: 'confirmed' });
      expect(match.riskId).toBeTruthy();

      const storedEvidence = await ctx.db
        .select()
        .from(findingEvidence)
        .where(eq(findingEvidence.findingId, match.riskId!));
      expect(storedEvidence).toHaveLength(1);
      expect(storedEvidence[0]).toMatchObject({
        sessionId: session.id,
        path: '.artifacts/proof.txt',
        fileMissing: false,
      });

      const replay = await SubmitExposureVerification.run({
        outcome: 'inconclusive',
        method: 'Late duplicate must not alter the verdict',
      }, toolContext);
      expect(replay).toMatchObject({
        ok: true,
        data: {
          alreadySubmitted: true,
          state: 'confirmed',
          exposureMatchId: ctx.matchId,
        },
      });
    } finally {
      sessionStore.shutdown();
    }
  });

  itMaybe('cannot change a verdict that already landed', async () => {
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);

    const completion = new ExposureVerificationCompletion(ctx.db);
    await completion.complete({
      organizationId: ctx.orgId,
      runId,
      userId: ctx.userId,
      outcome: 'confirmed',
      method: 'Reproduced',
      evidence: await resolveEvidence(await seedWorkspace(), [{ path: '.artifacts/proof.txt' }]),
    });

    // A duplicate or late submission must not be able to overwrite it.
    await expect(
      completion.complete({
        organizationId: ctx.orgId,
        runId,
        userId: ctx.userId,
        outcome: 'not_reproduced',
        method: 'Second attempt',
      }),
    ).rejects.toThrow();

    const [match] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.id, ctx.matchId));
    expect(match.state).toBe('confirmed');
  });

  itMaybe('refuses a confirmed verdict with no evidence', async () => {
    // A validated finding is the strongest claim this system makes; asserting it
    // without a durable artifact is exactly the trust failure to avoid.
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);

    await expect(
      new ExposureVerificationCompletion(ctx.db).complete({
        organizationId: ctx.orgId,
        runId,
        userId: ctx.userId,
        outcome: 'confirmed',
        method: 'Claimed without proof',
        evidence: [],
      }),
    ).rejects.toThrow(/evidence/iu);

    const [match] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.id, ctx.matchId));
    expect(match.state).toBe('verifying');
  });

  itMaybe('records not_reproduced without creating a finding', async () => {
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);

    const result = await new ExposureVerificationCompletion(ctx.db).complete({
      organizationId: ctx.orgId,
      runId,
      userId: ctx.userId,
      outcome: 'not_reproduced',
      method: 'Attempted the documented vector; it did not work here',
    });

    expect(result.state).toBe('not_reproduced');
    expect(result.riskId).toBeNull();

    const createdFindings = await ctx.db
      .select()
      .from(findings)
      .where(eq(findings.organizationId, ctx.orgId));
    expect(createdFindings).toHaveLength(0);
  });

  itMaybe('rejects a run that is not bound to any exposure', async () => {
    const ctx = await seed();

    await expect(
      new ExposureVerificationCompletion(ctx.db).complete({
        organizationId: ctx.orgId,
        runId: randomUUID(),
        userId: ctx.userId,
        outcome: 'confirmed',
        method: 'Unbound run',
        evidence: [{ path: '.artifacts/proof.txt' }],
      }),
    ).rejects.toThrow(/awaiting verification/iu);
  });

  itMaybe('writes a transition event for the timeline', async () => {
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);

    await new ExposureVerificationCompletion(ctx.db).complete({
      organizationId: ctx.orgId,
      runId,
      userId: ctx.userId,
      outcome: 'confirmed',
      method: 'Reproduced',
      evidence: await resolveEvidence(await seedWorkspace(), [{ path: '.artifacts/proof.txt' }]),
    });

    const events = await ctx.db
      .select()
      .from(exposureMatchEvents)
      .where(eq(exposureMatchEvents.matchId, ctx.matchId));

    expect(events.some((event: any) => event.toState === 'confirmed')).toBe(true);
  });

  itMaybe('does not recover an old verification while its bound run is still active', async () => {
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await ctx.db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId));
    await ctx.db
      .update(exposureMatches)
      .set({ updatedAt: old })
      .where(eq(exposureMatches.id, ctx.matchId));

    await new ExposureVerificationService(ctx.db).recoverStalledVerifications({
      olderThanMinutes: 30,
    });

    const [match] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.id, ctx.matchId));
    expect(match.state).toBe('verifying');
  });

  itMaybe('recovers an old verification after its bound run becomes terminal', async () => {
    const ctx = await seed();
    const runId = await seedRun(ctx);
    await startVerification(ctx, runId);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await ctx.db.update(runs).set({ status: 'completed' }).where(eq(runs.id, runId));
    await ctx.db
      .update(exposureMatches)
      .set({ updatedAt: old })
      .where(eq(exposureMatches.id, ctx.matchId));

    await new ExposureVerificationService(ctx.db).recoverStalledVerifications({
      olderThanMinutes: 30,
    });

    const [match] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.id, ctx.matchId));
    expect(match.state).toBe('inconclusive');
  });

  itMaybe('recovers the old orphan created by the run-start binding crash window', async () => {
    const ctx = await seed();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await ctx.db
      .update(exposureMatches)
      .set({
        state: 'verifying',
        verificationRunId: null,
        updatedAt: old,
      })
      .where(eq(exposureMatches.id, ctx.matchId));

    await new ExposureVerificationService(ctx.db).recoverStalledVerifications({
      olderThanMinutes: 30,
    });

    const [match] = await ctx.db
      .select()
      .from(exposureMatches)
      .where(eq(exposureMatches.id, ctx.matchId));
    expect(match.state).toBe('inconclusive');
  });
});
