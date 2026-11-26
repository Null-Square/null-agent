import { describe, expect, it, vi } from 'vitest';

import {
  RunReportStateLoader,
  type FinalizerFindingRow,
} from '@/domains/security-ops/tools/reporting/RunReportStateLoader';
import { RunReportRenderer } from '@/domains/security-ops/tools/reporting/RunReportRenderer';

const createQueuedDb = (results: unknown[][]) => {
  const chains: Array<{
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  }> = [];
  const db = {
    select: vi.fn(() => {
      const rows = results.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(async () => rows),
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      chains.push(chain);
      return chain;
    }),
  };
  return { db, chains };
};

const baseFinding = (overrides: Partial<FinalizerFindingRow>): FinalizerFindingRow => ({
  id: 'finding-1',
  assetId: 'asset-1',
  title: 'SQL injection',
  severity: 'high',
  state: 'confirmed',
  summary: 'SQL injection summary',
  businessImpact: 'Business impact',
  technicalAnalysis: 'Technical analysis',
  pocDescription: 'Proof of concept',
  pocScriptCode: null,
  assumptions: 'Assumptions',
  fixEffort: 'medium',
  remediation: 'Use parameterized queries.',
  cvssVector: null,
  cvssScore: null,
  confidenceScore: 0.9,
  cweId: 'CWE-89',
  cveId: null,
  cweIds: ['CWE-89'],
  cveIds: null,
  owaspCategory: 'A03:2021-Injection',
  endpointId: null,
  serviceId: null,
  codeLocations: null,
  firstSeenAt: new Date('2026-06-11T00:00:00.000Z'),
  lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
  dedupeKey: 'dedupe-1',
  ...overrides,
});

describe('RunReportStateLoader', () => {
  it('assembles finalizer report state with notes, evidence, and completion blockers', async () => {
    const validatedFinding = baseFinding({ id: 'finding-validated' });
    const candidateFinding = baseFinding({
      id: 'finding-candidate',
      title: 'Reflected XSS',
      severity: 'medium',
      state: 'potential',
      dedupeKey: 'dedupe-2',
    });
    const { db, chains } = createQueuedDb([
      [
        {
          id: 'phase-1',
          phaseKey: 'discovery',
          status: 'completed',
          sessionId: 'session-1',
          lastError: null,
        },
      ],
      [
        { findingId: 'finding-validated' },
        { findingId: 'finding-candidate' },
      ],
      [validatedFinding, candidateFinding],
      [
        {
          ntype: 'run.digest',
          title: 'Run digest',
          data: {
            outcome: 'partial',
            completed_tasks: ['Mapped target'],
            blocked_tasks: [],
            next_prerequisites: ['Promote candidate'],
          },
          evidence: [],
          lastSeenAt: new Date('2026-06-12T00:00:00.000Z'),
        },
      ],
      [
        {
          findingId: 'finding-validated',
          kind: 'artifact',
          path: '.artifacts/sql.txt',
          displayPath: '.artifacts/sql.txt',
          label: 'SQL proof',
          excerpt: 'payload caused SQL error',
          fileMissing: false,
          data: null,
          createdAt: new Date('2026-06-12T00:00:00.000Z'),
        },
        {
          findingId: 'finding-candidate',
          kind: 'http_exchange',
          path: 'http-exchange:finding-candidate',
          displayPath: 'HTTP exchange',
          label: 'XSS proof',
          excerpt: null,
          fileMissing: true,
          data: {
            request: { method: 'GET', url: 'https://app.example.test/?q=xss' },
            response: { statusCode: 200, body: '<script>alert(1)</script>' },
          },
          createdAt: new Date('2026-06-12T00:00:00.000Z'),
        },
      ],
      [
        {
          findingId: 'finding-validated',
          evidenceRefs: [
            {
              kind: 'validation_proof',
              path: 'validation-proof:finding-validated:2026-06-12T00:00:00.000Z',
              label: 'Validation proof trail',
              schemaVersion: 1,
              proof: {
                claim: 'SQL injection is reproducible on the search parameter.',
                evidenceIds: ['.artifacts/sql.txt'],
                replayAttempted: true,
                replayArtifact: '.artifacts/python-session/run/results/replay.json',
                replayReproduced: true,
              },
              obligations: [
                {
                  id: 'primary-observable',
                  observable: 'Payload changes SQL behavior.',
                  status: 'proven',
                  evidenceIds: ['.artifacts/sql.txt'],
                },
              ],
              advisoryTriage: {
                verdict: 'agree',
                reason: 'Proof is bound to durable evidence.',
                triagedBy: 'inline_validation_advisory',
                evidenceIds: ['.artifacts/sql.txt'],
                flags: [],
              },
            },
          ],
        },
      ],
    ]);
    const loader = new RunReportStateLoader(db as never, new RunReportRenderer());

    const state = await loader.buildReportState({
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      runId: 'run-1',
      // A report-time repair touched only the first Risk. The loader must keep
      // the second Risk because run evidence still binds it to this run.
      reportedFindingIds: ['finding-validated'],
      plan: [{ id: 'step-1', title: 'Discovery', status: 'completed' }],
    });

    expect(db.select).toHaveBeenCalledTimes(6);
    expect(chains[3]?.limit).toHaveBeenCalledWith(500);
    expect(state.findings).toHaveLength(2);
    expect(state.findings[0]?.evidence).toHaveLength(1);
    expect(state.findings[0]?.validationProof?.proof.claim).toContain('SQL injection is reproducible');
    expect(state.findings[1]?.evidence?.[0]?.kind).toBe('http_exchange');
    expect(state.notes).toHaveLength(1);
    expect(state.coverage.runDigest?.completedTasks).toEqual(['Mapped target']);
    expect(state.runCompletion.state).toBe('not_ready');
    expect(state.runCompletion.unresolvedPromotableFindings).toEqual([
      {
        id: 'finding-candidate',
        title: 'Reflected XSS',
        severity: 'medium',
      },
    ]);
    expect(loader.finalizerFindingHasDurableEvidence(state.findings[0]!)).toBe(true);
    expect(
      loader.finalizerFindingHasDurableEvidence({
        ...state.findings[0]!,
        evidence: [{ ...state.findings[0]!.evidence![0]!, fileMissing: true }],
      }),
    ).toBe(false);
  });
});
