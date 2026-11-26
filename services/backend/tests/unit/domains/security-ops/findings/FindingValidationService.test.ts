import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  corsValidationBlockers,
  FindingValidationService,
} from '@/domains/security-ops/findings/FindingValidationService';

const createQuery = (rows: unknown[]) => {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => rows),
    then: vi.fn(
      (
        resolve: (value: unknown[]) => unknown,
        reject: (reason?: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    ),
  };
  return query;
};

const createUpdate = () => {
  const update = {
    set: vi.fn(() => update),
    where: vi.fn(async () => undefined),
  };
  return update;
};

const createInsert = () => {
  const insert = {
    values: vi.fn((_value?: unknown) => insert),
    onConflictDoNothing: vi.fn(async () => undefined),
  };
  return insert;
};

const findingRow = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Cross-tenant invoice access',
  severity: 'high',
  summary: 'Invoice endpoint serves another tenant object.',
  dedupeKey: 'dedupe-1',
  state: 'verifying',
  lifecycleVersion: 1,
  organizationId: 'org-1',
  businessImpact: 'Impact',
  technicalAnalysis: 'Analysis',
  pocDescription: 'PoC',
  assumptions: 'Assumptions',
  remediation: 'Fix',
  fixEffort: 'medium',
  cweId: 'CWE-639',
  cweIds: ['CWE-639'],
  owaspCategory: 'A01:2021-Broken Access Control',
  cvssVector: null,
  cvssScore: null,
  ...overrides,
});

const makeService = (db: unknown, overrides: Partial<ConstructorParameters<typeof FindingValidationService>[1]> = {}) =>
  new FindingValidationService(db as never, {
    now: () => new Date('2026-06-12T00:00:00.000Z'),
    normalizeSessionId: (value) => value,
    normalizeToolText: (value) => value.trim(),
    resolveFindingEvidenceEntries: vi.fn(async () => []),
    hasDurableFindingEvidence: () => false,
    emitRunSystemEvent: vi.fn(async () => undefined),
    ...overrides,
  });

