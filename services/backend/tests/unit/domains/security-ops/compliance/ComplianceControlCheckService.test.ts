import { describe, expect, it } from 'vitest';

import { RecordControlCheckSchema } from '@/domains/security-ops/compliance/ComplianceControlCheckService';

const validInput = {
  frameworkKey: 'soc2',
  controlId: 'CC6.1',
  verdict: 'pass',
  reasonCode: 'control_operating',
  reason: 'Authentication and authorization rejected all unauthorized requests in the tested endpoint set.',
  proofObligationId: 'soc2-cc6.1-authz-v1',
  evidenceRefs: ['.artifacts/authz-proof.json'],
  targetRef: 'https://app.example.com/api/admin',
  method: 'HTTP differential test',
  proof: {
    claim: 'Unauthorized identities cannot access protected resources in the tested endpoint set.',
    evidenceIds: ['.artifacts/authz-proof.json'],
    replayAttempted: true,
    replayArtifact: '.artifacts/authz-proof.json',
    replayReproduced: true,
  },
};

describe('RecordControlCheckSchema', () => {
  it('accepts a bounded evidence-backed pass', () => {
    expect(RecordControlCheckSchema.parse(validInput)).toMatchObject({
      basis: 'agent_tested',
      verdict: 'pass',
      reasonCode: 'control_operating',
    });
  });

  it('accepts an agent-reviewed user evidence check with document-review replay reason', () => {
    expect(RecordControlCheckSchema.parse({
      ...validInput,
      controlId: 'CC1.1',
      basis: 'agent_reviewed_user_evidence',
      proofObligationId: 'evidence-review:soc2:cc1.1',
      evidenceRefs: ['compliance-evidence:11111111-1111-4111-8111-111111111111'],
      targetRef: 'uploaded evidence mapped to SOC 2 CC1.1',
      method: 'Agent review of uploaded compliance evidence',
      proof: {
        claim: 'The uploaded evidence supports the mapped control requirement for the stated scope.',
        evidenceIds: ['compliance-evidence:11111111-1111-4111-8111-111111111111'],
        replayAttempted: false,
        notReplayedReason: 'document_evidence_review',
      },
    })).toMatchObject({
      basis: 'agent_reviewed_user_evidence',
      proof: { notReplayedReason: 'document_evidence_review' },
    });
  });

  it('accepts an ISO agent-reviewed user evidence check with an evidence-review obligation', () => {
    expect(RecordControlCheckSchema.parse({
      ...validInput,
      frameworkKey: 'iso27001',
      controlId: 'ISO-A-ISMS-5',
      basis: 'agent_reviewed_user_evidence',
      proofObligationId: 'evidence-review:iso27001:iso-a-isms-5',
      evidenceRefs: ['compliance-evidence:22222222-2222-4222-8222-222222222222'],
      targetRef: 'uploaded evidence mapped to ISO-A-ISMS-5',
      method: 'Agent review of uploaded ISMS leadership and policy evidence',
      proof: {
        claim: 'The uploaded evidence supports the mapped ISO readiness control for the stated scope.',
        evidenceIds: ['compliance-evidence:22222222-2222-4222-8222-222222222222'],
        replayAttempted: false,
        notReplayedReason: 'document_evidence_review',
      },
    })).toMatchObject({
      frameworkKey: 'iso27001',
      controlId: 'ISO-A-ISMS-5',
      basis: 'agent_reviewed_user_evidence',
      proofObligationId: 'evidence-review:iso27001:iso-a-isms-5',
    });
  });

  it('rejects pass and fail without bound evidence', () => {
    for (const verdict of ['pass', 'fail'] as const) {
      const result = RecordControlCheckSchema.safeParse({
        ...validInput,
        verdict,
        reasonCode: verdict === 'pass' ? 'control_operating' : 'control_failed',
        evidenceRefs: [],
        proof: { ...validInput.proof, evidenceIds: [] },
      });
      expect(result.success).toBe(false);
    }
  });

  it('enforces verdict-specific reason codes', () => {
    expect(RecordControlCheckSchema.safeParse({ ...validInput, reasonCode: 'control_failed' }).success).toBe(false);
    expect(RecordControlCheckSchema.safeParse({ ...validInput, verdict: 'needs_context', reasonCode: 'control_operating' }).success).toBe(false);
    expect(RecordControlCheckSchema.safeParse({ ...validInput, verdict: 'not_attempted', reasonCode: 'missing_scope' }).success).toBe(false);
  });

  it('allows a needs-context result without fabricated evidence', () => {
    expect(RecordControlCheckSchema.safeParse({
      ...validInput,
      verdict: 'needs_context',
      reasonCode: 'missing_credentials',
      evidenceRefs: [],
      proof: { claim: 'Authorization could not be tested without a lower-privilege account.', evidenceIds: [], replayAttempted: false },
    }).success).toBe(true);
  });

  it('requires a replay artifact when reproduction is claimed', () => {
    expect(RecordControlCheckSchema.safeParse({
      ...validInput,
      proof: { ...validInput.proof, replayArtifact: undefined, replayReproduced: true },
    }).success).toBe(false);
  });

  it('rejects conclusive verdicts with an undisclosed or unsuccessful replay state', () => {
    expect(RecordControlCheckSchema.safeParse({
      ...validInput,
      proof: {
        ...validInput.proof,
        replayAttempted: false,
        replayArtifact: undefined,
        replayReproduced: undefined,
      },
    }).success).toBe(false);

    expect(RecordControlCheckSchema.safeParse({
      ...validInput,
      proof: {
        ...validInput.proof,
        replayAttempted: true,
        replayArtifact: undefined,
        replayReproduced: false,
      },
    }).success).toBe(false);
  });

  it('accepts bound deterministic proof when replay is explicitly not applicable', () => {
    expect(RecordControlCheckSchema.safeParse({
      ...validInput,
      method: 'Read-only configuration inspection',
      proof: {
        ...validInput.proof,
        replayAttempted: false,
        replayArtifact: undefined,
        replayReproduced: undefined,
        notReplayedReason: 'non_idempotent',
      },
    }).success).toBe(true);
  });

  it('rejects generic other as a non-replay reason for conclusive checks', () => {
    expect(RecordControlCheckSchema.safeParse({
      ...validInput,
      method: 'Read-only configuration inspection',
      proof: {
        ...validInput.proof,
        replayAttempted: false,
        replayArtifact: undefined,
        replayReproduced: undefined,
        notReplayedReason: 'other',
      },
    }).success).toBe(false);
  });

  it('rejects raw secrets in persisted proof fields', () => {
    const result = RecordControlCheckSchema.safeParse({
      ...validInput,
      proof: {
        ...validInput.proof,
        claim: 'The test used Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 to access the admin route.',
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('raw bearer token'))).toBe(true);
    }
  });
});
