import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
} from '@/db/schema';
import { FindingDispositionVerificationService } from '@/domains/security-ops/findings/FindingDispositionVerificationService';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('FindingDispositionVerificationService integration', () => {
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
      email: `finding-disposition-${userId}@example.invalid`,
      password_hash: 'test',
    });
    await harness.db.insert(organizations).values({
      id: organizationId,
      name: 'Finding disposition integration',
      slug: `finding-disposition-${organizationId}`,
    });
    await harness.db.insert(organizationMembers).values({
      organizationId,
      userId,
      role: 'admin',
    });
    await harness.db.insert(scopes).values({
      id: scopeId,
      organizationId,
      name: 'Disposition scope',
      executionNetwork: 'external',
      status: 'active',
    });
    await harness.db.insert(scopeTargets).values({
      scopeId,
      type: 'url',
      value: 'https://target.example.invalid',
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
      value: 'target.example.invalid',
    });
    await harness.db.insert(findings).values({
      id: findingId,
      organizationId,
      scopeId,
      userId,
      assetId,
      title: 'Command injection',
      severity: 'high',
      state: 'confirmed',
      summary: 'The host parameter reached a shell.',
      pocDescription: 'Replay the harmless command marker.',
      dedupeKey: `finding-disposition-${findingId}`,
    });
    return { userId, organizationId, scopeId, findingId };
  };

  const linkRun = async (
    fixture: Awaited<ReturnType<typeof seed>>,
    verificationId: string,
    suffix: string,
  ) => {
    const sessionId = randomUUID();
    const runId = randomUUID();
    await harness.db.insert(agentSessions).values({
      id: sessionId,
      userId: fixture.userId,
      scopeId: fixture.scopeId,
      mode: 'automated',
      agentType: 'executor',
      workspaceDir: `/tmp/${sessionId}`,
    });
    await harness.db.insert(runs).values({
      id: runId,
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      userId: fixture.userId,
      sessionId,
      executorSessionId: sessionId,
      goal: 'Verify the finding disposition',
      workflowDiscipline: 'pentest',
      status: 'running',
      idempotencyKey: `finding-disposition:${verificationId}:${suffix}`,
    });
    await harness.db
      .update(findingDispositionVerifications)
      .set({
        status: 'running',
        runId,
        sessionId,
        startedAt: new Date(),
      })
      .where(eq(findingDispositionVerifications.id, verificationId));
    return { runId, sessionId };
  };

  const evidence = (path: string, statusCode: number) => ({
    kind: 'http_exchange' as const,
    path,
    displayPath: `GET ${path}`,
    label: path,
    data: {
      source: 'request_tool' as const,
      request: {
        method: 'GET',
        url: `https://target.example.invalid${path}`,
        headers: [],
      },
      response: {
        statusCode,
        headers: [],
        body: { text: '{}', truncated: false },
      },
    },
  });

  it('is idempotent, commits a valid outcome atomically, and cannot cancel it afterward', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const request = {
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved' as const,
      requestKey: 'resolve-command-injection',
      reason: 'The patch is deployed',
    };
    const first = await service.request(request);
    const replay = await service.request(request);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.verification.id).toBe(first.verification.id);
    await expect(service.request({
      ...request,
      reason: 'Different content under the same key',
    })).rejects.toMatchObject({ httpStatus: 409 });

    const linked = await linkRun(fixture, first.verification.id, 'first');
    const outcome = await service.submitOutcome({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      runId: linked.runId,
      sessionId: linked.sessionId,
      workspaceEvidence: [
        evidence('/replay', 400),
        evidence('/control', 200),
      ],
      input: {
        requestId: first.verification.id,
        findingId: fixture.findingId,
        outcome: 'fixed',
        reason: 'The injected marker is rejected while normal ping works.',
        evidence: [],
        proof: {
          claim: 'The host parameter reaches a shell.',
          replayAttempted: true,
          replayReproduced: false,
          prerequisitesSatisfied: true,
          evidenceIds: ['/replay'],
          controlEvidenceIds: ['/control'],
        },
      },
    });
    expect(outcome).toMatchObject({
      outcome: 'fixed',
      canonicalState: 'resolved',
    });
    const [finding] = await harness.db
      .select()
      .from(findings)
      .where(eq(findings.id, fixture.findingId));
    expect(finding).toMatchObject({
      state: 'resolved',
    });
    const cancellation = await service.cancel({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      verificationId: first.verification.id,
      cancelledByUserId: fixture.userId,
    });
    expect(cancellation.runId).toBeNull();
    expect(cancellation.verification.status).toBe('completed');
  });

  it('increments lifecycle version through direct SQL and retains a stale result as inconclusive', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const [before] = await harness.db
      .select({ version: findings.lifecycleVersion })
      .from(findings)
      .where(eq(findings.id, fixture.findingId));
    await harness.db
      .update(findings)
      .set({ summary: 'Metadata changed only' })
      .where(eq(findings.id, fixture.findingId));
    const [afterMetadata] = await harness.db
      .select({ version: findings.lifecycleVersion })
      .from(findings)
      .where(eq(findings.id, fixture.findingId));
    expect(afterMetadata?.version).toBe(before?.version);

    const request = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved',
      requestKey: 'stale-result',
    });
    const linked = await linkRun(fixture, request.verification.id, 'stale');
    await harness.db
      .update(findings)
      .set({ state: 'verifying' })
      .where(eq(findings.id, fixture.findingId));
    const [afterLifecycle] = await harness.db
      .select({ version: findings.lifecycleVersion })
      .from(findings)
      .where(eq(findings.id, fixture.findingId));
    expect(afterLifecycle?.version).toBe((before?.version ?? 0) + 1);

    const outcome = await service.submitOutcome({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      runId: linked.runId,
      sessionId: linked.sessionId,
      workspaceEvidence: [],
      input: {
        requestId: request.verification.id,
        findingId: fixture.findingId,
        outcome: 'fixed',
        reason: 'The replay would otherwise support a fix.',
        evidence: [],
        proof: {
          claim: 'The host parameter reaches a shell.',
          replayAttempted: false,
          prerequisitesSatisfied: false,
          evidenceIds: ['evidence-that-no-longer-needs-resolution'],
          controlEvidenceIds: [],
        },
      },
    });
    expect(outcome).toMatchObject({
      outcome: 'inconclusive',
      canonicalState: 'verifying',
    });
    const [attempt] = await harness.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, request.verification.id));
    expect(attempt).toMatchObject({
      status: 'completed',
      outcome: 'inconclusive',
      blockerCode: 'stale_finding_lifecycle',
    });
  });

  it('rejects an outcome that is incompatible with the requested disposition at the database boundary', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const request = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved',
      requestKey: 'database-outcome-compatibility',
    });

    await expect(
      harness.pool.query(
        `UPDATE finding_disposition_verifications
         SET outcome = 'false_positive'
         WHERE id = $1`,
        [request.verification.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'finding_disposition_verifications_outcome_disposition_check',
    });
  });

  it('serializes a real concurrent outcome/cancel race so only one terminal decision wins', async () => {
    const fixture = await seed();
    const service = new FindingDispositionVerificationService(harness.db);
    const request = await service.request({
      organizationId: fixture.organizationId,
      findingId: fixture.findingId,
      requestedByUserId: fixture.userId,
      requestedState: 'resolved',
      requestKey: 'outcome-cancel-race',
    });
    const linked = await linkRun(fixture, request.verification.id, 'race');

    const [outcomeResult, cancelResult] = await Promise.allSettled([
      service.submitOutcome({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        runId: linked.runId,
        sessionId: linked.sessionId,
        workspaceEvidence: [
          evidence('/race-replay', 400),
          evidence('/race-control', 200),
        ],
        input: {
          requestId: request.verification.id,
          findingId: fixture.findingId,
          outcome: 'fixed',
          reason: 'The replay is rejected and the control works.',
          evidence: [],
          proof: {
            claim: 'The host parameter reaches a shell.',
            replayAttempted: true,
            replayReproduced: false,
            prerequisitesSatisfied: true,
            evidenceIds: ['/race-replay'],
            controlEvidenceIds: ['/race-control'],
          },
        },
      }),
      service.cancel({
        organizationId: fixture.organizationId,
        findingId: fixture.findingId,
        verificationId: request.verification.id,
        cancelledByUserId: fixture.userId,
      }),
    ]);

    const [verification] = await harness.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, request.verification.id));
    const [finding] = await harness.db
      .select()
      .from(findings)
      .where(eq(findings.id, fixture.findingId));
    if (verification?.status === 'completed') {
      expect(outcomeResult.status).toBe('fulfilled');
      expect(cancelResult.status).toBe('fulfilled');
      expect(verification.outcome).toBe('fixed');
      expect(finding?.state).toBe('resolved');
    } else {
      expect(verification?.status).toBe('cancelled');
      expect(cancelResult.status).toBe('fulfilled');
      expect(outcomeResult.status).toBe('rejected');
      expect(verification?.outcome).toBeNull();
      expect(finding?.state).toBe('confirmed');
    }
  });
});
