import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getScopeReadiness: vi.fn(),
  listEvidenceItems: vi.fn(),
  listMissingEvidence: vi.fn(),
}));

vi.mock('@/domains/security-ops/compliance/ComplianceReadinessService', () => ({
  ComplianceReadinessService: vi.fn(() => ({
    getScopeReadiness: mocks.getScopeReadiness,
  })),
}));

vi.mock('@/domains/security-ops/compliance/ComplianceEvidenceService', () => ({
  ComplianceEvidenceService: vi.fn(() => ({
    listEvidenceItems: mocks.listEvidenceItems,
    listMissingEvidence: mocks.listMissingEvidence,
  })),
}));

import { ComplianceToolQueryService } from '@/domains/security-ops/compliance/ComplianceToolQueryService';
import {
  COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
  GDPR_READINESS_BOUNDARY_SENTENCE,
} from '@/domains/security-ops/tools/reporting/constants';

describe('ComplianceToolQueryService', () => {
  let tempEvidenceRoot: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env.COMPLIANCE_EVIDENCE_STORAGE_ROOT;
    if (tempEvidenceRoot) {
      await fs.rm(tempEvidenceRoot, { recursive: true, force: true });
      tempEvidenceRoot = null;
    }
  });

  it('filters readiness controls and optionally omits evidence detail', async () => {
    mocks.getScopeReadiness.mockResolvedValue({
      generatedAt: '2026-06-12T00:00:00.000Z',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      selectedFrameworks: [{ key: 'soc2', label: 'SOC 2' }],
      supportedFrameworks: [{ key: 'soc2', label: 'SOC 2' }],
      latestCompletedRunId: 'run-1',
      reportRequest: null,
      frameworks: [
        {
          key: 'soc2',
          label: 'SOC 2',
          selected: true,
          supported: true,
          score: 50,
          statusCounts: {
            missing: 1,
            partial: 0,
            passing: 0,
            failing: 0,
            stale: 0,
            accepted_risk: 0,
            not_applicable: 0,
            not_supported: 0,
          },
          gaps: ['needs evidence'],
          coverageLimitations: [],
          controls: [
            {
              id: 'CC1.1',
              title: 'Control one',
              theme: 'governance',
              supportLevel: 'manual_evidence_required',
              status: 'missing',
              score: 0,
              rationale: 'No evidence',
              gaps: ['upload policy'],
              coverageLimitations: [],
              evidence: [{ id: 'ev-1' }],
            },
            {
              id: 'CC1.2',
              title: 'Control two',
              theme: 'governance',
              supportLevel: 'automated_testable',
              status: 'passing',
              score: 100,
              rationale: 'Covered',
              gaps: [],
              coverageLimitations: [],
              evidence: [],
            },
          ],
        },
      ],
    });
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceReadiness({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      input: {
        framework: 'soc2',
        status: 'missing',
        supportLevel: 'manual_evidence_required',
        includeEvidence: false,
      },
    });

    expect(mocks.getScopeReadiness).toHaveBeenCalledWith({
      organizationId: 'org-1',
      scopeId: 'scope-1',
    });
    expect(result.boundary).toBe(COMPLIANCE_READINESS_BOUNDARY_SENTENCE);
    expect(result.frameworks[0]?.totalControls).toBe(1);
    expect(result.frameworks[0]?.controls[0]).toMatchObject({
      id: 'CC1.1',
      evidenceCount: 1,
    });
    expect(result.frameworks[0]?.controls[0]).not.toHaveProperty('evidence');
  });

  it('returns the GDPR-specific framework boundary when GDPR readiness is requested', async () => {
    mocks.getScopeReadiness.mockResolvedValue({
      generatedAt: '2026-06-12T00:00:00.000Z',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      selectedFrameworks: [{ key: 'gdpr', label: 'GDPR Readiness' }],
      supportedFrameworks: ['gdpr'],
      latestCompletedRunId: 'run-1',
      reportRequest: null,
      scorecards: {
        agentProvenTechnical: { total: 0, passed: 0, failed: 0, needsContext: 0, notAttempted: 0, stale: 0 },
        customerEvidence: { total: 0, approved: 0, missing: 0, stale: 0, integrationRequired: 0, acceptedRisk: 0 },
        outcomes: { passed: 0, failed: 0, needs_action: 0, not_checked: 0, excluded: 0 },
      },
      frameworks: [
        {
          key: 'gdpr',
          label: 'GDPR Readiness',
          selected: true,
          supported: true,
          score: 0,
          statusCounts: {},
          outcomeCounts: {},
          verdictCounts: {},
          gaps: [],
          coverageLimitations: [],
          controls: [],
        },
      ],
    });
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceReadiness({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      input: { framework: 'gdpr' },
    });

    expect(result.boundary).toBe(COMPLIANCE_READINESS_BOUNDARY_SENTENCE);
    expect(result.frameworkBoundaries).toEqual({ gdpr: GDPR_READINESS_BOUNDARY_SENTENCE });
  });

  it('scopes readiness queries to the active compliance run framework', async () => {
    mocks.getScopeReadiness.mockResolvedValue({
      generatedAt: '2026-06-12T00:00:00.000Z',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      selectedFrameworks: [
        { key: 'hipaa', label: 'HIPAA' },
        { key: 'pci_dss', label: 'PCI DSS' },
      ],
      supportedFrameworks: ['hipaa', 'pci_dss'],
      latestCompletedRunId: 'run-1',
      reportRequest: null,
      scorecards: {},
      frameworks: [
        {
          key: 'hipaa',
          label: 'HIPAA',
          selected: true,
          supported: true,
          score: 20,
          statusCounts: {},
          outcomeCounts: {},
          verdictCounts: {},
          gaps: [],
          coverageLimitations: [],
          controls: [],
        },
        {
          key: 'pci_dss',
          label: 'PCI DSS',
          selected: true,
          supported: true,
          score: 40,
          statusCounts: {},
          outcomeCounts: {},
          verdictCounts: {},
          gaps: [],
          coverageLimitations: [],
          controls: [],
        },
      ],
    });
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceReadiness({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      activeFrameworkKey: 'pci_dss',
      input: {},
    });

    expect(result.frameworks.map((framework) => framework.key)).toEqual(['pci_dss']);
    expect(result.selectedFrameworks).toEqual([{ key: 'pci_dss', label: 'PCI DSS' }]);
    expect(result.supportedFrameworks).toEqual(['pci_dss']);
    await expect(service.queryComplianceReadiness({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      activeFrameworkKey: 'pci_dss',
      input: { framework: 'hipaa' },
    })).rejects.toThrow('scoped to pci_dss');
  });

  it('keeps framework-filtered readiness metadata scoped even without an active session flag', async () => {
    mocks.getScopeReadiness.mockResolvedValue({
      generatedAt: '2026-06-12T00:00:00.000Z',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      selectedFrameworks: [
        { key: 'hipaa', label: 'HIPAA' },
        { key: 'pci_dss', label: 'PCI DSS' },
      ],
      supportedFrameworks: ['hipaa', 'pci_dss'],
      latestCompletedRunId: 'run-1',
      reportRequest: null,
      scorecards: {
        agentProvenTechnical: { total: 2, passed: 1, failed: 0, needsContext: 0, notAttempted: 1, stale: 0 },
        customerEvidence: { total: 1, approved: 0, missing: 1, stale: 0, integrationRequired: 0, acceptedRisk: 0 },
        outcomes: { passed: 1, failed: 0, needs_action: 2, not_checked: 0, excluded: 0 },
      },
      frameworks: [
        {
          key: 'hipaa',
          label: 'HIPAA',
          selected: true,
          supported: true,
          score: 20,
          statusCounts: {},
          outcomeCounts: {},
          verdictCounts: {},
          gaps: [],
          coverageLimitations: [],
          controls: [
            {
              id: 'HIPAA-164.312-A',
              title: 'Access control',
              theme: 'Technical Safeguards',
              supportLevel: 'manual_evidence_required',
              status: 'missing',
              verdict: 'needs_evidence',
              outcome: 'needs_action',
              monitoring: { state: 'monitored' },
              evidence: [],
              gaps: [],
              coverageLimitations: [],
            },
          ],
        },
        {
          key: 'pci_dss',
          label: 'PCI DSS',
          selected: true,
          supported: true,
          score: 40,
          statusCounts: {},
          outcomeCounts: {},
          verdictCounts: {},
          gaps: [],
          coverageLimitations: [],
          controls: [
            {
              id: 'PCI-REQ-02',
              title: 'Secure configurations',
              theme: 'Protect Account Data',
              supportLevel: 'automated_testable',
              status: 'passing',
              verdict: 'pass',
              outcome: 'passed',
              monitoring: { state: 'monitored' },
              evidence: [],
              gaps: [],
              coverageLimitations: [],
            },
            {
              id: 'PCI-REQ-12',
              title: 'Security policy',
              theme: 'Maintain a Policy',
              supportLevel: 'integration_required',
              status: 'missing',
              verdict: 'not_attempted',
              outcome: 'needs_action',
              monitoring: { state: 'monitored' },
              evidence: [],
              gaps: [],
              coverageLimitations: [],
            },
          ],
        },
      ],
    });
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceReadiness({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      input: { framework: 'pci_dss' },
    });

    expect(result.frameworks.map((framework) => framework.key)).toEqual(['pci_dss']);
    expect(result.selectedFrameworks.map((framework) => framework.key)).toEqual(['pci_dss']);
    expect(result.supportedFrameworks).toEqual(['pci_dss']);
    expect(result.scorecards.agentProvenTechnical).toMatchObject({ total: 1, passed: 1 });
    expect(result.scorecards.customerEvidence).toMatchObject({ total: 1, missing: 1 });
    expect(JSON.stringify(result)).not.toContain('HIPAA-164.312-A');
  });

  it('filters evidence mappings and reports artifact durability', async () => {
    mocks.listEvidenceItems.mockResolvedValue([
      {
        id: 'ev-1',
        scopeId: 'scope-1',
        title: 'Policy',
        description: 'Security policy',
        sourceType: 'user_upload',
        evidenceType: 'policy',
        status: 'unreviewed',
        owner: 'security',
        reviewNote: null,
        uploadedBy: 'user-1',
        observationStartedAt: new Date('2026-06-01T00:00:00.000Z'),
        observationEndedAt: null,
        validUntil: null,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
        updatedAt: new Date('2026-06-03T00:00:00.000Z'),
        artifact: {
          fileName: 'policy.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1234,
          sha256: 'abc',
          storageRef: 's3://bucket/policy.pdf',
          sourceRef: 'upload',
        },
        metadata: { department: 'security' },
        mappings: [
          {
            frameworkKey: 'soc2',
            controlId: 'CC1.1',
            mappingSource: 'manual',
            confidence: 'high',
            rationale: 'Maps directly',
          },
          {
            frameworkKey: 'hipaa',
            controlId: '164.308',
            mappingSource: 'manual',
            confidence: 'medium',
            rationale: 'Maps indirectly',
          },
        ],
      },
    ]);
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceEvidence({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      input: {
        framework: 'soc2',
        controlId: 'CC1.1',
        status: 'unreviewed',
        sourceType: 'user_upload',
        includeMetadata: true,
      },
    });

    expect(mocks.listEvidenceItems).toHaveBeenCalledWith({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      framework: 'soc2',
      status: 'unreviewed',
      sourceType: 'user_upload',
      limit: 50,
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      id: 'ev-1',
      observationStartedAt: '2026-06-01T00:00:00.000Z',
      artifact: {
        hasFile: true,
      },
      metadata: { department: 'security' },
      mappings: [{ frameworkKey: 'soc2', controlId: 'CC1.1' }],
    });
  });

  it('rejects off-framework evidence queries in an active compliance run', async () => {
    const service = new ComplianceToolQueryService({} as never);

    await expect(service.queryComplianceEvidence({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      activeFrameworkKey: 'pci_dss',
      input: { framework: 'hipaa' },
    })).rejects.toThrow('scoped to pci_dss');

    await expect(service.queryComplianceMissingEvidence({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      activeFrameworkKey: 'pci_dss',
      input: { framework: 'soc2' },
    })).rejects.toThrow('scoped to pci_dss');
  });

  it('returns a bounded redacted text preview for text-like evidence when requested', async () => {
    tempEvidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-compliance-evidence-'));
    process.env.COMPLIANCE_EVIDENCE_STORAGE_ROOT = tempEvidenceRoot;
    const organizationId = 'org-1';
    const fileContent = Buffer.from(
      'owner,email\nsecurity,security@example.com\npassword=super-secret-value\n',
      'utf8',
    );
    const storageRef = `${organizationId}/access-review.csv`;
    await fs.mkdir(path.join(tempEvidenceRoot, organizationId), { recursive: true });
    await fs.writeFile(path.join(tempEvidenceRoot, organizationId, 'access-review.csv'), fileContent);

    mocks.listEvidenceItems.mockResolvedValue([
      {
        id: 'ev-text',
        scopeId: 'scope-1',
        title: 'Access review export',
        description: null,
        sourceType: 'user_upload',
        evidenceType: 'access_review',
        status: 'unreviewed',
        owner: null,
        reviewNote: null,
        uploadedBy: 'user-1',
        observationStartedAt: null,
        observationEndedAt: null,
        validUntil: null,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
        updatedAt: new Date('2026-06-03T00:00:00.000Z'),
        artifact: {
          fileName: 'access-review.csv',
          mimeType: 'text/csv',
          sizeBytes: fileContent.length,
          sha256: createHash('sha256').update(fileContent).digest('hex'),
          storageRef,
          sourceRef: 'uploaded:access-review.csv',
        },
        metadata: {},
        mappings: [
          {
            frameworkKey: 'soc2',
            controlId: 'CC6.1',
            mappingSource: 'manual',
            confidence: 'high',
            rationale: 'Maps directly',
          },
        ],
      },
    ]);
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceEvidence({
      organizationId,
      scopeId: 'scope-1',
      input: {
        framework: 'soc2',
        controlId: 'CC6.1',
        includeContent: true,
      },
    });

    expect(result.evidence[0]).toMatchObject({
      id: 'ev-text',
      artifact: {
        hasFile: true,
        content: {
          extractionStatus: 'extracted',
          textPreview: expect.stringContaining('security@example.com'),
          textRedacted: true,
          integrityStatus: 'resolved',
        },
      },
    });
    expect(JSON.stringify(result.evidence[0])).not.toContain('super-secret-value');
  });

  it('builds a compact proof package for one control', async () => {
    mocks.getScopeReadiness.mockResolvedValue({
      generatedAt: '2026-06-12T00:00:00.000Z',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      selectedFrameworks: [{ key: 'soc2', label: 'SOC 2' }],
      supportedFrameworks: [{ key: 'soc2', label: 'SOC 2' }],
      latestCompletedRunId: 'run-1',
      reportRequest: null,
      scorecards: {},
      frameworks: [
        {
          key: 'soc2',
          label: 'SOC 2',
          selected: true,
          supported: true,
          score: 100,
          statusCounts: {},
          outcomeCounts: {},
          verdictCounts: {},
          gaps: [],
          coverageLimitations: [],
          controls: [
            {
              id: 'CC6.1',
              title: 'Logical access',
              theme: 'Access control',
              verdict: 'pass',
              outcome: 'passed',
              basis: 'agent_tested',
              reasonCode: 'control_operating',
              verdictReason: 'The tested boundary rejected unauthenticated access.',
              proofObligation: { id: 'soc2-cc6.1-authn-v1', statement: 'Protected endpoints require authentication.' },
              coverageLimitations: ['No authenticated role-differential accounts were supplied.'],
              nextAction: 'Review before freshness expires.',
              actionRequests: [],
              controlChecks: [
                {
                  id: 'check-1',
                  basis: 'agent_tested',
                  verdict: 'pass',
                  reason: 'Protected endpoints returned 401 without credentials.',
                  proofObligationId: 'soc2-cc6.1-authn-v1',
                  method: 'HTTP replay',
                  targetRef: 'https://app.example.com/admin',
                  limitations: ['No valid user credentials were available.'],
                  freshUntil: '2026-09-10T00:00:00.000Z',
                  createdAt: '2026-06-12T00:00:00.000Z',
                  evidenceRefs: ['http:exchange-1'],
                  artifactIds: [],
                  proof: {
                    claim: 'Unauthenticated requests cannot access protected resources.',
                    evidenceIds: ['http:exchange-1'],
                    replayAttempted: true,
                    replayArtifact: 'http:exchange-1',
                    replayReproduced: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceProofPackage({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      input: { framework: 'soc2', controlId: 'cc6.1' },
    });

    expect(result.boundary).toBe(COMPLIANCE_READINESS_BOUNDARY_SENTENCE);
    expect(result.control).toMatchObject({
      id: 'CC6.1',
      verdict: 'pass',
      outcome: 'passed',
      limitations: ['No authenticated role-differential accounts were supplied.'],
    });
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: 'check-1',
        evidenceRefs: ['http:exchange-1'],
        artifacts: [],
        userEvidence: [],
      }),
    ]);
  });

  it('filters missing evidence by support level and limit', async () => {
    mocks.listMissingEvidence.mockResolvedValue([
      { frameworkKey: 'soc2', controlId: 'CC1.1', supportLevel: 'manual_evidence_required' },
      { frameworkKey: 'soc2', controlId: 'CC1.2', supportLevel: 'integration_required' },
      { frameworkKey: 'soc2', controlId: 'CC1.3', supportLevel: 'manual_evidence_required' },
    ]);
    const service = new ComplianceToolQueryService({} as never);

    const result = await service.queryComplianceMissingEvidence({
      organizationId: 'org-1',
      scopeId: null,
      input: {
        framework: 'soc2',
        supportLevel: 'manual_evidence_required',
        limit: 1,
      },
    });

    expect(mocks.listMissingEvidence).toHaveBeenCalledWith({
      organizationId: 'org-1',
      scopeId: null,
      framework: 'soc2',
    });
    expect(result).toEqual({
      missing: [{ frameworkKey: 'soc2', controlId: 'CC1.1', supportLevel: 'manual_evidence_required' }],
      totalCount: 1,
    });
  });
});