describe('FindingValidationService', () => {
  it('blocks CORS validation based on reflected headers and an unauthenticated raw response', () => {
    const blockers = corsValidationBlockers({
      title: 'Wildcard-subdomain CORS with credentials',
      summary: 'The API reflects Origin and sends Access-Control-Allow-Credentials.',
      proofBundle: {
        schemaVersion: 1,
        proof: {
          claim: 'The server reflects the supplied origin header.',
          evidenceIds: ['http:cors-401'],
          replayAttempted: true,
          replayArtifact: 'http:cors-401',
          replayReproduced: true,
        },
        obligations: [{
          id: 'primary-observable',
          observable: 'Origin reflection appears on a 401 response.',
          status: 'proven',
          evidenceIds: ['http:cors-401'],
        }],
        advisoryTriage: {
          verdict: 'agree',
          reason: 'Headers reproduced.',
          triagedBy: 'validator',
          evidenceIds: ['http:cors-401'],
          flags: [],
        },
      },
      evidence: [{
        kind: 'http_exchange',
        data: {
          source: 'request_tool',
          request: {
            method: 'GET',
            url: 'https://api.example.test/private',
            headers: [{ name: 'Origin', value: 'https://evil.example.test' }],
          },
          response: {
            statusCode: 401,
            headers: [
              { name: 'Access-Control-Allow-Origin', value: 'https://evil.example.test' },
              { name: 'Access-Control-Allow-Credentials', value: 'true' },
            ],
            body: { text: '{"error":"unauthorized"}', truncated: false },
          },
        },
      }],
    });

    expect(blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('browser HTTP exchange'),
      expect.stringContaining('protected evaluator data'),
      expect.stringContaining('ambient browser authority'),
    ]));
  });

  it('accepts reproduced browser proof of protected evaluator data with ambient authority', () => {
    const blockers = corsValidationBlockers({
      title: 'Credentialed CORS exposes account profile',
      summary: 'A foreign origin reads the evaluator private profile.',
      proofBundle: {
        schemaVersion: 1,
        proof: {
          claim: 'A foreign browser origin read protected evaluator account data with ambient credentials.',
          evidenceIds: ['http:cors-browser'],
          replayAttempted: true,
          replayArtifact: 'http:cors-browser',
          replayReproduced: true,
        },
        obligations: [{
          id: 'cors-read',
          observable: 'The foreign browser reads authenticated private profile data.',
          status: 'proven',
          evidenceIds: ['http:cors-browser'],
        }],
        advisoryTriage: {
          verdict: 'agree',
          reason: 'Browser replay reproduced the private read.',
          triagedBy: 'validator',
          evidenceIds: ['http:cors-browser'],
          flags: [],
        },
      },
      evidence: [{
        kind: 'http_exchange',
        data: {
          source: 'browser',
          request: {
            method: 'GET',
            url: 'https://api.example.test/profile',
            headers: [
              { name: 'Origin', value: 'https://evil.example.test' },
              { name: 'Cookie', value: '[REDACTED]', redacted: true },
            ],
          },
          response: {
            statusCode: 200,
            headers: [
              { name: 'Access-Control-Allow-Origin', value: 'https://evil.example.test' },
              { name: 'Access-Control-Allow-Credentials', value: 'true' },
            ],
            body: { text: '{"email":"evaluator@example.test"}', truncated: false },
          },
        },
      }],
    });

    expect(blockers).toEqual([]);
  });

  it('blocks the same credentialed exchange when its source is request_tool instead of browser', () => {
    const exchange = {
      request: {
        method: 'GET',
        url: 'https://api.example.test/profile',
        headers: [
          { name: 'Origin', value: 'https://evil.example.test' },
          { name: 'Cookie', value: '[REDACTED]', redacted: true },
        ],
      },
      response: {
        statusCode: 200,
        headers: [
          { name: 'Access-Control-Allow-Origin', value: 'https://evil.example.test' },
          { name: 'Access-Control-Allow-Credentials', value: 'true' },
        ],
        body: { text: '{"email":"evaluator@example.test"}', truncated: false },
      },
    };
    const proofBundle = {
      schemaVersion: 1 as const,
      proof: {
        claim: 'A foreign browser origin read protected evaluator account data with ambient credentials.',
        evidenceIds: ['http:cors-browser'],
        replayAttempted: true,
        replayArtifact: 'http:cors-browser',
        replayReproduced: true,
      },
      obligations: [{
        id: 'cors-read',
        observable: 'The foreign browser reads authenticated private profile data.',
        status: 'proven' as const,
        evidenceIds: ['http:cors-browser'],
      }],
      advisoryTriage: {
        verdict: 'agree' as const,
        reason: 'Browser replay reproduced the private read.',
        triagedBy: 'validator',
        evidenceIds: ['http:cors-browser'],
        flags: [],
      },
    };
    const base = {
      title: 'Credentialed CORS exposes account profile',
      summary: 'A foreign origin reads the evaluator private profile.',
      proofBundle,
    };

    expect(corsValidationBlockers({
      ...base,
      evidence: [{ kind: 'http_exchange', data: { ...exchange, source: 'browser' } }],
    })).toEqual([]);

    const blockers = corsValidationBlockers({
      ...base,
      evidence: [{ kind: 'http_exchange', data: { ...exchange, source: 'request_tool' } }],
    });
    expect(blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('browser HTTP exchange'),
    ]));
  });

  it('moves a potential Risk to verifying when durable evidence exists', async () => {
    const update = createUpdate();
    const eventInsert = createInsert();
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(createQuery([
          {
            id: '11111111-1111-4111-8111-111111111111',
            title: 'SQL injection',
            severity: 'high',
            dedupeKey: 'dedupe-1',
            state: 'potential',
            lifecycleVersion: 1,
            organizationId: 'org-1',
            businessImpact: 'Impact',
            technicalAnalysis: 'Analysis',
            pocDescription: 'PoC',
            assumptions: 'Assumptions',
            remediation: 'Fix',
            fixEffort: 'medium',
            cweId: 'CWE-89',
            cweIds: ['CWE-89'],
            owaspCategory: 'A03:2021-Injection',
            cvssVector: null,
            cvssScore: null,
          },
        ]))
        .mockReturnValueOnce(createQuery([
          {
            kind: 'artifact',
            path: '.artifacts/sql.txt',
            displayPath: '.artifacts/sql.txt',
            label: 'SQL proof',
            fileMissing: false,
          },
        ]))
        .mockReturnValueOnce(createQuery([])),
      update: vi.fn(() => update),
      insert: vi.fn(() => eventInsert),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const service = makeService(db);

    const result = await service.promoteFinding({
      userId: 'user-1',
      organizationId: 'org-1',
      input: {
        findingId: '11111111-1111-4111-8111-111111111111',
        rationale: 'Durable proof exists',
      },
    });

    expect(result).toMatchObject({
      findingId: '11111111-1111-4111-8111-111111111111',
      state: 'verifying',
      action: 'queued',
      durableEvidenceCount: 1,
    });
    expect(update.set).toHaveBeenCalledWith({
      state: 'verifying',
      lifecycleVersion: 2,
      updatedAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    expect(eventInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        findingId: '11111111-1111-4111-8111-111111111111',
        type: 'state_changed',
      }),
    );
  });

  it('refuses validation outcomes without a proof claim', async () => {
    const db = { transaction: vi.fn() };
    const service = makeService(db);

    await expect(
      service.submitValidationOutcome({
        userId: 'user-1',
        workspaceDir: 'C:/workspace',
        sessionId: '22222222-2222-4222-8222-222222222222',
        organizationId: 'org-1',
        input: {
          findingId: '11111111-1111-4111-8111-111111111111',
          outcome: 'validated',
          reason: 'Reproduced.',
          proof: {
            evidenceIds: ['.artifacts/repro.txt'],
          },
        },
      }),
    ).rejects.toThrow(/claim/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('refuses validation outcomes without evidence IDs or an escape reason', async () => {
    const db = { transaction: vi.fn() };
    const service = makeService(db);

    await expect(
      service.submitValidationOutcome({
        userId: 'user-1',
        workspaceDir: 'C:/workspace',
        sessionId: '22222222-2222-4222-8222-222222222222',
        organizationId: 'org-1',
        input: {
          findingId: '11111111-1111-4111-8111-111111111111',
          outcome: 'inconclusive',
          reason: 'Could not decide.',
          proof: {
            claim: 'The invoice endpoint may expose another tenant object.',
          },
        },
      }),
    ).rejects.toThrow(/evidenceIds/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('stores validation proof, replay link, obligations, and advisory triage on validated outcomes', async () => {
    const update = createUpdate();
    const inserts: ReturnType<typeof createInsert>[] = [];
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(createQuery([findingRow()]))
        .mockReturnValueOnce(createQuery([
          {
            kind: 'artifact',
            path: '.artifacts/repro.txt',
            displayPath: '.artifacts/repro.txt',
            label: 'reproduction artifact',
            fileMissing: false,
            sessionId: '22222222-2222-4222-8222-222222222222',
          },
        ]))
        .mockReturnValueOnce(createQuery([])),
      update: vi.fn(() => update),
      insert: vi.fn(() => {
        const insert = createInsert();
        inserts.push(insert);
        return insert;
      }),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const service = makeService(db, {
      resolveFindingEvidenceEntries: vi.fn(async () => [
        {
          kind: 'artifact' as const,
          path: '.artifacts/repro.txt',
          displayPath: '.artifacts/repro.txt',
          label: 'reproduction artifact',
        },
      ]),
      hasDurableFindingEvidence: () => true,
    });

    const result = await service.submitValidationOutcome({
      userId: 'user-1',
      workspaceDir: 'C:/workspace',
      sessionId: '22222222-2222-4222-8222-222222222222',
      organizationId: 'org-1',
      runId: 'run-1',
      input: {
        findingId: '11111111-1111-4111-8111-111111111111',
        outcome: 'validated',
        reason: 'Fresh request reproduced cross-tenant access.',
        evidence: [{ path: '.artifacts/repro.txt', label: 'reproduction artifact' }],
        proof: {
          claim: 'The invoice endpoint serves another tenant invoice.',
          evidenceIds: ['.artifacts/repro.txt'],
          replayAttempted: true,
          replayArtifact: '.artifacts/python-session/run/results/replay.json',
          replayReproduced: true,
        },
        proofObligations: [
          {
            observable: 'Response body contains another tenant invoice.',
            status: 'proven',
            evidenceIds: ['.artifacts/repro.txt'],
          },
        ],
        advisoryTriage: {
          verdict: 'agree',
          reason: 'Bound replay evidence supports the claim.',
          flags: [],
        },
      },
    });

    expect(result).toMatchObject({
      outcome: 'validated',
      state: 'confirmed',
      validationProof: {
        proof: {
          claim: 'The invoice endpoint serves another tenant invoice.',
          replayReproduced: true,
        },
        advisoryTriage: {
          verdict: 'agree',
          triagedBy: 'inline_validation_advisory',
        },
      },
    });
    const auditInsert = inserts.find((insert) =>
      insert.values.mock.calls.some(([value]) =>
        typeof value === 'object' && value !== null && Array.isArray((value as { evidenceRefs?: unknown }).evidenceRefs),
      ),
    );
    expect(auditInsert?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({
            kind: 'validation_proof',
            proof: expect.objectContaining({
              claim: 'The invoice endpoint serves another tenant invoice.',
            }),
          }),
        ]),
      }),
    );
  });

  it('accepts normal HTTP history IDs as validation proof evidence refs', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-validation-proof-'));
    const historyId = 'authz-replay-history-1';
    await fs.writeFile(
      path.join(workspaceDir, '.http-history.ndjson'),
      JSON.stringify({
        id: historyId,
        ts: '2026-06-19T00:00:00.000Z',
        request: {
          method: 'GET',
          url: 'https://target.test/api/invoices/123',
          headers: {},
        },
        success: true,
        status_code: 200,
        response_time_ms: 42,
        body_size: 16,
        body_truncated: false,
        body_preview: '{"id":"123"}',
        response_body: '{"id":"123"}',
        response_headers: 'content-type: application/json',
        replayed_from: 'baseline-history-id',
      }) + '\n',
      'utf8',
    );

    try {
      const update = createUpdate();
      const tx = {
        select: vi
          .fn()
          .mockReturnValueOnce(createQuery([findingRow()]))
          .mockReturnValueOnce(createQuery([
            {
              kind: 'http_exchange',
              path: 'http:attached-proof',
              displayPath: 'GET https://target.test/api/invoices/123',
              label: 'baseline attached proof',
              fileMissing: false,
              sessionId: '22222222-2222-4222-8222-222222222222',
            },
          ]))
          .mockReturnValueOnce(createQuery([])),
        update: vi.fn(() => update),
        insert: vi.fn(() => createInsert()),
      };
      const db = {
        transaction: vi.fn(async (callback) => callback(tx)),
      };
      const service = makeService(db);

      const result = await service.submitValidationOutcome({
        userId: 'user-1',
        workspaceDir,
        sessionId: '22222222-2222-4222-8222-222222222222',
        organizationId: 'org-1',
        input: {
          findingId: '11111111-1111-4111-8111-111111111111',
          outcome: 'validated',
          reason: 'Authorization replay reproduced the baseline response with another persona.',
          proof: {
            claim: 'The invoice endpoint serves another tenant invoice to an unauthorized persona.',
            evidenceIds: [historyId],
            replayAttempted: true,
            replayArtifact: historyId,
            replayReproduced: true,
          },
        },
      });

      expect(result).toMatchObject({
        outcome: 'validated',
        state: 'confirmed',
        validationProof: {
          proof: {
            evidenceIds: [historyId],
            replayReproduced: true,
          },
        },
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('keeps non-replayable validated findings reportable when an escape reason is recorded', async () => {
    const update = createUpdate();
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(createQuery([findingRow({ title: 'One-time account deletion authorization bypass' })]))
        .mockReturnValueOnce(createQuery([
          {
            kind: 'artifact',
            path: '.artifacts/delete-proof.txt',
            displayPath: '.artifacts/delete-proof.txt',
            label: 'one-time state change proof',
            fileMissing: false,
            sessionId: '22222222-2222-4222-8222-222222222222',
          },
        ]))
        .mockReturnValueOnce(createQuery([])),
      update: vi.fn(() => update),
      insert: vi.fn(() => createInsert()),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const service = makeService(db, {
      resolveFindingEvidenceEntries: vi.fn(async () => [
        {
          kind: 'artifact' as const,
          path: '.artifacts/delete-proof.txt',
          displayPath: '.artifacts/delete-proof.txt',
          label: 'one-time state change proof',
        },
      ]),
      hasDurableFindingEvidence: () => true,
    });

    const result = await service.submitValidationOutcome({
      userId: 'user-1',
      workspaceDir: 'C:/workspace',
      sessionId: '22222222-2222-4222-8222-222222222222',
      organizationId: 'org-1',
      input: {
        findingId: '11111111-1111-4111-8111-111111111111',
        outcome: 'validated',
        reason: 'Observed the unsafe one-time state change once; replay would be destructive.',
        evidence: [{ path: '.artifacts/delete-proof.txt', label: 'one-time state change proof' }],
        proof: {
          claim: 'A user can trigger another account deletion through the tested request.',
          evidenceIds: [],
          replayAttempted: false,
          notReplayedReason: 'non_idempotent',
        },
      },
    });

    expect(result).toMatchObject({
      outcome: 'validated',
      state: 'confirmed',
      lifecycleStage: 'reportable',
      validationProof: {
        proof: {
          notReplayedReason: 'non_idempotent',
        },
        advisoryTriage: {
          verdict: 'needs_context',
          flags: ['risky_to_replay'],
        },
      },
    });
    expect(update.set).toHaveBeenCalledWith({
      state: 'confirmed',
      lifecycleVersion: 2,
      updatedAt: new Date('2026-06-12T00:00:00.000Z'),
    });
  });
});
