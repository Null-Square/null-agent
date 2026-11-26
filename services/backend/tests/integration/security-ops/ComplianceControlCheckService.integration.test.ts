import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentSessions,
  agentArtifacts,
  auditLogs,
  complianceControlCheckReviews,
  complianceControlChecks,
  complianceControlRequests,
  complianceEvidenceItems,
  complianceEvidenceMappings,
  organizations,
  runs,
  scopes,
  users,
} from '@/db/schema';
import { appendHttpHistoryEntry } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
import { ComplianceControlCheckService } from '@/domains/security-ops/compliance/ComplianceControlCheckService';
import { ComplianceControlRequestService } from '@/domains/security-ops/compliance/ComplianceControlRequestService';
import { ComplianceControlCheckReviewService } from '@/domains/security-ops/compliance/ComplianceControlCheckReviewService';
import { ComplianceEvidenceService } from '@/domains/security-ops/compliance/ComplianceEvidenceService';
import { ComplianceRunBundleService } from '@/domains/security-ops/compliance/ComplianceRunBundleService';
import { ComplianceReadinessService } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('ComplianceControlCheckService integration', () => {
  let harness: NonNullable<Awaited<ReturnType<typeof setupTestDb>>>;
  let workspaceDir: string;

  beforeAll(async () => {
    const testDb = await setupTestDb();
    if (!testDb) throw new Error('TEST_DATABASE_URL is required');
    harness = testDb;
  });

  beforeEach(async () => {
    // Checks and requests here are recorded on a fixed clock (22 June 2026); readiness judges their
    // 90-day freshness against today. Read readiness on the day they were recorded.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-22T12:10:00.000Z'));
    await harness.truncateAll();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-control-check-'));
    await fs.mkdir(path.join(workspaceDir, '.artifacts'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, '.artifacts', 'authz-proof.json'), '{"authorized":403}');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
    await harness?.dispose();
  });

  const seed = async (
    complianceFrameworks: Array<'soc2' | 'nist_csf'> = ['soc2'],
    runFramework?: 'soc2' | 'nist_csf',
  ) => {
    const db = harness.db;
    const userId = randomUUID();
    const organizationId = randomUUID();
    const scopeId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    await db.insert(users).values({ id: userId, email: `control-${userId}@example.com`, password_hash: 'hash' });
    await db.insert(organizations).values({
      id: organizationId,
      name: 'Control Check Org',
      slug: `control-${organizationId}`,
    });
    await db.insert(scopes).values({ id: scopeId, organizationId, name: 'Production', complianceFrameworks });
    await db.insert(agentSessions).values({ id: sessionId, userId, scopeId, workspaceDir });
    await db.insert(runs).values({
      id: runId,
      organizationId,
      scopeId,
      userId,
      sessionId,
      goal: 'Test access controls',
      workflowDiscipline: runFramework ? 'compliance' : 'pentest',
      complianceFrameworkKey: runFramework ?? null,
    });
    return { userId, organizationId, scopeId, sessionId, runId };
  };

  const input = {
    frameworkKey: 'soc2',
    controlId: 'CC6.1',
    verdict: 'pass',
    reasonCode: 'control_operating',
    reason: 'Authentication and tenant authorization rejected all unauthorized requests in the tested endpoint set.',
    proofObligationId: 'soc2-cc6.1-authz-v1',
    evidenceRefs: ['.artifacts/authz-proof.json'],
    targetRef: 'https://app.example.com/api/admin',
    method: 'HTTP differential test',
    skillSlug: 'idor',
    limitations: ['Only selected admin endpoints were tested.'],
    proof: {
      claim: 'Unauthorized identities cannot access protected resources in the tested endpoint set.',
      evidenceIds: ['.artifacts/authz-proof.json'],
      replayAttempted: true,
      replayArtifact: '.artifacts/authz-proof.json',
      replayReproduced: true,
    },
  } as const;

  it('records, audits, applies, and idempotently reuses a fresh pass', async () => {
    const fixture = await seed();
    const now = new Date('2026-06-22T12:00:00.000Z');
    const service = new ComplianceControlCheckService(harness.db, () => now);

    const first = await service.record({ ...fixture, workspaceDir, input: { ...input, controlId: 'cc6.1' } });
    const duplicate = await service.record({ ...fixture, workspaceDir, input });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ ...first, created: false });
    const rows = await harness.db.select().from(complianceControlChecks).where(eq(complianceControlChecks.id, first.checkId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.controlId).toBe('CC6.1');
    expect(await harness.db.select().from(auditLogs).where(eq(auditLogs.resourceId, first.checkId))).toHaveLength(1);
    const artifacts = await harness.db
      .select()
      .from(agentArtifacts)
      .where(eq(agentArtifacts.sessionId, fixture.sessionId));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.originalName).toContain('compliance-proof');

    const readiness = await new ComplianceReadinessService(harness.db).getScopeReadiness({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
    });
    expect(readiness.frameworks[0]?.controls.find((control) => control.id === 'CC6.1')).toMatchObject({
      verdict: 'pass',
      outcome: 'passed',
      status: 'passing',
    });
  });

  it('rejects control checks for a different framework than the active compliance run', async () => {
    const fixture = await seed(['soc2', 'nist_csf'], 'soc2');
    const service = new ComplianceControlCheckService(harness.db, () => new Date('2026-06-22T12:00:00.000Z'));

    await expect(service.record({
      ...fixture,
      workspaceDir,
      input: {
        frameworkKey: 'nist_csf',
        controlId: 'ID.AM',
        verdict: 'needs_context',
        reasonCode: 'missing_scope',
        reason: 'NIST inventory control could not be assessed because this run is scoped to SOC 2.',
        proofObligationId: 'nist-id.am-inventory-v1',
        evidenceRefs: [],
        targetRef: 'scope inventory',
        method: 'Readiness context review',
        proof: {
          claim: 'NIST inventory readiness was not assessed in the SOC 2 run.',
          evidenceIds: [],
          replayAttempted: false,
        },
      },
    })).rejects.toThrow('scoped to soc2');
  });

  it('rejects control requests for a different framework than the active compliance run', async () => {
    const fixture = await seed(['soc2', 'nist_csf'], 'soc2');
    const service = new ComplianceControlRequestService(harness.db, () => new Date('2026-06-22T12:00:00.000Z'));

    await expect(service.record({
      ...fixture,
      input: {
        frameworkKey: 'nist_csf',
        controlId: 'ID.AM',
        requestType: 'context',
        priority: 'medium',
        title: 'Provide NIST inventory context',
        reason: 'NIST inventory context belongs to a NIST CSF run, not the active SOC 2 run.',
        requestedEvidence: [],
      },
    })).rejects.toThrow('scoped to soc2');
  });

  it('keeps mapped evidence advisory until an agent control check cites it', async () => {
    const fixture = await seed();
    const evidenceService = new ComplianceEvidenceService(harness.db);
    const validUntil = new Date('2027-05-14T00:00:00.000Z');
    const evidence = await evidenceService.createEvidenceItem({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      uploadedBy: fixture.userId,
      title: 'Code of conduct policy',
      description: 'Organization policy uploaded before agent mapping.',
      sourceType: 'user_upload',
      evidenceType: 'policy',
      artifact: {
        fileName: 'code-of-conduct.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 512,
        sha256: 'f'.repeat(64),
        storageRef: `${fixture.organizationId}/code-of-conduct.pdf`,
        sourceRef: 'uploaded:code-of-conduct.pdf',
      },
      validUntil,
      mappings: [],
    });
    expect(evidence.mappings).toHaveLength(0);
    await expect(evidenceService.listEvidenceItems({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      framework: 'soc2',
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: evidence.id, mappings: [] }),
    ]));

    const suggested = await evidenceService.upsertEvidenceMappings({
      organizationId: fixture.organizationId,
      evidenceItemId: evidence.id,
      actorUserId: fixture.userId,
      mappings: [
        {
          frameworkKey: 'soc2',
          controlId: 'CC1.1',
          mappingSource: 'system_suggested',
          confidence: 'high',
          rationale: 'The file appears to be the code of conduct policy required by CC1.1.',
          citationAnchors: [{ page: 1, section: 'Purpose', excerpt: 'Code of conduct' }],
        },
        {
          frameworkKey: 'iso27001',
          controlId: 'ISO-A-ORG-POLICY',
          mappingSource: 'system_suggested',
          confidence: 'high',
          rationale: 'The same policy supports the ISO security policy evidence category.',
          citationAnchors: [{ page: 1, section: 'Purpose', excerpt: 'Code of conduct' }],
        },
        {
          frameworkKey: 'nist_csf',
          controlId: 'GV.PO',
          mappingSource: 'system_suggested',
          confidence: 'high',
          rationale: 'The same policy supports the NIST CSF cybersecurity policy Category.',
          citationAnchors: [{ page: 1, section: 'Purpose', excerpt: 'Code of conduct' }],
        },
      ],
    });
    expect(suggested.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ frameworkKey: 'soc2', controlId: 'CC1.1' }),
      expect.objectContaining({ frameworkKey: 'iso27001', controlId: 'ISO-A-ORG-POLICY' }),
      expect.objectContaining({ frameworkKey: 'nist_csf', controlId: 'GV.PO' }),
    ]));
    await expect(evidenceService.listEvidenceItems({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      framework: 'nist_csf',
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: evidence.id,
        mappings: expect.arrayContaining([expect.objectContaining({ frameworkKey: 'nist_csf', controlId: 'GV.PO' })]),
      }),
    ]));

    // Mapped evidence stays advisory: no human approval exists, and a mapping alone never credits readiness.
    let readiness = await new ComplianceReadinessService(harness.db).getScopeReadiness({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
    });
    let cc11 = readiness.frameworks[0]?.controls.find((control) => control.id === 'CC1.1');
    expect(cc11?.status).not.toBe('passing');
    expect(cc11?.evidence.some((item) => item.kind === 'user_evidence')).toBe(false);

    const checkService = new ComplianceControlCheckService(harness.db, () => new Date('2026-06-22T12:00:00.000Z'));
    await checkService.record({
      ...fixture,
      workspaceDir,
      input: {
        frameworkKey: 'soc2',
        controlId: 'CC1.1',
        basis: 'agent_reviewed_user_evidence',
        verdict: 'pass',
        reasonCode: 'control_operating',
        reason: 'The uploaded code of conduct policy states the expected control expectations and is usable as process evidence for this control.',
        proofObligationId: 'evidence-review:soc2:cc1.1',
        evidenceRefs: [`compliance-evidence:${evidence.id}`],
        targetRef: 'uploaded code of conduct policy',
        method: 'agent review of uploaded compliance evidence',
        limitations: ['Document review verifies the policy artifact, not employee understanding or policy enforcement.'],
        proof: {
          claim: 'The uploaded policy supports the selected SOC 2 control for the documented period.',
          evidenceIds: [`compliance-evidence:${evidence.id}`],
          replayAttempted: false,
          notReplayedReason: 'document_evidence_review',
        },
      },
    });

    readiness = await new ComplianceReadinessService(harness.db).getScopeReadiness({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
    });
    cc11 = readiness.frameworks[0]?.controls.find((control) => control.id === 'CC1.1');
    expect(cc11?.status).toBe('passing');
    expect(cc11?.basis).toBe('agent_reviewed_user_evidence');
    expect(cc11?.evidence[0]?.kind).toBe('agent_control_check');

    const mappingAuditRows = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceType, 'compliance_evidence_mapping'));
    expect(mappingAuditRows).toHaveLength(3);
    expect(mappingAuditRows.every((row) => row.action === 'compliance.evidence_mapping.suggested')).toBe(true);
  });

  it('keeps scoped compliance evidence isolated from legacy null-scope evidence', async () => {
    const fixture = await seed();
    const evidenceService = new ComplianceEvidenceService(harness.db);

    const scoped = await evidenceService.createEvidenceItem({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      uploadedBy: fixture.userId,
      title: 'Production access policy',
      sourceType: 'user_upload',
      evidenceType: 'policy',
      artifact: {
        fileName: 'production-access-policy.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 512,
        sha256: 'a'.repeat(64),
        storageRef: `${fixture.organizationId}/production-access-policy.pdf`,
        sourceRef: 'uploaded:production-access-policy.pdf',
      },
      mappings: [
        {
          frameworkKey: 'soc2',
          controlId: 'CC6.1',
          mappingSource: 'user_declared',
          confidence: 'high',
          rationale: 'The scoped production policy supports access control.',
        },
      ],
    });

    const legacyNullScope = await evidenceService.createEvidenceItem({
      organizationId: fixture.organizationId,
      scopeId: null,
      uploadedBy: fixture.userId,
      title: 'Legacy organization-wide identity export',
      sourceType: 'integration',
      evidenceType: 'system_export',
      artifact: {
        fileName: 'legacy-identity.json',
        mimeType: 'application/json',
        sizeBytes: 256,
        sha256: 'b'.repeat(64),
        storageRef: `${fixture.organizationId}/legacy-identity.json`,
        sourceRef: 'google-workspace:legacy',
      },
      mappings: [
        {
          frameworkKey: 'soc2',
          controlId: 'CC6.1',
          mappingSource: 'system_suggested',
          confidence: 'medium',
          rationale: 'Legacy null-scope evidence must not bleed into a scoped run.',
        },
      ],
    });

    await expect(evidenceService.listEvidenceItems({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      framework: 'soc2',
    })).resolves.toEqual([
      expect.objectContaining({ id: scoped.id, scopeId: fixture.scopeId }),
    ]);

    await expect(evidenceService.listEvidenceItems({
      organizationId: fixture.organizationId,
      scopeId: null,
      framework: 'soc2',
    })).resolves.toEqual([
      expect.objectContaining({ id: legacyNullScope.id, scopeId: null }),
    ]);
  });

  it('lets the agent annotate a bare uploaded file without touching mappings or status', async () => {
    const fixture = await seed();
    const evidenceService = new ComplianceEvidenceService(harness.db);
    // User uploads a bare file: filename title, default type, no description/validUntil.
    const evidence = await evidenceService.createEvidenceItem({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      uploadedBy: fixture.userId,
      title: 'coc.pdf',
      sourceType: 'user_upload',
      evidenceType: 'other',
      artifact: {
        fileName: 'coc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 512,
        sha256: 'a'.repeat(64),
        storageRef: `${fixture.organizationId}/coc.pdf`,
        sourceRef: 'uploaded:coc.pdf',
      },
      mappings: [],
    });
    await evidenceService.upsertEvidenceMappings({
      organizationId: fixture.organizationId,
      evidenceItemId: evidence.id,
      actorUserId: fixture.userId,
      mappings: [{ frameworkKey: 'soc2', controlId: 'CC1.1', mappingSource: 'system_suggested', confidence: 'high', rationale: 'looks like the code of conduct' }],
    });

    const annotated = await evidenceService.annotateEvidenceItem({
      organizationId: fixture.organizationId,
      evidenceItemId: evidence.id,
      actorUserId: fixture.userId,
      title: 'Code of conduct policy',
      description: 'Company-wide code of conduct covering ethics and acceptable use.',
      evidenceType: 'policy',
      validUntil: new Date('2027-06-01T00:00:00.000Z'),
    });

    expect(annotated.title).toBe('Code of conduct policy');
    expect(annotated.description).toBe('Company-wide code of conduct covering ethics and acceptable use.');
    expect(annotated.evidenceType).toBe('policy');
    expect(annotated.validUntil?.toISOString()).toBe('2027-06-01T00:00:00.000Z');
    // Annotation never grants credit or alters mappings/status.
    expect(annotated.status).toBe('unreviewed');
    expect(annotated.mappings).toHaveLength(1);
    expect(annotated.mappings[0]?.mappingSource).toBe('system_suggested');
  });

  it('rejects unresolved proof, manual-control passes, and cross-tenant or cross-run context', async () => {
    const fixture = await seed();
    const service = new ComplianceControlCheckService(harness.db);

    await expect(service.record({
      ...fixture,
      workspaceDir,
      input: { ...input, evidenceRefs: ['.artifacts/missing.json'], proof: { ...input.proof, evidenceIds: ['.artifacts/missing.json'] } },
    })).rejects.toThrow('unresolved reference');

    await expect(service.record({
      ...fixture,
      workspaceDir,
      input: { ...input, controlId: 'CC1.1', proofObligationId: 'missing-obligation' },
    })).rejects.toThrow('does not have an authored proof obligation');

    await expect(service.record({
      ...fixture,
      organizationId: randomUUID(),
      workspaceDir,
      input,
    })).rejects.toThrow('Scope not found for organization');

    const otherSessionId = randomUUID();
    await harness.db.insert(agentSessions).values({
      id: otherSessionId,
      userId: fixture.userId,
      scopeId: fixture.scopeId,
      workspaceDir,
    });
    await harness.db.insert(runs).values({
      id: randomUUID(),
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      userId: fixture.userId,
      sessionId: otherSessionId,
      goal: 'Unrelated run in the same scope',
    });

    await expect(service.record({
      ...fixture,
      sessionId: otherSessionId,
      workspaceDir,
      input,
    })).rejects.toThrow('Session is not bound to the current run');
  });

  it('records idempotent agent control requests and surfaces them in readiness', async () => {
    const fixture = await seed();
    const service = new ComplianceControlRequestService(harness.db, () => new Date('2026-06-22T12:00:00.000Z'));
    const requestInput = {
      frameworkKey: 'soc2',
      controlId: 'cc6.1',
      requestType: 'access',
      priority: 'high',
      title: 'Provide non-admin test credentials',
      reason: 'Cross-role authorization evidence cannot be completed without a non-admin account for the tested application.',
      requestedEvidence: ['non-admin test account', 'admin test account'],
      remediationHint: 'Create scoped, temporary test users with read-only access for the compliance assessment.',
      dueAt: '2026-06-29T12:00:00.000Z',
    };

    const first = await service.record({ ...fixture, input: requestInput });
    const duplicate = await service.record({ ...fixture, input: requestInput });
    const refreshed = await service.record({
      ...fixture,
      input: {
        ...requestInput,
        priority: 'medium',
        title: 'Provide scoped role test accounts',
        reason: 'The compliance checker still needs temporary admin and non-admin access handles before it can review cross-role authorization behavior.',
      },
    });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ ...first, created: false });
    expect(refreshed).toEqual({ ...first, created: false, status: 'open' });
    const rows = await harness.db
      .select()
      .from(complianceControlRequests);
    const requestRows = rows.filter((row) => row.id === first.requestId);
    const activeRowsForControl = rows.filter((row) =>
      row.frameworkKey === 'soc2' &&
      row.controlId === 'CC6.1' &&
      row.requestType === 'access',
    );
    expect(activeRowsForControl).toHaveLength(1);
    expect(requestRows).toHaveLength(1);
    expect(requestRows[0]).toMatchObject({
      controlId: 'CC6.1',
      requestType: 'access',
      priority: 'medium',
      status: 'open',
      title: 'Provide scoped role test accounts',
    });

    const nextSessionId = randomUUID();
    const nextRunId = randomUUID();
    await harness.db.insert(agentSessions).values({
      id: nextSessionId,
      userId: fixture.userId,
      scopeId: fixture.scopeId,
      workspaceDir,
    });
    await harness.db.insert(runs).values({
      id: nextRunId,
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      userId: fixture.userId,
      sessionId: nextSessionId,
      goal: 'Follow-up compliance run',
    });
    const crossRunRefresh = await service.record({
      ...fixture,
      runId: nextRunId,
      sessionId: nextSessionId,
      input: {
        ...requestInput,
        title: 'Need temporary role accounts',
        reason: 'A later run still cannot complete cross-role authorization evidence without temporary role handles.',
        requestedEvidence: ['role account handles'],
      },
    });
    expect(crossRunRefresh).toEqual({ requestId: first.requestId, created: false, status: 'open' });
    const refreshedRows = await harness.db
      .select()
      .from(complianceControlRequests)
      .where(eq(complianceControlRequests.id, first.requestId));
    expect(refreshedRows[0]).toMatchObject({
      runId: nextRunId,
      sessionId: nextSessionId,
      title: 'Need temporary role accounts',
      requestedEvidence: ['admin test account', 'non-admin test account', 'role account handles'],
    });
    expect(await harness.db.select().from(complianceControlRequests)).toHaveLength(1);

    const readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: nextRunId,
    });
    const control = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control?.actionRequests).toEqual([
      expect.objectContaining({
        id: first.requestId,
        requestType: 'access',
        priority: 'high',
        title: 'Need temporary role accounts',
      }),
    ]);
  });

  it('reuses an open NIST CSF evidence request across repeated runs', async () => {
    const fixture = await seed(['soc2', 'nist_csf']);
    const service = new ComplianceControlRequestService(harness.db, () => new Date('2026-06-22T12:00:00.000Z'));
    const input = {
      frameworkKey: 'nist_csf',
      controlId: 'gv.po',
      requestType: 'evidence',
      priority: 'medium',
      title: 'Provide the approved cybersecurity policy set',
      reason: 'The current evidence library does not contain an approved cybersecurity policy with review history.',
      requestedEvidence: ['approved cybersecurity policy', 'policy review or approval record'],
    };
    const first = await service.record({ ...fixture, input });

    const nextSessionId = randomUUID();
    const nextRunId = randomUUID();
    await harness.db.insert(agentSessions).values({
      id: nextSessionId,
      userId: fixture.userId,
      scopeId: fixture.scopeId,
      workspaceDir,
    });
    await harness.db.insert(runs).values({
      id: nextRunId,
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      userId: fixture.userId,
      sessionId: nextSessionId,
      goal: 'Follow-up NIST CSF readiness run',
      complianceFrameworkKey: 'nist_csf',
    });
    const repeated = await service.record({
      ...fixture,
      runId: nextRunId,
      sessionId: nextSessionId,
      input: {
        ...input,
        title: 'Upload the current cybersecurity policy',
        reason: 'The follow-up run still lacks an approved policy artifact for GV.PO.',
      },
    });

    expect(first.created).toBe(true);
    expect(repeated).toEqual({ requestId: first.requestId, created: false, status: 'open' });
    const rows = await harness.db.select().from(complianceControlRequests);
    expect(rows.filter((row) => row.frameworkKey === 'nist_csf' && row.controlId === 'GV.PO')).toHaveLength(1);
  });

  it('fulfills agent control requests only with mapped same-scope evidence', async () => {
    const fixture = await seed();
    const service = new ComplianceControlRequestService(harness.db, () => new Date('2026-06-22T12:00:00.000Z'));
    const request = await service.record({
      ...fixture,
      input: {
        frameworkKey: 'soc2',
        controlId: 'CC6.1',
        requestType: 'evidence',
        priority: 'medium',
        title: 'Upload access review export',
        reason: 'The agent needs the current access review export to review this control.',
        requestedEvidence: ['current access review export'],
      },
    });

    const [unmappedEvidence] = await harness.db.insert(complianceEvidenceItems).values({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      title: 'Unmapped access review',
      sourceType: 'user_upload',
      evidenceType: 'access_review',
    }).returning({ id: complianceEvidenceItems.id });
    await expect(service.fulfill({
      userId: fixture.userId,
      organizationId: fixture.organizationId,
      requestId: request.requestId,
      input: { evidenceItemId: unmappedEvidence!.id },
    })).rejects.toThrow('not mapped to this requested control');

    const [mappedEvidence] = await harness.db.insert(complianceEvidenceItems).values({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      title: 'Mapped access review',
      sourceType: 'user_upload',
      evidenceType: 'access_review',
      artifact: {
        fileName: 'access-review.csv',
        mimeType: 'text/csv',
        sizeBytes: 64,
        sha256: 'b'.repeat(64),
        storageRef: 'org-1/access-review.csv',
        sourceRef: 'upload:access-review.csv',
      },
    }).returning({ id: complianceEvidenceItems.id });
    await harness.db.insert(complianceEvidenceMappings).values({
      organizationId: fixture.organizationId,
      evidenceItemId: mappedEvidence!.id,
      frameworkKey: 'soc2',
      controlId: 'CC6.1',
      mappingSource: 'user_declared',
      rationale: 'Uploaded to fulfill the agent request.',
    });

    const fulfilled = await service.fulfill({
      userId: fixture.userId,
      organizationId: fixture.organizationId,
      requestId: request.requestId,
      input: {
        evidenceItemId: mappedEvidence!.id,
        note: 'Uploaded the Q2 export.',
      },
    });

    expect(fulfilled).toEqual({
      requestId: request.requestId,
      status: 'fulfilled',
      evidenceItemId: mappedEvidence!.id,
    });
    const rows = await harness.db
      .select()
      .from(complianceControlRequests)
      .where(eq(complianceControlRequests.id, request.requestId));
    expect(rows[0]).toMatchObject({
      status: 'fulfilled',
      fulfillmentEvidenceItemId: mappedEvidence!.id,
      fulfillmentNote: 'Uploaded the Q2 export.',
      fulfilledByUserId: fixture.userId,
    });
    expect(rows[0]?.fulfilledAt).toBeInstanceOf(Date);

    let readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
    });
    const control = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control?.actionRequests[0]).toEqual(expect.objectContaining({
      id: request.requestId,
      status: 'fulfilled',
      fulfillmentEvidenceItemId: mappedEvidence!.id,
      fulfilledByUserId: fixture.userId,
      fulfilledAt: expect.any(String),
    }));

    const checkService = new ComplianceControlCheckService(harness.db, () => new Date('2026-06-22T12:05:00.000Z'));
    const reviewCheck = await checkService.record({
      ...fixture,
      workspaceDir,
      input: {
        frameworkKey: 'soc2',
        controlId: 'CC6.1',
        basis: 'agent_reviewed_user_evidence',
        verdict: 'pass',
        reasonCode: 'control_operating',
        reason: 'The mapped access review export contains the required owner, scope, and period fields for this control.',
        proofObligationId: 'evidence-review:soc2:cc6.1',
        evidenceRefs: [`compliance-evidence:${mappedEvidence!.id}`],
        targetRef: 'uploaded access review evidence',
        method: 'agent review of uploaded compliance evidence',
        limitations: ['Document review does not independently test access enforcement outside the evidence period.'],
        proof: {
          claim: 'The uploaded access review export supports the selected SOC 2 access control for the stated period.',
          evidenceIds: [`compliance-evidence:${mappedEvidence!.id}`],
          replayAttempted: false,
          notReplayedReason: 'document_evidence_review',
        },
      },
    });
    const evidenceService = new ComplianceEvidenceService(harness.db);
    const evidenceList = await evidenceService.listEvidenceItems({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      framework: 'soc2',
    });
    expect(evidenceList.find((item) => item.id === mappedEvidence!.id)?.agentReview).toMatchObject({
      status: 'reviewed',
      checkId: reviewCheck.checkId,
      controlId: 'CC6.1',
      verdict: 'pass',
    });

    const reviewed = await service.review({
      actorId: fixture.sessionId,
      actorType: 'agent',
      organizationId: fixture.organizationId,
      runId: fixture.runId,
      requestId: request.requestId,
      input: {
        outcome: 'reviewed',
        controlCheckId: reviewCheck.checkId,
        note: 'The fulfilled evidence was reviewed and accepted for the selected control and period.',
      },
    });

    expect(reviewed).toEqual({
      requestId: request.requestId,
      status: 'reviewed',
      controlCheckId: reviewCheck.checkId,
      nextReverificationAt: reviewCheck.freshUntil,
    });
    const reviewedRows = await harness.db
      .select()
      .from(complianceControlRequests)
      .where(eq(complianceControlRequests.id, request.requestId));
    expect(reviewedRows[0]).toMatchObject({
      status: 'reviewed',
      reviewControlCheckId: reviewCheck.checkId,
      reviewNote: 'The fulfilled evidence was reviewed and accepted for the selected control and period.',
      reviewedByActorType: 'agent',
      reviewedByActorId: fixture.sessionId,
    });
    expect(reviewedRows[0]?.reviewedAt).toBeInstanceOf(Date);
    expect(reviewedRows[0]?.nextReverificationAt).toBeInstanceOf(Date);

    readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
    });
    const reviewedControl = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(reviewedControl?.outcome).toBe('passed');
    expect(reviewedControl?.actionRequests[0]).toEqual(expect.objectContaining({
      id: request.requestId,
      status: 'reviewed',
      reviewControlCheckId: reviewCheck.checkId,
      reviewedAt: expect.any(String),
      nextReverificationAt: reviewCheck.freshUntil,
    }));
  });

  it('keeps insufficient request reviews actionable and allows a corrected fulfillment', async () => {
    const fixture = await seed();
    const service = new ComplianceControlRequestService(harness.db, () => new Date('2026-06-22T12:00:00.000Z'));
    const request = await service.record({
      ...fixture,
      input: {
        frameworkKey: 'soc2',
        controlId: 'CC6.1',
        requestType: 'evidence',
        priority: 'high',
        title: 'Upload scoped access review export',
        reason: 'The agent needs a scoped access review export with owner and observation period fields.',
        requestedEvidence: ['scoped access review export'],
      },
    });
    const [mappedEvidence] = await harness.db.insert(complianceEvidenceItems).values({
      organizationId: fixture.organizationId,
      scopeId: fixture.scopeId,
      title: 'Partial access review',
      sourceType: 'user_upload',
      evidenceType: 'access_review',
      artifact: {
        fileName: 'partial-access-review.csv',
        mimeType: 'text/csv',
        sizeBytes: 64,
        sha256: 'c'.repeat(64),
        storageRef: 'org-1/partial-access-review.csv',
        sourceRef: 'upload:partial-access-review.csv',
      },
    }).returning({ id: complianceEvidenceItems.id });
    await harness.db.insert(complianceEvidenceMappings).values({
      organizationId: fixture.organizationId,
      evidenceItemId: mappedEvidence!.id,
      frameworkKey: 'soc2',
      controlId: 'CC6.1',
      mappingSource: 'user_declared',
      rationale: 'Uploaded to fulfill the agent request.',
    });
    await service.fulfill({
      userId: fixture.userId,
      organizationId: fixture.organizationId,
      requestId: request.requestId,
      input: { evidenceItemId: mappedEvidence!.id },
    });
    const checkService = new ComplianceControlCheckService(harness.db, () => new Date('2026-06-22T12:05:00.000Z'));
    const reviewCheck = await checkService.record({
      ...fixture,
      workspaceDir,
      input: {
        frameworkKey: 'soc2',
        controlId: 'CC6.1',
        basis: 'agent_reviewed_user_evidence',
        verdict: 'needs_context',
        reasonCode: 'insufficient_evidence',
        reason: 'The access review export is mapped but does not include the observation period or system boundary.',
        proofObligationId: 'evidence-review:soc2:cc6.1',
        evidenceRefs: [`compliance-evidence:${mappedEvidence!.id}`],
        targetRef: 'uploaded partial access review evidence',
        method: 'agent review of uploaded compliance evidence',
        limitations: ['The evidence did not identify the covered application boundary.'],
        proof: {
          claim: 'The uploaded evidence is relevant but incomplete for the selected SOC 2 access control.',
          evidenceIds: [`compliance-evidence:${mappedEvidence!.id}`],
          replayAttempted: false,
          notReplayedReason: 'document_evidence_review',
        },
      },
    });

    const reviewed = await service.review({
      actorId: fixture.sessionId,
      actorType: 'agent',
      organizationId: fixture.organizationId,
      runId: fixture.runId,
      requestId: request.requestId,
      input: {
        outcome: 'insufficient',
        controlCheckId: reviewCheck.checkId,
        note: 'The uploaded evidence was relevant but missing observation period and boundary fields.',
      },
    });

    expect(reviewed).toMatchObject({
      requestId: request.requestId,
      status: 'insufficient',
      controlCheckId: reviewCheck.checkId,
      nextReverificationAt: null,
    });
    let readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
    });
    let control = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control?.outcome).toBe('needs_action');
    expect(control?.nextAction).toContain('last review found the evidence insufficient');

    const corrected = await service.fulfill({
      userId: fixture.userId,
      organizationId: fixture.organizationId,
      requestId: request.requestId,
      input: {
        evidenceItemId: mappedEvidence!.id,
        note: 'Re-uploaded with the missing metadata fields.',
      },
    });
    expect(corrected.status).toBe('fulfilled');
    readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
    });
    control = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control?.actionRequests[0]).toEqual(expect.objectContaining({
      id: request.requestId,
      status: 'fulfilled',
      fulfillmentNote: 'Re-uploaded with the missing metadata fields.',
    }));
  });

  it('keeps review history immutable and removes rejected or retest-required checks from readiness eligibility', async () => {
    const fixture = await seed();
    const checkService = new ComplianceControlCheckService(harness.db);
    const reviewService = new ComplianceControlCheckReviewService(harness.db);
    const recorded = await checkService.record({ ...fixture, workspaceDir, input });
    await expect(reviewService.recordReview({
      organizationId: randomUUID(),
      runId: fixture.runId,
      checkId: recorded.checkId,
      reviewerUserId: fixture.userId,
      input: {
        decision: 'rejected',
        reasonCode: 'evidence_mismatch',
        note: 'A cross-tenant reviewer must not be able to mutate this check.',
      },
    })).resolves.toBeNull();
    await expect(reviewService.recordReview({
      organizationId: fixture.organizationId,
      runId: randomUUID(),
      checkId: recorded.checkId,
      reviewerUserId: fixture.userId,
      input: {
        decision: 'rejected',
        reasonCode: 'evidence_mismatch',
        note: 'A different run must not be able to mutate this check.',
      },
    })).resolves.toBeNull();

    await reviewService.recordReview({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
      checkId: recorded.checkId,
      reviewerUserId: fixture.userId,
      input: {
        decision: 'rejected',
        reasonCode: 'unsupported_reasoning',
        note: 'The evidence does not cover the complete authorization boundary.',
      },
    });
    let readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
    });
    let control = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control?.verdict).not.toBe('pass');
    expect(control?.controlChecks[0]).toMatchObject({
      reviewStatus: 'rejected',
      eligible: false,
    });

    await reviewService.recordReview({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
      checkId: recorded.checkId,
      reviewerUserId: fixture.userId,
      input: {
        decision: 'confirmed',
        reasonCode: 'proof_valid',
        note: 'The replay and exact evidence satisfy the authored proof obligation.',
      },
    });
    readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
    });
    const confirmedReadiness = readiness;
    control = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control?.verdict).toBe('pass');
    expect(control?.controlChecks[0]).toMatchObject({
      reviewStatus: 'confirmed',
      eligible: true,
    });

    await reviewService.recordReview({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
      checkId: recorded.checkId,
      reviewerUserId: fixture.userId,
      input: {
        decision: 'retest_required',
        reasonCode: 'retest_after_remediation',
        note: 'The target changed after remediation and needs a fresh replay.',
      },
    });
    readiness = await new ComplianceReadinessService(harness.db).getRunReadiness({
      organizationId: fixture.organizationId,
      runId: fixture.runId,
    });
    control = readiness.frameworks[0]?.controls.find((item) => item.id === 'CC6.1');
    expect(control?.verdict).not.toBe('pass');
    expect(control?.controlChecks[0]).toMatchObject({
      reviewStatus: 'retest_required',
      eligible: false,
      reviewHistory: expect.arrayContaining([
        expect.objectContaining({ decision: 'rejected' }),
        expect.objectContaining({ decision: 'confirmed' }),
        expect.objectContaining({ decision: 'retest_required' }),
      ]),
    });
    expect(
      await harness.db
        .select()
        .from(complianceControlCheckReviews)
        .where(eq(complianceControlCheckReviews.checkId, recorded.checkId)),
    ).toHaveLength(3);
    expect(
      await harness.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'compliance.control_check.reviewed')),
    ).toHaveLength(3);

    await fs.rm(workspaceDir, { recursive: true, force: true });

    const bundle = await new ComplianceRunBundleService(harness.db, {
      now: () => new Date('2026-06-22T12:00:00.000Z'),
    }).getRunBundleEntries(
      {
        id: fixture.runId,
        organizationId: fixture.organizationId,
        scopeId: fixture.scopeId,
        status: 'completed',
      },
      [fixture.sessionId],
      [{
        path: `closeout/${fixture.sessionId}/.artifacts/report/context.json`,
        content: JSON.stringify({ complianceReadiness: confirmedReadiness }),
      }],
    );
    const paths = bundle.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining([
      'compliance/readiness-at-closeout.json',
      'compliance/readiness-current.json',
      'compliance/control-checks.json',
      'compliance/reviews.json',
      'compliance/evidence-manifest.json',
      'compliance/drift.json',
    ]));
    const closeout = JSON.parse(String(
      bundle.find((entry) => entry.path === 'compliance/readiness-at-closeout.json')?.content,
    ));
    expect(closeout.bundleSnapshot).toEqual(expect.objectContaining({
      source: 'closeout_artifact',
      fallback: false,
    }));
    expect(paths.some((entryPath) => entryPath.startsWith('compliance/evidence/'))).toBe(true);
    const manifest = JSON.parse(String(
      bundle.find((entry) => entry.path === 'compliance/evidence-manifest.json')?.content,
    ));
    expect(manifest).toMatchObject({ resolved: 1, unresolved: 0 });
    expect(manifest.items[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.items[0].files[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
    const drift = JSON.parse(String(
      bundle.find((entry) => entry.path === 'compliance/drift.json')?.content,
    ));
    expect(drift.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'verdict_changed', controlId: 'CC6.1' }),
    ]));
  });

  it('exports uploaded compliance evidence refs into the portable compliance bundle', async () => {
    const fixture = await seed();
    const evidenceRoot = path.resolve(process.cwd(), 'storage', 'compliance-evidence');
    const evidenceDir = path.join(evidenceRoot, fixture.organizationId);
    const evidenceContent = Buffer.from('user,role\nanalyst,read-only\n', 'utf8');
    const storageRef = `${fixture.organizationId}/access-review.csv`;
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, 'access-review.csv'), evidenceContent);

    try {
      const [evidence] = await harness.db.insert(complianceEvidenceItems).values({
        organizationId: fixture.organizationId,
        scopeId: fixture.scopeId,
        title: 'Access review export',
        sourceType: 'user_upload',
        evidenceType: 'access_review',
        artifact: {
          fileName: 'access-review.csv',
          mimeType: 'text/csv',
          sizeBytes: evidenceContent.length,
          sha256: createHash('sha256').update(evidenceContent).digest('hex'),
          storageRef,
          sourceRef: 'uploaded:access-review.csv',
        },
      }).returning({ id: complianceEvidenceItems.id });
      await harness.db.insert(complianceEvidenceMappings).values({
        organizationId: fixture.organizationId,
        scopeId: fixture.scopeId,
        evidenceItemId: evidence!.id,
        frameworkKey: 'soc2',
        controlId: 'CC6.1',
        mappingSource: 'user_declared',
        confidence: 'high',
        rationale: 'Uploaded access review evidence for CC6.1.',
      });

      await new ComplianceControlCheckService(
        harness.db,
        () => new Date('2026-06-22T12:00:00.000Z'),
      ).record({
        ...fixture,
        workspaceDir,
        input: {
          ...input,
          basis: 'agent_reviewed_user_evidence',
          proofObligationId: 'evidence-review:soc2:cc6.1',
          method: 'agent evidence review',
          evidenceRefs: [`compliance-evidence:${evidence!.id}`],
          proof: {
            claim: 'Uploaded access review evidence was inspected for CC6.1.',
            evidenceIds: [`compliance-evidence:${evidence!.id}`],
            replayAttempted: false,
            notReplayedReason: 'document_evidence_review',
          },
        },
      });

      await fs.rm(workspaceDir, { recursive: true, force: true });
      const bundle = await new ComplianceRunBundleService(harness.db, {
        now: () => new Date('2026-06-22T12:00:00.000Z'),
      }).getRunBundleEntries(
        {
          id: fixture.runId,
          organizationId: fixture.organizationId,
          scopeId: fixture.scopeId,
          status: 'completed',
        },
        [fixture.sessionId],
        [],
      );

      const manifest = JSON.parse(String(
        bundle.find((entry) => entry.path === 'compliance/evidence-manifest.json')?.content,
      ));
      expect(manifest).toMatchObject({ total: 1, resolved: 1, unresolved: 0 });
      expect(manifest.items[0]).toMatchObject({
        reference: `compliance-evidence:${evidence!.id}`,
        sourceType: 'compliance_evidence',
        sourceRef: `compliance-evidence:${evidence!.id}`,
        resolutionStatus: 'resolved',
      });
      const evidenceEntry = bundle.find((entry) => entry.path.endsWith('/access-review.csv'));
      expect(evidenceEntry?.content).toEqual(evidenceContent);
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it('exports bare HTTP history evidence refs into the portable compliance bundle from trace', async () => {
    const fixture = await seed();
    const historyId = '02703400-8e98-4a10-b711-3eaa069c41d2';
    await appendHttpHistoryEntry(workspaceDir, {
      id: historyId,
      ts: '2026-06-22T12:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://api.example.com/admin',
        headers: { authorization: 'Bearer secret', accept: 'application/json' },
      },
      success: true,
      status_code: 401,
      response_time_ms: 42,
      body_size: 27,
      body_truncated: false,
      body_preview: '{"message":"Unauthorized"}',
      response_body: '{"message":"Unauthorized"}',
      response_headers: 'HTTP/1.1 401 Unauthorized\r\nserver: test\r\n',
    });

    await new ComplianceControlCheckService(
      harness.db,
      () => new Date('2026-06-22T12:00:00.000Z'),
    ).record({
      ...fixture,
      workspaceDir,
      input: {
        ...input,
        evidenceRefs: [historyId],
        proof: {
          ...input.proof,
          evidenceIds: [historyId],
          replayArtifact: historyId,
        },
      },
    });
    await fs.rm(workspaceDir, { recursive: true, force: true });

    const bundle = await new ComplianceRunBundleService(harness.db, {
      now: () => new Date('2026-06-22T12:00:00.000Z'),
    }).getRunBundleEntries(
      {
        id: fixture.runId,
        organizationId: fixture.organizationId,
        scopeId: fixture.scopeId,
        status: 'completed',
      },
      [fixture.sessionId],
      [],
      {
        runId: fixture.runId,
        sessionIds: [fixture.sessionId],
        generatedAt: '2026-06-22T12:05:00.000Z',
        total: 1,
        stats: {} as never,
        summary: {} as never,
        pagination: { offset: 0, limit: 1, hasMore: false },
        integrity: { status: 'complete', sessions: [] },
        events: [{
          id: 'trace-1',
          ts: '2026-06-22T12:00:00.000Z',
          event: 'tool.finish',
          severity: 'info',
          sessionId: fixture.sessionId,
          turn: 1,
          payload: {
            toolName: 'http_payload',
            result: {
              url: 'https://api.example.com/admin',
              method: 'GET',
              status_code: 401,
              body_size: 27,
              body_preview: '{"message":"Unauthorized"}',
              response_time_ms: 42,
              interesting_headers: { server: 'test' },
              history_entry_id: historyId,
            },
          },
        }],
      },
    );

    const manifest = JSON.parse(String(
      bundle.find((entry) => entry.path === 'compliance/evidence-manifest.json')?.content,
    ));
    expect(manifest).toMatchObject({ total: 1, resolved: 1, unresolved: 0 });
    expect(manifest.items[0]).toMatchObject({
      reference: historyId,
      sourceType: 'http_history',
      sourceRef: `http-history:${historyId}`,
      resolutionStatus: 'resolved',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const evidenceEntry = bundle.find((entry) => entry.path.startsWith('compliance/evidence/'));
    expect(evidenceEntry?.path).toMatch(/http-exchange-/u);
    const evidenceJson = JSON.parse(String(evidenceEntry?.content));
    expect(evidenceJson).toMatchObject({
      historyEntryId: historyId,
      url: 'https://api.example.com/admin',
      method: 'GET',
      statusCode: 401,
      responseHeaders: { server: 'test' },
    });
  });
});
